# Feature plan: search across previous company names (Option B)

**Status:** Planned · **Created:** 2026-05-29 · **Branch:** `feat/search-previous-names`

## Goal

Let users find a sponsor by a name it *used to* have. Companies House records a
company's former names; HMRC lists the sponsor under one name only. Example:
**PhysicsX** was formerly **Motodynamics Ltd** — typing `Motodynamics Ltd` (or
`motodynamics`) on the home page should surface the PhysicsX listing.

## Decision: Option B (materialized search table) over Option A (inline join)

Two approaches were considered:

- **Option A — inline exact match.** Add a `previous_company_names @> ARRAY[...]`
  branch to `searchHmrc`, reusing the existing array GIN index. Fast to build, but
  only matches a former name typed (near-)verbatim — no fuzzy/partial — because the
  array GIN is not a trigram index.
- **Option B — unified materialized search table (chosen).** One row per
  searchable name (current **and** former), with a `gin_trgm_ops` index. Search
  becomes a single trigram scan over a unified index, so former names get the same
  fuzzy/prefix matching as current names. Costs a new table + a rebuild step, but
  *simplifies* the query (drops the 3-table runtime join) and makes all search
  faster and more powerful.

## Current state (what we're changing)

- `searchHmrc` ([apps/web/src/api/hmrc.ts](../apps/web/src/api/hmrc.ts)) scans
  `hmrc_skilled_workers` directly, scoring `organisation_name` with regex
  word-boundary (`~*` + `\m`) and `pg_trgm` `word_similarity`/`similarity`
  (prefix `2.0` > word-boundary `1.0` > trigram). Backed by a `gin_trgm_ops`
  index on `organisation_name`. Paginated by `offset`, over-fetch `+1` for
  `hasMore`, empty for queries `< 3` chars.
- Same fn powers the home-page infinite query **and** the MCP search tool — both
  get this feature for free.

Relevant data (relationships):

```
hmrc_skilled_workers.organisation_name           -- searchable list (1 row / route)
  → hmrc_company_mapping.organisation_name        -- PK; → company_number (nullable)
  → companies_house_profiles.company_number       -- → previous_company_names text[]
```

Volumes today: 141,030 HMRC rows · 126,210 distinct org names · 43,546 former-name
entries → search table ≈ **~170k rows**.

## 1. New table

Add to [packages/db/src/schema.ts](../packages/db/src/schema.ts):

```ts
export const searchNames = pgTable(
  'search_names',
  {
    organisationName: text('organisation_name').notNull(), // HMRC row(s) to surface
    name: text('name').notNull(),                          // searchable term
    kind: varchar('kind', { length: 16 }).notNull(),       // 'current' | 'previous'
  },
  (table) => [
    primaryKey({ columns: [table.organisationName, table.name] }),
    index('idx_search_names_trgm').using('gin', sql`${table.name} gin_trgm_ops`),
  ],
);
```

Notes:
- PK `(organisation_name, name)` + insert-current-first dedupes the "former name
  == current name" case for free (the same data-quality issue Option A's runtime
  filter handled), so it never double-lists.
- `pg_trgm` is already enabled (used by the org-name index). The GIN trigram index
  on `name` is what makes fuzzy former-name search possible.
- Generate + apply the migration: `bun drizzle-kit generate` then the project's
  migrate step. Confirm the migration emits the `gin_trgm_ops` index (drizzle-kit
  sometimes needs the raw `sql` form, as above).

## 2. Build / sync script

New `apps/web/scripts/build-search-names.ts` (mirrors `generate-sitemap.ts` — same
HMRC→mapping→CH join). Full rebuild (truncate + repopulate; ~170k rows is fast):

```sql
TRUNCATE search_names;

-- current names (one per distinct org name)
INSERT INTO search_names (organisation_name, name, kind)
SELECT DISTINCT organisation_name, organisation_name, 'current'
FROM hmrc_skilled_workers
ON CONFLICT DO NOTHING;

-- former names (only for org names that have HMRC rows; drop blanks)
INSERT INTO search_names (organisation_name, name, kind)
SELECT DISTINCT m.organisation_name, btrim(pn), 'previous'
FROM hmrc_company_mapping m
JOIN companies_house_profiles p ON p.company_number = m.company_number
CROSS JOIN LATERAL unnest(p.previous_company_names) AS pn
WHERE btrim(pn) <> ''
  AND EXISTS (
    SELECT 1 FROM hmrc_skilled_workers h
    WHERE h.organisation_name = m.organisation_name
  )
ON CONFLICT DO NOTHING;  -- drops former names equal to the current name
```

**When to run:** after each HMRC ingestion, alongside sitemap regeneration (the
post-ingestion step from the "regenerate sitemaps after ingestion" chore). Names
change rarely, so a periodic full rebuild is fine for v1.

## 3. Rewrite `searchHmrc`

Scan `search_names`, take the best-scoring name per org (current or former),
then join back to `hmrc_skilled_workers` for the per-route display rows. Easiest
as a raw `sql` CTE via `db.execute` (the multi-CTE shape is awkward in the query
builder):

```sql
WITH scored AS (
  SELECT sn.organisation_name, sn.name, sn.kind,
         (CASE
            WHEN sn.name ~* $prefix       THEN 2.0 + word_similarity($q, sn.name)
            WHEN sn.name ~* $wordBoundary THEN 1.0 + word_similarity($q, sn.name)
            ELSE word_similarity($q, sn.name)
          END) - CASE WHEN sn.kind = 'previous' THEN 0.05 ELSE 0 END AS score
  FROM search_names sn
  WHERE sn.name ~* $wordBoundary
     OR word_similarity($q, sn.name) > 0.6
     OR similarity($q, sn.name) > 0.5
),
best AS (                                   -- one winning name per org (dedupe)
  SELECT DISTINCT ON (organisation_name)
         organisation_name, score, kind, name AS matched_name
  FROM scored
  ORDER BY organisation_name, score DESC
)
SELECT hsw.hash AS slug_id, hsw.organisation_name, hsw.name_slug, hsw.town_city,
       hsw.county, hsw.type_rating, hsw.route, b.score,
       CASE WHEN b.kind = 'previous' THEN b.matched_name END AS matched_former_name
FROM best b
JOIN hmrc_skilled_workers hsw ON hsw.organisation_name = b.organisation_name
ORDER BY b.score DESC, hsw.organisation_name ASC
LIMIT $pageSizePlus1 OFFSET $offset;
```

- Keep the `< 3` chars early-return, `regexEscaped`, `$prefix = '^'+escaped`,
  `$wordBoundary = '\m'+escaped`, and the `PAGE_SIZE + 1` / `hasMore` logic.
- The join fans an org back out to its per-route rows — identical result shape to
  today; `offset` paginates over those rows as before.
- `-0.05` on previous matches keeps an exact current-name match ahead of an equal
  former-name match of a *different* company. Tunable.
- `pg_trgm` lowercases trigrams, so uppercase-stored former names match lowercase
  queries; `~*` is explicitly case-insensitive. No casing work needed.

## 4. API + type changes

- `HmrcRow` gains `matchedFormerName: string | null`.
- `searchHmrc` returns it per row (raw `matched_former_name` → camelCase).
- Existing `slugId/organisationName/...` fields unchanged → home page + MCP keep working.

## 5. UI: explain *why* a result matched

When `matchedFormerName` is set, show a hint on the card so a result for
`Motodynamics` reading "PhysicsX" isn't confusing.

- [apps/web/src/components/HmrcCard.tsx](../apps/web/src/components/HmrcCard.tsx):
  small muted line, e.g. `Formerly {titleCase(matchedFormerName)}`.
- Thread `matchedFormerName` through
  [HmrcResults.tsx](../apps/web/src/components/HmrcResults.tsx) (and its
  `useCardMetrics` height config — a new line affects card height; see the
  CLAUDE.md "Pretext virtual list sizing" notes).

## Rollout order

1. Add `searchNames` to schema → generate + apply migration (table + GIN trgm index).
2. Add `build-search-names.ts`; run once to populate.
3. Wire the rebuild into the post-ingestion step.
4. Rewrite `searchHmrc` to scan `search_names` + join.
5. Add `matchedFormerName` to `HmrcRow` and the return.
6. `HmrcCard` "Formerly …" hint + thread through `HmrcResults` (+ card-height config).

## Edge cases & risks

- **Former == current name** → dropped by PK + insert order. ✓
- **A former name shared by multiple companies** → each org keeps its own row; all
  surface. ✓
- **Multiple routes per org** → join fan-out, same as today. ✓
- **Staleness** → previous-name search lags until the rebuild runs post-ingestion;
  acceptable for v1. *Future:* incremental upserts when a profile's
  `previous_company_names` changes, via the ch-stream / cache-invalidation pipeline.
- **Card height** → adding the "Formerly" line must be reflected in the pretext
  height config or the virtual list will mis-measure (CLAUDE.md).
- **Perf** → GIN trgm over ~170k rows is well within budget; scoring runs only on
  index-matched rows, comparable to today.

## Verification

- `Motodynamics Ltd` and `motodynamics` both surface PhysicsX with "Formerly
  Motodynamics Ltd".
- Current-name search results + ordering unchanged vs. today (same scoring math).
- MCP search tool returns the new field without breaking.
- `EXPLAIN` confirms the GIN trgm index is used (no seq scan on `search_names`).

## Effort

~1–2 days: schema + migration (S) · build script + wiring (S) · `searchHmrc`
rewrite (M) · type + card UI + height config (M) · verification (S).

## Dependency note

Independent of the `feat/previous-companies` PR — this reads
`companies_house_profiles.previous_company_names` directly via the new
`search_names` table, not via the `getCompanyProfile` server fn. Branched off
`main` so it merges cleanly as its own PR.
