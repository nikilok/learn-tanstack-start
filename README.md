# UK Visa Sponsor Search

Search UK skilled worker visa sponsors and view detailed company profiles. Built with TanStack Start and [more](#tech-stack).

**Live:** [sponsorsearch.co.uk](https://sponsorsearch.co.uk)

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
- **Data fetching:** TanStack Query
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

## Getting started

```bash
bun install
bun run dev
```

## Database commands

```bash
bun run db:generate          # Generate migration from schema changes
bun run db:create-migration  # Create a custom data migration
bun run db:migrate           # Apply pending migrations
bun run db:reset             # Drop all tables and re-migrate
bun run db:studio            # Open Drizzle Studio
bun run db:ingest            # Ingest HMRC CSV data
bun run db:seed-sic          # Seed SIC code descriptions
```
