# UK Visa Sponsor Search

Monorepo for [sponsorsearch.co.uk](https://sponsorsearch.co.uk) — search UK skilled worker visa sponsors and view detailed company profiles.

## Structure

```
apps/
  web/        → TanStack Start web app (deployed to Vercel)
```

## Getting started

```bash
bun install       # Install all workspace dependencies
bun run dev       # Start all apps in dev mode
bun run build     # Build all apps
bun run lint      # Lint all apps
```

To target a specific app:

```bash
bun run build --filter=@ss/web
```

## Tech stack

- **Monorepo:** Turborepo with bun workspaces
- **Web app:** TanStack Start (React 19), Tailwind CSS v4, Drizzle ORM, Neon Postgres
- **Deployment:** Vercel (web)
- **CI:** GitHub Actions (automated HMRC data sync)

See [apps/web/README.md](apps/web/README.md) for web app details.
