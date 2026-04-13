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
- **Database:** Neon Postgres (serverless) via Drizzle ORM
- **APIs:** Companies House API (server-side via `createServerFn`)
- **Styling:** Tailwind CSS v4
- **Testing:** Vitest + Playwright
- **Linting:** Biome
- **Deployment:** Vercel via Nitro
- **Runtime:** Bun

## Automated data sync

A GitHub Actions workflow runs every Monday at 8:00 AM UTC to keep the sponsor data up to date.

1. **Discover CSV URL** — An agentic script uses Claude (Anthropic SDK) + Playwright to navigate gov.uk headlessly and find the latest HMRC licensed sponsors CSV download link
2. **Ingest** — Downloads the CSV, validates its checksum against the last ingestion to skip unchanged data, then performs a zero-downtime atomic table swap (staging table → bulk insert → index → swap)

Ingestion metadata (URL, checksum, record count) is tracked in the database so duplicate runs are no-ops.

## Scripts

All scripts can be run from the repo root using `bun run --filter @ss/web <script>`.

### Development

```bash
bun run --filter @ss/web dev                  # Start dev server on port 3000
bun run --filter @ss/web dev:host             # Start dev server exposed to network
bun run --filter @ss/web build                # Production build
bun run --filter @ss/web preview              # Preview production build
bun run --filter @ss/web test                 # Run tests (Vitest)
bun run --filter @ss/web lint                 # Lint with Biome
bun run --filter @ss/web lint:fix             # Auto-fix lint issues
```

### Database

```bash
bun run --filter @ss/web db:generate          # Generate migration from schema changes
bun run --filter @ss/web db:create-migration  # Create a custom data migration
bun run --filter @ss/web db:migrate           # Apply pending migrations
bun run --filter @ss/web db:reset             # Drop all tables and re-migrate
bun run --filter @ss/web db:push              # Push schema directly (no migration)
bun run --filter @ss/web db:studio            # Open Drizzle Studio
bun run --filter @ss/web db:ingest            # Ingest HMRC CSV data
bun run --filter @ss/web db:seed-sic          # Seed SIC code descriptions
```

### Data & utilities

```bash
bun run --filter @ss/web hmrc:find-csv        # Find latest HMRC sponsors CSV URL via agentic script
bun run --filter @ss/web company:lookup       # Look up a company via Companies House API
bun run --filter @ss/web sitemap:generate     # Generate sitemap.xml
bun run --filter @ss/web sic:fetch            # Fetch SIC codes from Companies House
bun run --filter @ss/web render:og            # Render OG images for all platforms (Facebook, Twitter, Instagram)
```
