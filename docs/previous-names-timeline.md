# Company name history: date it and fold it into the timeline

**Status:** future work (not started). **Source:** 2026-07-14, follow-up to the
company timeline feature (`feat/company-changes` #251 + `feat/improve-map-addresschange` #255).

A company's previous names are a change-history event just like an address move
or a status change — but today they live in a separate, **undated** "formerly
known as" block at the top of the details page instead of on the timeline we
built. Companies House already returns the dates; we throw them away at
ingestion. Once we keep them, every rename becomes a properly-dated timeline
event and the top block can retire.

---

## The gap today

- **Storage is name-only.** `companies_house_profiles.previous_company_names` is
  `text('previous_company_names').array()` — a bare `text[]` of names, no dates
  (`packages/db/src/schema.ts:90`). `ch_previous_names` (the flattened,
  trigram-indexed search projection maintained by the `trg_sync_ch_previous_names`
  trigger, `schema.ts:112`) is likewise name-only.
- **Dates are discarded at both ingestion paths.** The CH full-profile payload's
  `previous_company_names[]` carries `name` + `effective_from` + `ceased_on`, but:
  - `apps/web/src/lib/hmrc-ch/profile-row.ts:31-33` casts it as `{ name: string }[]`
    and `:60` maps to `previousNames.map((p) => p.name)`.
  - `apps/ch-stream/src/mapper.ts:39-41` does the same `.map((p) => p.name)`.
  - The shared CH types (`apps/ch-stream/src/types.ts:38`, and the full-profile
    shape used in `profile-row.ts`) model only `{ name: string }[]`.
  - (Note: the compact `n?: { name: string }[]` in `resolve-sponsor.ts` /
    `companiesHouse.ts` is the CH **search** result shape — a different endpoint,
    unrelated to these dates. Only the full-profile fetch carries them.)
- **The UI shows names with no dates, in two places** (`company.$id.$slug.tsx`):
  - `formerNames` is built + deduped at `:329-336`, then rendered as the vertical
    "formerly known as" list by `NameHistory` at `:364` (`components/NameHistory.tsx`).
  - The same list feeds the SEO summary sentence at `:352-354`
    ("It was previously known as X, Y.").
- **The timeline only dates renames observed since tracking began.** `curate.ts`'s
  `rename` kind (~`:302-317`) diffs the `previousCompanyNames` **trail** rows: when
  the array gains a name, it emits "Company renamed — Formerly X" dated at *our
  observation time* (`published_at`/`created_at`). Renames from **before**
  `TRACKING_SINCE` (2026-04-14) have no trail, so they never reach the timeline —
  they only survive as the undated top block.

## What Companies House gives us

The company profile endpoint (already fetched for every ingest) returns:

```jsonc
"previous_company_names": [
  { "name": "MOTODYNAMICS LTD", "effective_from": "2015-03-01", "ceased_on": "2021-11-08" }
]
```

- `ceased_on` = the date that name stopped being current, i.e. **the rename-away
  date** — this is the event date we want.
- `effective_from` = when that name started (lets us reconstruct the full chain
  and label each rename as "X → Y").
- No extra API calls: the data is in the same payload we already parse.

## Target UX

- Each previous name becomes a dated **`rename` timeline event**, ordered by
  `ceased_on`, e.g. `8 Nov 2021 — Company renamed · Motodynamics Ltd → Physicsx Limited`.
  The name it renamed *to* is the next-newer previous name (by `effective_from`),
  or the current company name for the most recent former name.
- The top "formerly known as" `NameHistory` block is **retired** — its content now
  lives, dated and in-order, on the timeline. (Keep the SEO summary sentence; see
  UI changes.)
- This is the one event type we can legitimately date *before* `TRACKING_SINCE`:
  the dates come from CH, not from our trail tracking. Historical renames sit below
  the "Change tracking began" anchor, which is correct — see anchor note below.

## Schema changes

Store the dated structure as the source of truth; leave the search projection alone.

- Add a JSONB column to `companies_house_profiles`, e.g.
  `previous_company_names_dated jsonb not null default '[]'` holding
  `[{ name, effectiveFrom, ceasedOn }]` (dates as `YYYY-MM-DD` strings or null).
  Prefer this over widening the existing `text[]` so the trigram search trigger and
  `ch_previous_names` keep working untouched.
- Keep `previous_company_names text[]` as-is (it drives `ch_previous_names` search).
  Optionally derive it from the JSONB later to have one source, but that's a
  separate cleanup — not required for this feature.
- Migration via `bun db:generate` (see [[reference_drizzle_kit_generate_tty]] for the
  interactive-diff gotcha). Column is additive + defaulted, so no backfill-before-deploy
  ordering hazard (unlike 0035).

## Ingestion changes

- Extend the CH previous-names type to `{ name: string; effective_from?: string;
  ceased_on?: string }[]` in the full-profile shapes (`ch-stream/src/types.ts`, the
  cast in `profile-row.ts:31`).
- `profile-row.ts:60` and `ch-stream/mapper.ts:41`: in addition to the existing
  name-only array, emit the dated array into the new column
  (`previousCompanyNames.map((p) => ({ name: p.name, effectiveFrom: p.effective_from
  ?? null, ceasedOn: p.ceased_on ?? null }))`). Keep both writes for now.
- Trails: no change needed. Renames become **profile-snapshot-sourced** (see below),
  not trail-diff-sourced, so we don't need to trail the dated column. If we *do*
  trail it, exclude it from the timeline's trail-diff `rename` path to avoid
  double-counting.

## Backfill

Existing rows have name-only history and a `'[]'` dated column. Two options:

1. **Dedicated backfill script** (recommended for completeness): iterate companies
   where `array_length(previous_company_names, 1) > 0`, re-fetch the CH full profile,
   write `previous_company_names_dated`. Respect CH rate limits (600 req / 5 min);
   reuse the existing CH client + the sweep/cron patterns. This is the only way to
   date *historical* (pre-tracking) renames.
2. **Passive**: let ch-stream refill dates as profiles naturally update. Incomplete
   and slow (a company only refreshes when CH publishes a change), so use this only
   as a fallback, not the primary path.

Scope: from the 2026-07-14 scan, a large share of the ~4.5k tracked-address companies
also carry previous names, so expect tens of thousands of profiles — size the backfill
as a rate-limited batch job, not a one-shot.

## Timeline integration

- Pass the dated previous names into `curateTimeline` alongside `rows`
  (thread through `getCompanyTimeline` in `apps/web/src/api/companyTimeline.ts`,
  which already loads the profile).
- Emit one `rename` event per dated entry: `dateISO = ceasedOn`,
  `from = thisName`, `to = <name with the next-newer effectiveFrom, else current
  company name>`, reusing the existing `rename` kind + neutral tone. Render as an
  `A → B` change like address moves (they already support `from`/`to`).
- **Dedup / source of truth:** the CH-dated renames supersede the trail-diff
  `rename` events. Once the dated column is populated for a company, drop the
  trail-diff `rename` path for it (or filter out trail renames whose added name
  matches a dated entry) so a post-tracking rename isn't shown twice with two
  different dates. Simplest end state: **renames come only from the dated profile
  array**; retire the trail-diff `rename` case in `curate.ts`.
- **Ordering / anchor:** events already sort by `dateISO` desc. Historical renames
  will land below the "Change tracking began" anchor. That anchor's copy ("Earlier
  changes aren't shown") is about *trail* coverage; a CH-dated rename below it is
  legitimately earlier and known. Revisit the anchor wording so a dated event
  sitting below "tracking began" doesn't read as contradictory (e.g. anchor
  clarifies it bounds *tracked* changes, not all history).

## UI changes

- Remove the `NameHistory` "formerly known as" list from the header
  (`company.$id.$slug.tsx:364`) — render the plain `<h1>` current name + `children`.
  `NameHistory.tsx` can be deleted once nothing else uses it.
- **Keep the SEO summary sentence** (`:352-354`) — "previously known as X, Y" is
  valuable for indexing and needs no dates. It reads from `formerNames`, which stays.
- **Date-less fallback:** some very old CH records have a `name` with a null
  `ceased_on`. An event with no date can't sort into the timeline. Options: place
  such names at the oldest anchor with an "date unknown" note, or keep a minimal
  undated tail block for them. Decide during build; expect this to be rare.

## Edge cases / open questions

- Names that repeat or only differ by suffix (LTD/LIMITED) — the current dedup
  (`normalizeName`, `:332`) collapses them; keep that logic when building events.
- A rename and an address change on the same `ceased_on` day — same-day ordering
  is already handled by `KIND_RANK` + `sortTs` (both default to rank 2, then sort
  by timestamp/id); give `rename` an explicit rank only if a tie looks wrong.
- Multiple renames on one day (rare) — each dated entry is its own event; fine.
- Should the *incorporation-era* first name be shown? The chain's oldest
  `effective_from` ≈ incorporation; the "Incorporated" anchor already covers that
  date, so no separate event needed.

## Done when

- CH `effective_from`/`ceased_on` are ingested into a dated column (both
  `profile-row.ts` seed and `ch-stream` live paths), with a backfill run for
  existing rows.
- The timeline renders dated `rename` events (A → B, ordered by `ceased_on`),
  with no duplicate renames between the CH-dated source and the trail-diff path.
- The header's undated "formerly known as" block is removed; the SEO summary
  sentence still lists former names.
- Verify on a multi-rename company (e.g. Physicsx Limited / formerly Motodynamics
  Ltd) that the rename shows on the timeline with the correct CH date and is gone
  from the top block.
