# Lunchwise

Syncs shared expenses from Splitwise to Lunch Money. Users authenticate
via Splitwise OAuth, provide a Lunch Money API key, then configure "links"
that map a Splitwise group to a Lunch Money manual account. A background
cron syncs enabled links every 2 hours.

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
and cron (deduplicated per isolate via a module-level Set).

**Environment**: Workers env bindings flow through `src/lib/env.ts` (a
mutable module-level object populated by the entry point before each
request). Library code imports `env` from there rather than using
`process.env`.

## Project layout

```
src/
  index.tsx          Workers entry point (fetch + scheduled handlers)
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
    logger.ts        Structured JSON logger (no deps, LOG_LEVEL via env)
    turso.ts         Turso Platform API (creating per-user databases)
    sync.ts          Core sync logic (Splitwise -> Lunch Money, balance sync)
    exchange-rates.ts Cached exchange rates (open.er-api.com, shared DB)
    splitwise.ts     Splitwise API client (openapi-fetch)
    lunch-money.ts   Lunch Money API client (openapi-fetch)
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

Required secrets: `TURSO_SHARED_DB_URL`, `TURSO_AUTH_TOKEN`,
`TURSO_PLATFORM_API_TOKEN`, `TURSO_ORG`, `TURSO_GROUP`, `SESSION_SECRET`,
`SPLITWISE_CLIENT_ID`, `SPLITWISE_CLIENT_SECRET`, `APP_URL`, `NODE_ENV`.

Static assets (Vite output + Tailwind CSS in `dist/client/`) are served via
Workers asset binding.

## Debugging

Structured JSON logging via `src/lib/logger.ts`. All sync operations,
API errors, and the cron handler emit structured logs with context fields
(userId, linkId, etc.).

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
- `initUserDb()` runs on auth and cron (not just signup) so existing users
  pick up new migrations. Deduplicated per isolate with a `Set<string>`.
