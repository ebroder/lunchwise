# Lunchwise

Syncs shared expenses from Splitwise to Lunch Money. Users authenticate
via Splitwise OAuth, provide a Lunch Money API key, then configure "links"
that map a Splitwise group to a Lunch Money manual account. A background
cron syncs enabled links every 2 hours.

## Architecture

Cloudflare Workers app built with Hono. Server-rendered JSX (no client-side
JS framework). Tailwind CSS for styling.

**Database**: Turso (libsql over HTTP). Multi-tenant design with two tiers:
- Shared DB (`users` table) stores user IDs and per-user DB URLs
- Per-user DBs store credentials, sync links, transaction mappings, and sync logs
- Each new user gets a dedicated Turso database created via the Platform API

Schema is defined in Drizzle ORM (`src/lib/schema-shared.ts`,
`src/lib/schema-user.ts`) but managed externally (no auto-migration on
startup). The shared DB schema was created via `turso db shell`.

**Environment**: Workers env bindings flow through `src/lib/env.ts` (a
mutable module-level object populated by the entry point before each
request). Library code imports `env` from there rather than using
`process.env`.

## Project layout

```
src/
  index.tsx          Workers entry point (fetch + scheduled handlers)
  app.tsx            Hono app, route mounting, JSX renderer
  components/        Shared layout
  routes/            Route handlers (landing, auth, dashboard, links, api)
  lib/
    env.ts           Shared env bindings
    db.ts            Turso/Drizzle client management, LRU cache for user DBs
    auth.ts          JWT sessions (jose), requireAuth middleware
    turso.ts         Turso Platform API (creating per-user databases)
    sync.ts          Core sync logic (Splitwise -> Lunch Money)
    splitwise.ts     Splitwise API client (openapi-fetch)
    lunch-money.ts   Lunch Money API client (openapi-fetch)
    schema-shared.ts Drizzle schema for shared DB
    schema-user.ts   Drizzle schema for per-user DBs
```

## Commands

```
npm run dev          # wrangler dev + Tailwind watch
npm run build        # Tailwind CSS build (wrangler bundles TS at deploy time)
npm run deploy       # CSS build + wrangler deploy
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

## Deployment

Cloudflare Workers. Deployed via `wrangler deploy` (or push to `main` triggers
GitHub Actions). Config is in `wrangler.toml`. Secrets are set via
`wrangler secret put`.

Required secrets: `TURSO_SHARED_DB_URL`, `TURSO_AUTH_TOKEN`,
`TURSO_PLATFORM_API_TOKEN`, `TURSO_ORG`, `TURSO_GROUP`, `SESSION_SECRET`,
`SPLITWISE_CLIENT_ID`, `SPLITWISE_CLIENT_SECRET`, `APP_URL`, `NODE_ENV`.

Static assets (just `public/styles.css`) are served via Workers asset
binding at `/styles.css`.

## Notes

- OAuth token exchange with Splitwise is done manually (not via arctic)
  because Splitwise rejects client credentials sent as HTTP Basic auth,
  which is how arctic sends them.
- The `initSharedDb()` function was removed. Shared DB schema changes need
  to be applied manually via `turso db shell`.
- Per-user DB schema is still created on-demand (`initUserDb()` runs when
  a new user signs up).
