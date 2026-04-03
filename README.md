# Learning TanStack Start

A hands-on playground for exploring TanStack Start — SSR, server functions, database integration, and deployment. Built from scratch, one concept at a time.

**Live:** [learn-tanstack-start-ashy.vercel.app](https://learn-tanstack-start-ashy.vercel.app)

## What's in here

### URL-based state (`/counter/$count`)
Counter value lives in the URL instead of `useState`. Clicking +/- navigates to a new route. Uses the `_` suffix file naming convention (`counter_.$count.tsx`) to opt out of layout nesting under the `/counter` route.

### Server vs client execution (`beforeLoad`)
The `/counter` route uses `beforeLoad` to redirect to `/counter/{hour}`. Discovered that:
- **Full page load** — `beforeLoad` runs server-side (UTC on Vercel)
- **SPA navigation** — `beforeLoad` runs client-side (user's local timezone)
- **Prefetching** — `beforeLoad` runs on hover, before the user even clicks

### Server functions + Database (`/data`)
Posts fetched from a Neon Postgres database via Drizzle ORM inside `createServerFn`. The server function runs server-only — database credentials never reach the client.

### Drizzle migrations
Schema and data changes tracked via migration files:
- `db:generate` — auto-generates schema migrations from `schema.ts` changes
- `db:create-migration` — custom script to create data migration files with journal entries
- `db:migrate` — applies unapplied migrations in order
- `db:reset` — wipes and rebuilds from scratch

### Vercel deployment
Deployed via the Nitro plugin. Serverless functions run in UTC regardless of data center location. Vercel function logs show request details including user agent, region routing (edge → function), and execution time.

## Tech stack

- **Framework:** TanStack Start (React 19 + TanStack Router)
- **Database:** Neon Postgres (serverless)
- **ORM:** Drizzle ORM with `@neondatabase/serverless` driver
- **Styling:** Tailwind CSS v4 + Vercel-inspired design system (Geist font, shadow-as-border)
- **Deployment:** Vercel via Nitro
- **Runtime:** Bun
- **Linting:** Biome

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
```

## Key learnings

| Topic | Finding |
|-------|---------|
| File routing | `.` = nesting, `_` suffix = opt out of nesting, `$` = dynamic param |
| `beforeLoad` | Runs on both server (SSR) and client (SPA nav) — not server-only |
| `createServerFn` | Guaranteed server-only execution, auto-RPC from client |
| Serverless time | `new Date()` returns UTC on Vercel — no "server local time" exists |
| Nitro | The deployment layer that turns your app into a deployable server application |
| Drizzle migrations | Schema migrations are auto-generated; data migrations are manual SQL files registered in the journal |
