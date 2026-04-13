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
```

### Local development

Dev servers use [portless](https://portless.sh) for clean `.localhost` URLs with HTTPS. One-time setup:

```bash
sudo bunx portless proxy start --https
```

Then start developing:

```bash
bun run dev       # Start all apps (web → https://web.localhost)
```

To test on other devices (phone/tablet) on the same WiFi:

```bash
sudo bunx portless proxy start --lan --https    # Restart proxy in LAN mode
bun run dev                                      # Access via https://web.local on any device
```

To skip portless and use `localhost:3000` directly:

```bash
bun run --filter @ss/web dev:no-proxy
```

### Other commands

```bash
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
