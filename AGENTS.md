# Lunchwise

Working mode: delegated. Evan reviews the product, not the diff, so your tests and your own verification are the only safety net.

Syncs shared expenses from Splitwise to Lunch Money. Users authenticate
via Splitwise OAuth, provide a Lunch Money API key, then configure "links"
that map a Splitwise group to a Lunch Money manual account. Every 2 hours a
cron queues one sync per user, and a queue consumer syncs that user's enabled
links.

## Architecture

Cloudflare Workers app built with Hono. The landing page and auth flow are
server-rendered JSX. The authenticated dashboard is a client-side SPA built
with Preact + wouter, bundled by Vite. Tailwind CSS for styling.

**Database**: Turso (libsql over HTTP). Multi-tenant design with two tiers:
- Shared DB (`users` table, `exchange_rate_cache` table) stores user IDs,
  per-user DB URLs, and cached exchange rates
- Per-user DBs store credentials, sync links, transaction mappings, and sync logs
- Each new user gets a dedicated Turso database created via the Platform API

Schema is defined in Drizzle ORM (`src/lib/schema-shared.ts`,
`src/lib/schema-user.ts`). Shared DB schema changes are applied manually
via `turso db shell`. Per-user DB migrations are versioned in `initUserDb()`
(in `db.ts`) using a `schema_version` table, and run automatically on auth
and on each user's background sync.

**Environment**: Workers env bindings flow through `src/lib/env.ts` (a
mutable module-level object populated by the entry point before each
request). Library code imports `env` from there rather than using
`process.env`. Only string vars and secrets land there; `src/index.tsx`
passes object bindings such as the `SYNC_QUEUE` producer explicitly.

**Background sync**: The `0 */2 * * *` cron (`scheduled` in `src/index.tsx`)
only queues work. `enqueueUserSyncs` (`src/lib/sync-queue.ts`) sends one
`lunchwise-sync` message per user with a database, carrying the exchange rates
it loaded once so consumers don't spend requests on them (or `null`, which
skips balance sync). The `queue` handler gets one message per invocation
(`max_batch_size = 1`) and runs `syncUser` inside `withRequestBudget`, so each
user's sync runs in its own invocation with its own count. Each consumer
invocation does get its own 50-subrequest allowance, which Cloudflare's docs
don't say outright. The first production queue run (2026-10-23) had 8
invocations, one per user, using 5 to 18 requests each (93 in total, none
refused).

- A user whose setup throws (a transient Turso error, say) is retried after
  `retry_delay` (5 minutes), up to `max_retries`.
- A failed link doesn't trigger a retry, since `syncLink` already recorded it
  in `sync_log`.
- A run that hits the request budget reports a Sentry error naming the user
  and request count, then acks, because a retry would stop at the same point.
  Code in a user sync that catches errors (to carry on, or to log them
  first) checks `requestBudgetExceeded()` and rethrows straight away, so the
  run stops at the first refusal and the consumer's report is its only Sentry
  error. The link's `sync_log` row stays `running` until the next run marks
  it interrupted.
- Every run logs its request count ("User sync finished"), and one above 35
  also sends a Sentry warning with the `request-budget-warning` fingerprint,
  so they all group into one issue.
- A user sync costs about 6 requests for a user with a Lunch Money key, and
  about 10 per enabled link. Balance sync adds 1 (the Lunch Money user), 1 per
  link with it on (that link's Splitwise group, or all groups in one request)
  and 1 per Lunch Money account it updates, so 3 for one link and 7 for three
  on separate accounts. That puts a user with 3 enabled links past the
  35-request warning, and one with 4 at the 45-request guard. That run stops
  at the same link every time, so later links and balance sync never run, and
  the consumer's Sentry error is how we'd find out. The fix is one queue
  message per link rather than per user. We're waiting to build it until
  Sentry shows it happening.
- Those numbers are for a link with little new to fetch. A link's first sync
  fetches every expense updated since its start date, which adds about 4
  requests per 1,000 expenses (one Splitwise page, two Lunch Money inserts
  and one Turso batch). One run fetches at most `EXPENSE_PAGES_PER_RUN` (4)
  pages of 1,000 and leaves the rest to later runs (see below), so a capped
  run's link costs about 22 requests. `src/index.test.ts` counts 31 for a
  user with only that link and 41 for one with an ordinary link besides,
  against the 35-request warning and the 45-request guard, so raising the
  cap means redoing that arithmetic. Two ordinary links beside a catch-up
  come to about 51 with balance sync on, so each catch-up run usually stops
  in balance sync. Balances wait until the catch-up finishes, and each run
  sends the budget error to Sentry. One queue message per link would fix
  that too. Keep the Splitwise page size and
  `DB_BATCH` at 1,000 too. At 100 each, a first sync of 3,800 expenses
  (LUNCHWISE-A) needed nearly 100 requests.
- A message still failing after `max_retries` retries moves to
  `lunchwise-sync-dlq`, whose consumer reports "User N's sync failed
  repeatedly" to Sentry (user ID only) and acks. That's the only report for a
  run Cloudflare kills outright, for example over the CPU limit, since such a
  run can't send anything itself. (Cloudflare's docs don't say a killed
  invocation counts as a failed delivery, so this is unconfirmed until we see
  it happen.) In the first production run, consumer invocations used 16 to
  146 ms of CPU and the cron 34 ms, all well over the Free plan's documented
  10 ms, and none was killed.

A sync with more to fetch than one run allows catches up over several runs.
Splitwise lists expenses by `date`, newest first (`updated_at`, `created_at`
and `id` come in no useful order), so the bookmark is a page offset into one
listing. A run whose last page comes back full records `catch_up_offset` and
`catch_up_started_at` on the link and leaves `lastSyncedAt` alone, so the next
run asks for the same `updated_after` and starts just before the offset. New
expenses push older ones down the listing, and the planner skips the few a run
reads twice. An expense whose date is edited during the catch-up can jump
behind the bookmark, but its `updated_at` is then later than the catch-up's
start, which is why the run that reaches the end sets `lastSyncedAt` to that
start and not its own.

That jump also moves the expense at the bookmark up one place, and so does a
fetched expense leaving the listing (moved to another group, say). The catch-up
hasn't read that expense yet, and no later sync fetches it, since its
`updated_at` predates the catch-up. So each run starts `CATCH_UP_OVERLAP` (100)
expenses before the stored offset. More than 100 fetched expenses moving behind
the bookmark or leaving the listing between two runs could still skip one. The
overlap applies only to reading. The stored offset is where the run's last page
ended, so each resumed run moves it 3,900 further.

- A capped run is a success in `sync_log`. A run that fails leaves the
  bookmark where it was, so the next run redoes that part.
- A first sync's backfill (adopting Lunch Money transactions whose
  `external_id` is a Splitwise expense ID) runs only in the catch-up's first
  run, since by the second the account holds thousands of transactions the
  sync created. It stores each adopted transaction's amount in
  `synced_transactions.backfill_amount`, and later runs of that first sync
  compare against it. The cap doesn't cover the backfill itself, which costs
  about 2 requests per 1,000 transactions already in the account. A link
  re-created on an account holding several thousand Lunchwise transactions
  would pass the guard in that first run on every attempt. We're waiting to
  fix it (backfilling only each run's share, say) until Sentry shows it
  happening.
- An edit that widens a link with a `lastSyncedAt` (another group, to or from
  all groups, an earlier or no start date, or payments turned on) starts a
  catch-up at offset 0, with `lastSyncedAt` null and `catch_up_started_at` the
  edit time. A sync only fetches what was updated since `lastSyncedAt`, so the
  older expenses the edit takes in would otherwise never arrive. Clearing
  `lastSyncedAt` alone would make the next run a first sync, and its uncapped
  backfill passes the guard on every attempt once the account holds several
  thousand transactions. The planner skips what's already synced. A row
  backfilled before `backfill_amount` existed has no amount to compare, so the
  catch-up updates its transaction only if the expense changed after the
  backfill. Other edits leave the sync alone, and transactions from a group
  the link no longer covers stay in Lunch Money. So do a synced link's
  transactions when its Lunch Money account changes: they stay in the old
  account, and the new one only gets what syncs afterwards. We'll decide what
  that should do once a user runs into it. A run writes its cursor only if
  the link's `updated_at` hasn't changed since the run read it, so an edit
  saved mid-run keeps its reset.
- Otherwise, changing the group or start date, or turning payments on,
  restarts a catch-up in progress at offset 0. Ending the catch-up instead
  would make an unfinished first sync backfill again.
- `GET /api/links` gives each link `catchingUp` and `lastSuccessAt` (the
  start of its latest successful run), and the dashboard's "Last synced" uses
  the latter, because `lastSyncedAt` stays null through a first sync's
  catch-up. "Sync now" and the dry run each cover one run's share and return
  `more_to_sync`.

"Sync now" (`POST /api/sync/:linkId`) and the dry run
(`GET /api/links/:id/dry-run`) stay synchronous, because they return their
results to the page and a queue run would have the same 50-request ceiling.
Both run inside `withRequestBudget` too, applied in `api.tsx` ahead of the
auth middleware so authentication's queries count. One that runs out sends a
single Sentry error naming the user, link and request count, and the page
says the sync was too large to finish in one go.

**Sync failures**: A 401 from Lunch Money or Splitwise (during a link sync,
balance sync, "Sync now" or a dry run) goes to Sentry as a warning
fingerprinted `["sync-credential-rejected", <reason>]`, through
`logSyncFailure` in `src/lib/sync-failure.ts`. Only the user can replace a
dead credential, so one of these isn't something we can act on, but a burst of
them in that issue probably means a bug on our side. Every other sync failure
is an error.

`classifySyncError` (`src/lib/errors.ts`) sorts a failure into a reason from
its `describeError` text, which is also what `sync_log.error_message` stores,
so `getSyncFailures` can explain past failures without a reason column. It
depends on the format `apiError` gives every Lunch Money and Splitwise error,
and the client tests pin that. `GET /api/links` gives each link its latest
finished sync's failure (`lastFailure`, or `null`), and `GET /api/me` says
whether Lunch Money has rejected the key. A credential rejection stops
counting once any link syncs successfully after it, or once that credential
is replaced, going by `credentials.lunch_money_key_updated_at` or
`splitwise_token_updated_at`. (`credentials.updated_at` won't do, because
every login bumps it.)

The dashboard shows each link's failure under its "Last synced" line. When
Lunch Money has rejected the key, the Connections card says "Key rejected"
and the API key form appears, so the user can replace the key without
removing their links. After "Sync now", the page reloads both endpoints to
show the outcome.

## Project layout

```
src/
  index.tsx          Workers entry point (fetch, scheduled and queue handlers)
  app.tsx            Hono app, route mounting, JSX renderer
  components/        Shared layout (server-rendered pages)
  routes/
    landing.tsx      Marketing landing page (SSR)
    auth.tsx         Splitwise OAuth flow (SSR)
    dashboard.tsx    SPA shell (serves HTML + app.js for /dashboard/*)
    api.tsx          JSON API (all endpoints return JSON)
  lib/
    env.ts           Shared env bindings
    db.ts            Turso/Drizzle client management, LRU cache for user DBs
    auth.ts          JWT sessions (jose), requireAuth + requireAuthJson
    logger.ts        Structured JSON logger (@sentry/cloudflare, LOG_LEVEL via env)
    turso.ts         Turso Platform API (creating per-user databases)
    sync.ts          Core sync logic (Splitwise -> Lunch Money, balance sync)
    sync-queue.ts    Cron fan-out to the sync queue, and its consumer
    sync-failure.ts  Sync failure reasons for the dashboard and Sentry
    errors.ts        Error text (describeError, apiError) and classifySyncError
    exchange-rates.ts Cached exchange rates (open.er-api.com, shared DB)
    splitwise.ts     Splitwise API client (openapi-fetch)
    lunch-money.ts   Lunch Money API client (openapi-fetch)
    request-budget.ts Per-invocation subrequest count and guard (countedFetch)
    schema-shared.ts Drizzle schema for shared DB
    schema-user.ts   Drizzle schema for per-user DBs
  client/            Client-side SPA (Preact + wouter, built by Vite)
    main.tsx         Entry point
    app.tsx          Router + layout shell
    lib/api.ts       Fetch wrapper (JSON, 401 handling)
    pages/           Page components (dashboard, link-new, link-edit, link-history)
  generated/         Auto-generated (gitignored)
    spa-html.ts      SPA HTML with hashed asset references
index.html           Vite SPA entry point (project root)
vite.config.ts       Vite config with @preact/preset-vite
scripts/
  generate-spa-html.ts  Reads Vite output, generates src/generated/spa-html.ts
```

**Build setup**: Server code is bundled by wrangler. Client code is bundled
by Vite (with `@preact/preset-vite`) into `dist/client/` with content-hashed
filenames. A post-build script reads the Vite-generated `index.html` and
writes it as a string constant in `src/generated/spa-html.ts`, which the
dashboard route imports and serves after auth. Separate tsconfigs: root uses
`jsxImportSource: "hono/jsx"` for server code, `tsconfig.client.json` uses
`jsxImportSource: "preact"`.

## Commands

```
npm run dev          # wrangler dev + vite dev (with proxy)
npm run build        # vite build + Tailwind CSS + generate SPA HTML module
npm run deploy       # build + wrangler deploy
npm run lint         # oxlint (errors + warnings)
npm run format       # biome format --write (auto-fix)
npm run format:check # biome format (check only, used in CI)
npm run typecheck    # tsc --noEmit (server + client)
npm test             # vitest run
```

## Linting and formatting

**Linting** uses [oxlint](https://oxc.rs/docs/guide/usage/linter) via
`.oxlintrc.json`. Correctness and suspicious rules are errors; pedantic and
style are warnings. Many opinionated style rules are disabled to match the
project's existing conventions.

**Formatting** uses [Biome](https://biomejs.dev/) (formatter only, linter
disabled) via `biome.json`. 2-space indent, 100-char line width, double
quotes, always semicolons, trailing commas everywhere.

To fix formatting errors, run `biome format --write .` (not by hand). Both
tools run in CI before typecheck.

## Deployment

Cloudflare Workers. Deployed via `wrangler deploy` (or push to `main` triggers
GitHub Actions). Config is in `wrangler.toml`. Secrets are set via
`wrangler secret put`.

The sync queue and its dead-letter queue have to exist before the first
deploy that binds them (one-time setup):

```
npx wrangler queues create lunchwise-sync
npx wrangler queues create lunchwise-sync-dlq
```

Required secrets: `TURSO_SHARED_DB_URL`, `TURSO_AUTH_TOKEN`,
`TURSO_PLATFORM_API_TOKEN`, `TURSO_ORG`, `TURSO_GROUP`, `SESSION_SECRET`,
`SPLITWISE_CLIENT_ID`, `SPLITWISE_CLIENT_SECRET`, `ENCRYPTION_KEYS`,
`APP_URL`, `NODE_ENV`.

Static assets (Vite output + Tailwind CSS in `dist/client/`) are served via
Workers asset binding.

## Debugging

Structured JSON logging via `src/lib/logger.ts`. All sync operations,
API errors, and the cron handler emit structured logs with context fields
(userId, linkId, etc.).

An error that no route catches is logged (and so sent to Sentry) by
`app.onError` in `src/app.tsx`, which then returns a plain-text 500. A
sub-app's own `onError`, like the one in `api.tsx`, has to rethrow anything it
doesn't handle, or that handler never sees it.

- **Live logs in production**: `wrangler tail --format json`
- **Verbose per-expense tracing**: Set `LOG_LEVEL=debug` in wrangler.toml
  `[vars]` (or via `wrangler secret put`). This logs every skip reason,
  create/update/delete decision, and backfill match in the sync planner.
  Default level is `info`.
- **Dry-run endpoint**: `GET /api/links/:id/dry-run` returns planned
  actions without side effects. Useful for testing sync behavior.
- **Sync history**: Per-link sync results (counts, errors) are stored in
  the `sync_log` table and viewable in the dashboard UI.

## Notes

- OAuth token exchange with Splitwise is done manually (not via arctic)
  because Splitwise rejects client credentials sent as HTTP Basic auth,
  which is how arctic sends them.
- Turso's HTTP API does not support `PRAGMA` writes. Use tables for any
  persistent metadata (e.g. `schema_version` for migration tracking).
- Drizzle's `.get()` throws `TypeError` on Turso's HTTP backend when a
  raw SQL query returns no rows. Use `.all()` and take `[0]` instead.
- The `initSharedDb()` function was removed. Shared DB schema changes need
  to be applied manually via `turso db shell`.
- `initUserDb()` runs on auth and on every background sync (not just signup)
  so existing users pick up new migrations. Auth deduplicates it per isolate
  with a `Set<string>`.
- Lunchwise runs on the Workers Free plan, and we intend to stay on it, so
  changes have to fit its limits. It allows **50 outgoing subrequests** per
  invocation (every `fetch`, including each Turso query, each Splitwise and
  Lunch Money call, and each Sentry send) plus 1,000 to Cloudflare services
  such as Queues. A request past the limit throws "Too
  many subrequests", and since Sentry sends count too, nothing after that
  point reaches Sentry. Each `db.$client.batch()` call counts as one
  subrequest to Turso regardless of how many SQL statements it contains.
  This is why `executeActions` in `sync.ts` batches all DB writes into a
  single batch at the end rather than writing incrementally after each phase
  (creates, updates, deletes). If a later phase fails, earlier phases' LM
  changes are orphaned, but the next sync self-heals via duplicate
  `external_id` handling.
- `src/lib/request-budget.ts` holds the 50 / 45 / 35 numbers. Inside
  `withRequestBudget`, `countedFetch` counts the invocation's requests and
  refuses any past 45 with `RequestBudgetExceededError`, leaving the rest for
  Sentry. The count lives in `AsyncLocalStorage` because concurrent
  invocations can share an isolate. Pass `countedFetch` as the `fetch` option
  of any new HTTP client the sync uses: libsql and openapi-fetch capture
  `fetch` when the client is created, so a request that skips it goes
  uncounted. Sentry needs no wiring, because its Cloudflare transport holds
  every envelope until the flush that runs after the handler returns (for a
  fetch handler, after the response body has been sent).
- Turso documents no limit on statements per `batch()` call. A test on
  2026-10-23 sent batches of 5,000 statements (about 940 KB) and a single
  5,000-row insert with 20,000 parameters, and all of them succeeded.
- Splitwise's `get_expenses` accepts `limit=1000`, although its docs only
  give the default of 20 (`limit=0` returned 2,000 in a test on 2026-10-23).
  It returns expenses newest `date` first, not in `updated_at` order, so a
  fetch that stops partway can't use the last `updated_at` it saw as a
  bookmark.
- Lunch Money's insert and update APIs accept a maximum of 500 transactions
  per request. The client functions in `lunch-money.ts` chunk automatically.
- Lunch Money's bulk update rejects the whole batch with a 404 if any
  transaction ID no longer exists (typically because the user deleted it in
  LM), naming the missing IDs in the error body. `updateTransactions` drops
  those IDs, retries the rest, and returns them; `executeActions` marks the
  corresponding `synced_transactions` rows deleted rather than recreating the
  transaction.
- Sentry's `dataCollection` defaults (since SDK v11) attach request bodies and
  client IPs to events and spans, which would send users' Lunch Money API keys
  to Sentry. `src/index.tsx` sets every category explicitly, and
  `src/index.test.ts` checks the envelopes Sentry actually sends. If a Sentry
  upgrade breaks that test, fix the config rather than the test.
- Send cron check-ins with `Sentry.captureCheckIn` from the `scheduled`
  handler's own scope, not `Sentry.withMonitor`, and leave the cron's work
  (queueing the user syncs) in `ctx.waitUntil`. `withMonitor` runs its
  callback in a forked isolation scope without the SDK's per-invocation state,
  so (seen in `@sentry/cloudflare` 11.4 through 11.8) the closing check-in is
  sent outside `waitUntil`, the runtime cancels it, and the monitor reports
  every run as a timeout. Awaiting the work instead holds the `in_progress`
  check-in until the invocation ends. `src/index.test.ts` covers both. The
  monitor only covers queueing; user syncs report through Sentry errors.
