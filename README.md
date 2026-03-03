# Lunchwise

[![Deploy](https://github.com/ebroder/lunchwise/actions/workflows/deploy.yml/badge.svg)](https://github.com/ebroder/lunchwise/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](package.json)
[![Formatted with Biome](https://img.shields.io/badge/formatted_with-biome-60a5fa?logo=biome)](https://biomejs.dev/)
[![Linted with oxlint](https://img.shields.io/badge/linted_with-oxlint-9766f5?logo=oxc)](https://oxc.rs/)

Syncs shared expenses from [Splitwise](https://www.splitwise.com/) to
[Lunch Money](https://lunchmoney.app/). Authenticate via Splitwise OAuth,
provide a Lunch Money API key, then configure "links" that map a Splitwise
group to a Lunch Money manual account. A background cron syncs enabled links
every 2 hours.

## Architecture

Cloudflare Workers app built with [Hono](https://hono.dev/). The landing
page and auth flow are server-rendered JSX. The authenticated dashboard is a
client-side SPA built with [Preact](https://preactjs.com/) +
[wouter](https://github.com/molefrog/wouter), bundled by Vite.
[Tailwind CSS](https://tailwindcss.com/) for styling.

**Database**: [Turso](https://turso.tech/) (libsql over HTTP). Multi-tenant
design with two tiers:

- **Shared DB** stores user IDs, per-user DB URLs, and cached exchange rates
- **Per-user DBs** store credentials, sync links, transaction mappings, and
  sync logs
- Each new user gets a dedicated Turso database created via the Platform API

Schema is defined with [Drizzle ORM](https://orm.drizzle.team/). Per-user DB
migrations run automatically on auth and cron.

## Local development

```
cp .dev.vars.example .dev.vars   # fill in secrets
npm install
npm run dev                      # wrangler dev + vite dev (with proxy)
```

The dev server runs at `http://localhost:3000` (Vite) with API requests
proxied to `http://localhost:8787` (wrangler).

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev servers (wrangler + vite) |
| `npm run build` | Vite build + Tailwind CSS + generate SPA HTML module |
| `npm run deploy` | Build + `wrangler deploy` |
| `npm run lint` | Lint with oxlint |
| `npm run format` | Format with Biome (auto-fix) |
| `npm run format:check` | Check formatting (CI) |
| `npm run typecheck` | TypeScript type checking (server + client) |
| `npm test` | Run tests with vitest |
| `npm run test:coverage` | Run tests with v8 coverage report |

## Deployment

Cloudflare Workers. Push to `main` triggers the
[Deploy workflow](.github/workflows/deploy.yml), which runs lint, format
check, build, typecheck, and tests before deploying via `wrangler deploy`.

Secrets are set via `wrangler secret put`. See
[`.dev.vars.example`](.dev.vars.example) for the full list.

## License

[MIT](LICENSE)
