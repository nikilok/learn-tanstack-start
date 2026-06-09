# Plan: Adapt HMRC ingestion to the new gov.uk CSV format (+ CH-sourced location)

## Context

The gov.uk "Worker and Temporary Worker" sponsor CSV changed format on 2026-06-09, which
hard-failed the ingestion GitHub Action (schema-validation guard, working as designed —
exit 1 before touching the DB). The feed:

- **Dropped** `Town/City`, `County` (HMRC can't guarantee location correctness — it's
  Companies House's domain, which is *why* they removed it).
- **Renamed** `Type & Rating` → `TierRating` and `Route` → `Migrant Classification`
  (verified: the value strings are **byte-for-byte identical** — same 9 / 17 distinct
  values, trailing spaces and all).
- **Added** `Sponsor Licence Number` (a stable per-sponsor ID) and `Sponsor Status`
  (currently single-valued: "Licensed and Fully Active").

**Decisions locked with the user:**

1. Ingest stays **true to HMRC** — clean atomic swap, **no carry-forward** of old
   town/county or slugs. Row `hash` (the `/company/$id/$slug` URL id) therefore changes.
2. **Adopt** the Sponsor Licence Number (and Status) into the table.
3. Confirmed Companies House API exposes **no** sponsor licence number — so the licence is
   a within-dataset stable key, *not* a CH join key. CH joins still go via org name.
4. Listing-page location now comes from Companies House via a **query-time `LEFT JOIN`**
   (not denormalized). Verified live: ~86% of rows (121,265 / 141,264) resolve to a CH
   locality; `address_line_2` fallback adds only ~850. The join is ~free — location is
   pure display (never in `WHERE`/`ORDER BY`), so it's PK probes on the ≤50 returned rows,
   dominated by the existing trigram scan.

**Outcome:** ingestion green again on the new feed; listing/detail location sourced from
CH; licence number captured; the HMRC table reflects exactly what HMRC publishes.

---

## Changes by area

### 1. Ingestion script — `apps/web/scripts/ingest-hmrc-csv.ts`

- **`EXPECTED_COLUMNS`** (lines 7-13) → `['Sponsor Licence Number', 'Organisation Name',
  'TierRating', 'Migrant Classification', 'Sponsor Status']`. Keep the guard — it now also
  catches the *next* format change.
- **Column mapping at parse** (dedup loop, lines 142-163): keep internal DB names so the
  matching pipeline is untouched — `TierRating` → `type_rating`, `Migrant Classification`
  → `route`. Read `Sponsor Licence Number` → `sponsor_licence_number`, `Sponsor Status` →
  `sponsor_status`. Drop all `Town/City` / `County` reads.
- **New hash basis** — `computeHash(licence, typeRating, route)` (replaces lines 113-126):
  `base64url(sha256(licence | type_rating | route))[:11]`. Rationale:
  - Stable: licence is durable, so **future ingests no longer churn URLs — this is the
    last hash migration** (the old town/county inputs were the churny part).
  - Disambiguates the 903 org-names that map to >1 licence.
  - Excludes org name → company renames don't change the URL (`nameSlug` is cosmetic; the
    loader resolves by hash).
  - Keep the `UNIQUE(hash)` constraint as a collision guard; dedup on the same key.
- **`nameSlug`** unchanged: `slugify(orgName) || hash` (line 149).
- **Staging DDL** (lines 88-99): drop `town_city`, `county`; add
  `sponsor_licence_number varchar(20)`, `sponsor_status varchar(64)`. Update the
  `INSERT`/placeholder builder (lines 169-199) and `CleanedRow` type (129-137) to match.
- **Indexes** (lines 203-209): drop `stg_idx_hmrc_town_city`; keep org_name / name_slug /
  route / org_name_trgm; add `stg_idx_hmrc_licence` on `sponsor_licence_number`.
- **Atomic-swap renames** (lines 215-224): drop the `town_city` index rename; add the
  licence index rename.
- Checksum guard + `hmrc_ingestion_meta` insert unchanged.

### 2. DB schema + migration — `packages/db/src/schema.ts`

- `hmrcSkilledWorkers` (lines 17-39): remove `townCity`, `county`; add
  `sponsorLicenceNumber varchar(20)`, `sponsorStatus varchar(64)`. Remove
  `idx_hmrc_town_city`; add `idx_hmrc_licence`.
- Generate a Drizzle migration (`bun run` the drizzle-kit generate flow from root).
- **Lockstep invariant:** `schema.ts` ≡ the ingest script's `CREATE TABLE` DDL ≡ the
  migration result must all agree. The ingest atomic-swap rebuilds the table from its own
  DDL, but the migration must run *first* so the live table has the new columns before any
  deployed query references them (avoids a SELECT on a not-yet-existing column).

### 3. Search query — `apps/web/src/api/hmrc.ts`

- `searchHmrc` (18-63): add
  `.leftJoin(hmrcCompanyMapping, eq(hmrcCompanyMapping.organisationName, hmrcSkilledWorkers.organisationName))`
  then `.leftJoin(companiesHouseProfiles, eq(companiesHouseProfiles.companyNumber, hmrcCompanyMapping.companyNumber))`.
  Replace the `townCity`/`county` selects with
  `location: sql\`COALESCE(${companiesHouseProfiles.locality}, ${companiesHouseProfiles.addressLine2})\``.
  Score/order/limit unchanged (they reference only `hmrcSkilledWorkers`, so ranking and
  `LIMIT` pushdown are unaffected).
- `getHmrcBySlugId` (69-90): drop `townCity`/`county` (detail page sources location from
  the CH profile it already loads). Optionally also select `sponsorStatus` for a future
  status badge.
- `HmrcRow` type (157) updates automatically; drop town/county, add `location`.
- `getHmrcBySlug` fallback (130-143) unchanged.

### 4. UI

- **`HmrcCard.tsx:88-90`** — replace `[row.townCity, row.county]…join(', ')` with
  `titleCase(row.location ?? '')` (single token, e.g. "London").
- **`HmrcResults.tsx:41-46`** (pretext field 2 `getText`) — change to
  `(row) => titleCase(row.location ?? '')`. Keep `font:'14px Geist'`, `lineHeight:20`,
  `fixedHeight:62`. ⚠️ **`CLAUDE.md` invariant** — `useCardMetrics` must stay in sync with
  card CSS; the measured *text* changes (now a single CH token, shorter → less wrapping)
  but the font/height config is unchanged, so `fixedHeight` stays 62.
- **`company.$id.$slug.tsx`** — the loader already fetches the CH `profile`
  (lines 79-81). Source location from it: `displayLocation` (244) and head() (127-128) →
  `formatLocation(profile?.registered_office_address?.locality, …?.region)`. Detail page
  keeps its richer two-part display (town + region), now CH-sourced. Remove `townCity`/
  `county` from the loaderData `sponsor` type (90-96) and all usages.
- **`McpTools.tsx:80,215`** — update location formatting to use the new `location` field
  from the search row.
- **`utils.ts` `formatLocation` (87-102)** — keep as-is (generic two-arg joiner), now fed
  CH locality/region on the detail page.

### 5. Matching pipeline — compile-safe, accept tiebreak loss

`route` is preserved (renamed at ingest), so the route-type hard gate is unaffected. Only
the town/county *DB reads* break:

- **`apps/web/src/lib/phase5/sql.ts` `makeLookupSponsor` (122-147)** — SELECT drops
  `town_city, county`, keeps `route`; return `{ townCity: null, county: null, route }`.
- **`apps/web/src/api/companiesHouse.ts` on-demand resolver (222-244)** — remove the
  `hmrcRow` SELECT of `townCity`/`county`; pass `{ townCity: null, county: null }` to
  `resolveOneSponsor`.
- Leave the resolver/scorer **types and logic intact** (`pipeline.ts pickByLocality`,
  `score-candidate.ts`, `compare-candidates.ts`, `resolve-sponsor.ts`, `sweep.ts`) — they
  now operate on null locality, so the geographic tiebreak is inert. Existing phase5 tests
  pass mock localities directly, so they still pass.
- **Documented degradation (accepted):** without HMRC town, ambiguous same-name orgs lose
  the `pickByLocality` tiebreak → more `human_review` / a growing review queue. Acceptable
  per the premise (HMRC location was unreliable); the 88% already-mapped orgs keep their
  `company_number`, so steady-state location coverage holds. Optional later: replace the
  geo tiebreak with a non-geo signal (company status / name-similarity margin) — out of
  scope here.

### 6. Sitemap + SEO

- `apps/web/scripts/generate-sitemap.ts` — no change (selects `hash`, `nameSlug`, both
  retained). After the swap all hashes change; the workflow's `data-changed`-gated
  `sitemap:generate` + PR steps regenerate them.
- **One-time URL churn:** every detail URL changes once. The existing loader fallback
  (`company.$id.$slug.tsx:59-77`) absorbs it — 301 for single-row orgs (~90%, unique
  `name_slug`), 302→search for multi-route orgs. Because the new hash is licence-based and
  stable, this is a one-time event, not recurring.
- **Optional SEO safeguard (recommend):** change the multi-match branch (69-75) from
  302→search to **301→the canonical (first) row**, so old multi-route URLs land on a real
  page and retain link equity instead of bouncing to search.

### 7. Workflow / dev scripts

- `.github/workflows/hmrc-ingestion.yaml` — no change; it succeeds once the script handles
  the new columns. (The `actions/checkout@v4` Node-20 deprecation warning is unrelated
  housekeeping.)
- **Follow-up (non-blocking, local-only):** `generate-hmrc-seed-sql.ts` parses the old CSV
  columns and will break on the new format / old fixture; update it or refresh
  `apps/web/data/2026-03-31-Worker.csv`. Re-check `seed-companies-house.ts` for town/county
  reads.

---

## Verification

1. **Lint/type/test** (from repo root): `bun lint:fix && bun lint`, the monorepo
   type-check (HmrcRow ripple → HmrcCard/HmrcResults/McpTools/detail page), `bun test`
   (phase5 tests should stay green).
2. **Ingest dry-run on a branch/staging DB** against the live new CSV with `--force`:
   confirm schema validation passes, ~140,876 unique rows, no town/county columns,
   `sponsor_licence_number`/`sponsor_status` populated, hashes minted, UNIQUE holds.
3. **Listing**: run search locally, confirm cards show CH locality (e.g. "Checkout LTD" →
   "London"), ~86% populated / ~14% blank; confirm the join doesn't regress search latency
   (EXPLAIN: trigram scan dominates, joins are PK nested-loops on the returned window).
4. **Detail**: confirm location now renders from the CH profile.
5. **Sitemap**: `bun run sitemap:generate` → new hashes in output.
6. **Redirects**: hit an old `/company/OLDHASH/slug` → 301 (single-row) or 302/301
   (multi-route, depending on the optional safeguard).
7. **Deploy order**: migration (adds columns) → deploy code → trigger ingest (`--force`,
   repopulates licence/status + new hashes) → sitemap regen PR.

---

## Open items to confirm before implementing

- **Hash basis = `licence|type_rating|route`** (recommended; makes this the last URL
  migration). Alternative would be `org|type|route`, but that re-churns on renames and
  collides on the 903 multi-licence names.
- **Optional 301→canonical multi-match safeguard** (§6) — include or skip?
- **Matching tiebreak degradation** accepted as-is (§5) — confirm OK to defer a
  replacement signal.

---

## Source data reference (2026-06-09 feed)

- New columns: `Sponsor Licence Number, Organisation Name, TierRating, Migrant Classification, Sponsor Status`
- Old columns: `Organisation Name, Town/City, County, Type & Rating, Route`
- New feed: 141,806 rows → ~140,876 unique `(org, type, route)`
- Live DB coverage at planning time: 141,264 rows / 126,420 orgs; 111,320 orgs mapped to a
  company number; 121,265 rows (~86%) resolve to a CH locality (or `address_line_2`).
