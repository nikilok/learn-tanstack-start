# @ss/db

Shared database schema, client factory, and migration runner for the sponsorsearch monorepo.

This is a pure library package with no opinions about environment variables, config, or deployment. Consumers provide the database connection URL.

## Importing

```ts
// Create a client
import { createClient } from '@ss/db';
const db = createClient(process.env.POSTGRES_URL);

// Run migrations
import { runMigrations } from '@ss/db';
await runMigrations(process.env.POSTGRES_URL);

// Schema tables only
import { hmrcSkilledWorkers, companiesHouseProfiles } from '@ss/db/schema';
```

## Exports

| Export | Description |
|--------|-------------|
| `@ss/db` | `createClient(url)`, `runMigrations(url)`, and all schema tables |
| `@ss/db/schema` | Schema table definitions only |
| `@ss/db/client` | `createClient(url)` only |

## Schema overview

| Table | Description |
|-------|-------------|
| `hmrc_skilled_workers` | HMRC licensed sponsor register entries with trigram search indexes |
| `companies_house_profiles` | Cached Companies House company data |
| `hmrc_company_mapping` | Maps HMRC org names to Companies House company numbers |
| `sic_codes` | Standard Industrial Classification code descriptions |
| `hmrc_ingestion_meta` | Tracks CSV ingestion checksums to avoid duplicate imports |

## Migrations

SQL migration files live in `migrations/`. The consuming app is responsible for running them via `runMigrations(url)` and for configuring Drizzle Kit (`drizzle.config.ts`) to generate new migrations.

See [`@ss/web`](../../apps/web/README.md) for the current database tooling scripts.
