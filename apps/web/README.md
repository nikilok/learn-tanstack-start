# @ss/web

The TanStack Start web app for [sponsorsearch.co.uk](https://sponsorsearch.co.uk).

## Features

- **Full-text search** of HMRC skilled worker sponsor register with relevance scoring
- **Company detail pages** with Companies House profile data (status, SIC codes, registered address, accounts)
- **Infinite scroll** with virtual rendering for fast performance on large result sets
- **Google Maps link** for registered office addresses
- **Dark mode** toggle
- **Keyboard shortcut** (CMD/CTRL+K) to focus search, or just start typing anywhere on desktop
- **URL-based search state** so results are shareable and back-navigation preserves context

## Tech stack

- **Framework:** TanStack Start (React 19 + TanStack Router)
- **Data fetching & client-side caching:** TanStack Query
- **Virtualisation:** TanStack Virtual
- **Database:** [`@ss/db`](../../packages/db/README.md) (shared Neon Postgres schema + client)
- **APIs:** Companies House API (server-side via `createServerFn`)
- **Styling:** Tailwind CSS v4
- **Testing:** Vitest + Playwright
- **Linting:** Biome
- **Deployment:** Vercel via Nitro
- **Runtime:** Bun

## Server routes (Nitro)

TanStack Start's `createServerFn` only supports RPC-style endpoints called from components/loaders — not standalone REST APIs. For external-facing HTTP endpoints (webhooks, service-to-service calls), we use **Nitro server routes** via the `server/` directory.

- `server/api/` — file-based API routes, mapped by filename (e.g. `revalidate.post.ts` → `POST /api/revalidate`)
- HTTP method is set by the file suffix: `.post.ts`, `.get.ts`, `.put.ts`, `.delete.ts`
- Requires `serverDir: 'server'` in the Nitro plugin config in `vite.config.ts`
- These routes only run in production (Nitro build) — they are **not available** during `bun run dev`. Use `bun run build && bun run preview` to test locally.

## Automated data sync

A GitHub Actions workflow runs every Monday at 8:00 AM UTC to keep the sponsor data up to date.

1. **Discover CSV URL** — An agentic script uses Claude (Anthropic SDK) + Playwright to navigate gov.uk headlessly and find the latest HMRC licensed sponsors CSV download link
2. **Ingest** — Downloads the CSV, validates its checksum against the last ingestion to skip unchanged data, then performs a zero-downtime atomic table swap (staging table -> bulk insert -> index -> swap)

Ingestion metadata (URL, checksum, record count) is tracked in the database so duplicate runs are no-ops.

## Scripts

All scripts have root shortcuts via turbo (e.g. `bun run db:migrate` from the repo root).

### Development

```bash
bun run dev                  # Start dev server (https://web.localhost)
bun run build                # Production build
bun run test                 # Run tests (Vitest)
bun run lint                 # Lint with Biome
bun run lint:fix             # Auto-fix lint issues
```

### Database

```bash
bun run db:migrate           # Apply pending migrations
bun run db:generate          # Generate migration from schema changes
bun run db:create-migration  # Create a custom data migration
bun run db:push              # Push schema directly (no migration)
bun run db:studio            # Open Drizzle Studio
```

### Data & utilities

```bash
bun run db:ingest            # Ingest HMRC CSV data
bun run db:seed-sic          # Seed SIC code descriptions
bun run hmrc:find-csv        # Find latest HMRC sponsors CSV URL via agentic script
bun run company:lookup       # Look up a company via Companies House API
bun run seed:companies-house # Seed Companies House profiles for all sponsors
bun run sitemap:generate     # Generate sitemap.xml
bun run sic:fetch            # Fetch SIC codes from Companies House
bun run render:og            # Render OG images for all platforms (Facebook, Twitter, Instagram)
```

## Environment variables

See [`.env.example`](.env.example) for app-specific variables and [`../../.env.example`](../../.env.example) for shared database variables.
