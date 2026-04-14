# @ss/ch-stream

24/7 worker service that listens to the [Companies House streaming API](https://developer-specs.company-information.service.gov.uk/streaming-api/guides/overview) and keeps `companies_house_profiles` up to date with audit trails.

## How it works

1. Loads all known company numbers into an in-memory `Set` on startup
2. Connects to `GET https://stream.companieshouse.gov.uk/companies` (long-lived HTTP stream)
3. Filters events — skips companies we don't track (zero DB calls)
4. For matching companies: diffs incoming data against the current DB row
5. Updates the profile and writes change details to `companies_house_profile_trails`
6. Persists the stream `timepoint` to `ch_stream_state` every 100 events for resume-after-restart

## Environment variables

| Variable | Description |
|---|---|
| `POSTGRES_URL` | Database connection string |
| `COMPANIES_HOUSE_STREAM_API_KEY` | Streaming API key (register at [CH Developer Hub](https://developer.company-information.service.gov.uk) under "Streaming API" application type) |

## Local development

```bash
# Dry-run mode (no DB writes, logs what would change)
bun run dev

# Live mode (writes to DB)
bun --env-file=.env.local src/index.ts
```

## Audit trail

Every field change is logged to `companies_house_profile_trails`:

| Column | Description |
|---|---|
| `company_number` | The company that changed |
| `column_name` | Which field changed (or `_deleted` for deletion events) |
| `old_value` | Previous value (stringified) |
| `new_value` | New value (stringified) |
| `created_at` | When the change was recorded |

## Architecture

```
src/
  index.ts       — entry point, reconnection loop, --dry-run flag
  stream.ts      — HTTP stream connection, line parsing, heartbeat handling
  processor.ts   — in-memory filtering, diffing, DB updates, audit trails
  mapper.ts      — CH API response to DB column mapping (sparse, only maps present fields)
  config.ts      — environment variables and constants
  types.ts       — TypeScript types for CH streaming API events
```
