# Phase 5 — sweep algorithm (streamlined plan)

Companion to [hmrc-ch-mapping-fix.md](hmrc-ch-mapping-fix.md). That doc
holds the requirements; this one is the boiled-down flow.

## What runs

One script: `phase5-sweep.ts`. Invoked per tier from a GitHub Actions
cron with `--tier=<name>`. Tiers differ only by SELECT predicate and
cadence; the per-row logic is identical.

```text
Tier 1  match_method = 'no_match'                       daily,    4000 rows
Tier 2  match_method IN ('token_sim','previous_name')   2×/week,  3000 rows
Tier 3  match_method = 'exact'                          daily,    1500 rows
Tier 4  match_method = 'public_body'                    monthly,   500 rows
```

## Tables touched

- `hmrc_company_mapping` — read tier slice, UPDATE on promote
- `hmrc_company_mapping_audit` — INSERT one row per UPDATE
- `companies_house_profiles` — UPSERT when a `no_match` flips to `verified`; read existing profile for the inline scorer
- `hmrc_skilled_workers` — read for locality + route tiebreak

Earlier versions of this design used an `hmrc_company_mapping_review_queue` table for `same_rank_different_number` cases. That table is being dropped (2026-05-11) — the inline scorer (see "Same-rank inline resolution" below) now decides these cases at sweep time. The other reason classes the queue theoretically held (`manual_conflict`, `public_body_conflict`) never fired in production and are replaced with log-and-bump.

## Top-level flow

```pseudo
sweep(tier):
  rows = SELECT * FROM hmrc_company_mapping
         WHERE <tier predicate>
         ORDER BY verified_at ASC NULLS FIRST
         LIMIT max_rows[tier]

  for row in rows:
    process(row, changed_by = "phase5_sweep_" + tier)
    sleep(2200ms)        # ~1.8 req/sec at the post-patch worst case of
                         # 4 CH calls/row (1 search + 3 Tier-B profile
                         # fetches when Tier-A returned only inactive
                         # candidates). See active-status preference in
                         # apps/web/src/lib/hmrc-ch/resolve-sponsor.ts.

  print summary(updated, bumped, lock_missed, warned, errored)
```

## Per-row flow

```pseudo
process(row, changed_by):
  loc       = lookupLocality(row.organisation_name)
  proposed  = resolveOneSponsor(row.organisation_name, loc, fetchApi)
  # proposed.verdict ∈ {verified, public_body, no_match, human_review}

  action = decide(existing = row, proposed)

  match action:
    bump          → bumpVerifiedAt(row)
    update        → applyPromotion(row, proposed, changed_by)
    inline_score  → run scoreCandidate on existing + proposed profiles,
                    dispatch to applyPromotion / bumpVerifiedAt /
                    log_and_bump based on score margin
                    (see "Same-rank inline resolution" below)
    log_and_bump  → console.warn(reason); bumpVerifiedAt(row)
                    # used for the rare manual_conflict / public_body_conflict
                    # cases. Sweep summary's `warned` counter goes non-zero;
                    # operator decides whether to act manually.
```

## The decision (upgrade-only, never demote)

Rank ladder for ordinary states:

```text
0  no_match
1  human_review
2  verified · token_sim
3  verified · previous_name
4  verified · exact
```

`public_body` and `manual` sit outside the ladder — terminal peers
that never auto-trade with a ranked state.

```pseudo
decide(existing, proposed):
  # 1. sweep never assigns human_review
  if proposed.verdict == 'human_review':
      return bump

  # 2. manual is sacred — only a human overwrites it
  if existing.match_method == 'manual':
      if proposed agrees on company_number:
          return bump                                  # human override re-confirmed
      return log_and_bump("manual_conflict")           # surfaces in sweep summary

  # 3. public_body is a terminal peer (4 distinct cases — not a clean xor)
  if existing.match_method == 'public_body' and proposed.verdict == 'public_body':
      return bump
  if existing.match_method == 'public_body' and proposed.verdict == 'verified':
      return log_and_bump("public_body_conflict")
  if proposed.verdict == 'public_body' and existing.match_method != 'no_match':
      return log_and_bump("public_body_conflict")
  if proposed.verdict == 'public_body' and existing.match_method == 'no_match':
      return update                                    # promote rank 0 → terminal
  # existing=public_body + proposed=no_match falls through to step 4 — the
  # rank ladder treats public_body's missing entry via the human_review
  # fallback (rank 1), so no_match (rank 0) loses → bump.

  # 4. ranked comparison
  if rank(proposed) > rank(existing):  return update   # promote
  if rank(proposed) < rank(existing):  return bump     # reject demote

  # rank(proposed) == rank(existing)
  if proposed.company_number == existing.company_number:
      return bump
  return inline_score                                  # see "Same-rank inline
                                                       # resolution" below
```

`decide()` stays pure — it returns the *intent*. The scorer call happens in
the sweep orchestrator, not inside `decide()`. This keeps the decision
table fully unit-testable without DB or CH access.

## The atomic write (promote)

UPDATE + audit INSERT in one statement. Optimistic lock on
`verified_at` so any concurrent writer (manual ops, future ch-stream
worker, overlapping tier) is detected, not clobbered.

```pseudo
applyPromotion(row, proposed, changed_by):
  WITH updated AS (
    UPDATE hmrc_company_mapping
       SET company_number = proposed.company_number,
           match_method   = proposed.match_method,
           match_score    = proposed.match_score,
           query_used     = proposed.query_used,
           is_public_body = (proposed.verdict == 'public_body'),
           verified_at    = now()
     WHERE organisation_name = row.organisation_name
       AND verified_at IS NOT DISTINCT FROM row.verified_at   # optimistic lock
     RETURNING company_number, match_method
  )
  INSERT INTO hmrc_company_mapping_audit
    (organisation_name, old_company_number, new_company_number,
     old_match_method,  new_match_method,  changed_by)
  SELECT row.organisation_name,
         row.company_number, company_number,
         row.match_method,   match_method,
         changed_by
    FROM updated;

  if 0 rows affected:
      lock_missed += 1; return                # row reappears in next sweep

  # only after the mapping write succeeds
  if proposed.verdict == 'verified':
      upsertProfile(proposed.profile)         # reuse existing helper
```

The profile UPSERT runs **after** the mapping CTE — if the lock missed,
we don't want to pollute the profile cache with an entity we didn't end
up mapping to. This is the new behaviour vs. earlier phases: Phase 5 is
the only mechanism that grows `companies_house_profiles` for `no_match`
rows that finally resolve.

## The bump (no-op + audit-free `verified_at` touch)

```pseudo
bumpVerifiedAt(row):
  UPDATE hmrc_company_mapping
     SET verified_at = now()
   WHERE organisation_name = row.organisation_name
     AND verified_at IS NOT DISTINCT FROM row.verified_at;
```

No audit row — the audit table is for material corrections, not
heartbeats. Rows that bumped just fall to the bottom of their tier's
queue.

## Same-rank inline resolution

When the rank ladder ties (`rank(proposed) == rank(existing)`) and the
two candidates have different company numbers, the sweep orchestrator
runs `scoreCandidate` on both profiles and decides inline. No queue
table, no follow-up job — the decision lands in the same sweep run.

### Why the queue went away

The historical design enqueued these cases as
`same_rank_different_number` rows in `hmrc_company_mapping_review_queue`
for a separate resolver to process. As of 2026-05-11 that queue has 140
unresolved rows (every row ever enqueued; nothing has ever drained
them). Inspecting the data showed that ~90% of those rows fall into
deterministic patterns that a small rule-based scorer resolves cleanly:

- **BR ↔ FC** (UK Establishment ↔ Foreign Company): the same legal
  entity registered twice. Picked by canonical preference + locality.
- **OE ↔ FC** (Overseas Establishment ↔ Foreign Company): same pattern.
- **CE ↔ regular Ltd** (Charity ↔ private limited): solved by route-type
  compatibility — if `hmrc_skilled_workers.route = 'Charity Worker'`, a
  `private-limited-company` candidate is incompatible.
- **Ltd ↔ Ltd** (two unrelated companies sharing a name): solved by HMRC
  locality match.

The remaining ~10% are genuine ambiguities, and the scorer's confidence
threshold (`MARGIN`) keeps the row at status quo (bump) with a warning
rather than committing a wrong promotion.

### `scoreCandidate` — pure scoring function

```pseudo
scoreCandidate(candidate, sponsor, existing):
  # Hard gate — domain rule that's never wrong
  if not routeTypeCompatible(sponsor.route, candidate.company_type):
      return -infinity

  score = 0

  # Succession evidence (strongest positive signal)
  if normalised(existing.name) in candidate.previous_company_names:
      score += 5

  # HMRC locality match
  if candidate.locality == sponsor.town_city:        score += 3
  if candidate.postcode_area == sponsor.postcode_area: score += 2

  # Status
  if candidate.status == 'active':                   score += 1
  if candidate.status in ('dissolved', 'liquidation'): score -= 2

  # Same-entity hint
  if candidate.company_type == existing.company_type: score += 1

  return score
```

The function is pure: no I/O, no DB, no fetches. Profiles are passed in
as already-loaded objects. Unit-testable with fixture profiles.

### Dispatch in the sweep orchestrator

```pseudo
on action == 'inline_score':
  sponsor          = lookupHmrcSponsor(row.organisation_name)
  existing_profile = getProfile(row.company_number)         # usually local
  proposed_profile = proposed.profile                       # already loaded

  s_e = scoreCandidate(existing_profile, sponsor, existing_profile)
  s_p = scoreCandidate(proposed_profile, sponsor, existing_profile)

  if s_p > s_e + MARGIN:
      applyPromotion(row, proposed, changed_by)
  elif s_e > s_p + MARGIN:
      bumpVerifiedAt(row)
  else:
      console.warn(`inline_score inconclusive for ${row.organisation_name}`)
      bumpVerifiedAt(row)        # surfaces in sweep summary's `warned` counter
```

`MARGIN` starts at 3 (conservative — at least one strong signal of
difference needed). Tunable as the route-type compat table and feature
set evolve.

### Route-type compatibility (domain-knowledge artefact)

```text
apps/web/src/lib/phase5/route-type-compat.ts
```

Maps HMRC sponsorship `route` values to the set of CH `company_type`
values eligible to hold that route. Encodes Home Office sponsor
licence rules.

```ts
export const ROUTE_TYPE_COMPAT: Record<HmrcRoute, Set<CHCompanyType>> = {
  'Charity Worker': new Set([
    'charitable-incorporated-organisation',
    'private-limited-guarant-nsc',       // + charity reg, in practice
    'registered-society-non-jurisdictional',
    // …
  ]),
  'Skilled Worker': new Set([
    'private-limited-company',
    'public-limited-company',
    'private-limited-guarant-nsc',
    'oversea-company',
    'uk-establishment',
    // virtually all corporate forms
  ]),
  // … Religious Worker, Scale-up, Global Business Mobility, etc.
};
```

This file is the auditable source of truth for "what company types can
hold this licence". Reviewable by anyone, regardless of ML / scoring
knowledge.

### Migration of the existing 140 rows

One-shot script at `apps/web/scripts/resolve-same-rank-queue.ts`:

```pseudo
for row in SELECT * FROM hmrc_company_mapping_review_queue
           WHERE resolved_at IS NULL
           ORDER BY id ASC:
    sponsor          = lookupHmrcSponsor(row.organisation_name)
    existing_profile = fetchProfile(row.existing_company_number)
    proposed_profile = fetchProfile(row.proposed_company_number)

    s_e = scoreCandidate(existing_profile, sponsor, existing_profile)
    s_p = scoreCandidate(proposed_profile, sponsor, existing_profile)

    if s_p > s_e + MARGIN:
        applyPromotion(/* swap to proposed */, 'resolve_queue_oneshot')
    elif s_e > s_p + MARGIN:
        pass     # existing wins, no change
    else:
        record inconclusive case → markdown TODO list for manual triage
```

Run once. Inconclusive residue (expected: a handful) gets manually
resolved by inspection. Then the queue table is dropped.

### Dropping the table

After the one-shot drain:

```sql
DROP TABLE hmrc_company_mapping_review_queue;
```

…plus removing its schema definition, the `makeEnqueueReview` factory
in `sql.ts`, the `enqueueReview` slot from `SweepDeps`, and the `queue`
action from `decide()`'s return type. The audit table
(`hmrc_company_mapping_audit`) continues to carry the full history of
mapping changes — nothing is lost.

## DDL

```sql
CREATE INDEX idx_mapping_method_verified
  ON hmrc_company_mapping (match_method, verified_at NULLS FIRST);

-- Drop the review queue table (and its indexes) once the one-shot
-- migration of the existing 140 rows is complete.
DROP TABLE hmrc_company_mapping_review_queue;
```

No new tables. `hmrc_company_mapping`, `hmrc_company_mapping_audit`, and
`companies_house_profiles` already have everything Phase 5 needs.
`hmrc_company_mapping_review_queue` was the only addition the previous
design required, and is now being removed.

## ch-stream coordination

Phase 5 writes new rows into `companies_house_profiles`. ch-stream
loads its `companyNumbers` set once at startup and drops events for
anything outside the set. To pick up Phase-5-added entities without a
restart, ch-stream should poll-refresh that set every ~30 min:

```pseudo
every 30 min:
  companyNumbers = new Set(SELECT company_number FROM companies_house_profiles)
```

This is a ch-stream change, tracked separately. Phase 5's contract
ends at "row written to `companies_house_profiles`".

## Per-run summary (stdout, captured by GH Actions)

```text
Phase 5 sweep — tier=<name>
  selected         : N
  updated          : N
  bumped           : N
  inline_resolved  : N    # same-rank cases the scorer decided
  inline_inconclusive : N # same-rank cases the scorer punted on (with warning)
  warned           : N    # manual_conflict / public_body_conflict log lines
  lock_missed      : N
  errored          : N
  api_calls        : N
  duration         : Xs
```

The `inline_inconclusive` and `warned` counters are the operational
signal that something needs human attention. Non-zero values in those
fields are the closest analogue to the old "queue grew by N today"
metric — but they surface inline in the sweep summary rather than as a
silent table growing in the background.

## Testing strategy (TDD)

The decision logic is non-trivial and easy to break silently — a
single missed branch could demote a `manual` row or swallow a
legitimate promotion. The fix is to keep the decision function **pure**
(no I/O, no DB, no CH calls) and drive it with `bun:test` cases that
enumerate every branch in the rank table.

### Code split for testability

```text
apps/web/src/lib/phase5/
  decide.ts                pure: (existing, proposed) → DecideResult
                           no imports from db, fs, fetch, or resolveOneSponsor

  rank.ts                  pure: rank(matchMethod) → number
                           plus the terminal-peer predicates

  score-candidate.ts       pure: (candidate, sponsor, existing) → number
                           the inline scorer; no I/O

  route-type-compat.ts     pure data table: HmrcRoute → Set<CHCompanyType>

  sweep.ts                 orchestration: selects tier rows, calls
                           resolveOneSponsor (injected), calls decide,
                           dispatches to applyPromotion / bumpVerifiedAt /
                           inline-scorer flow (deps injected)

apps/web/scripts/
  phase5-sweep.ts                  thin CLI: parses --tier flag, wires
                                   real db / fetchApi / upsertProfile
                                   into sweep.ts

  resolve-same-rank-queue.ts       one-shot: drains the existing 140
                                   queue rows using the same scorer,
                                   then is deleted
```

`decide.ts` and `score-candidate.ts` are both unit-test surfaces. `sweep.ts`
is integration — mock the injected functions (`resolveSponsor`,
`applyPromotion`, `bumpVerifiedAt`, `getProfile`, `lookupHmrcSponsor`)
and assert dispatch + arguments.

### What to test (`decide.test.ts`)

One `describe` per rule in the decision table; one `test` per
representative case. Every test is `expect(decide(existing,
proposed)).toEqual({ action: '...', reason?: '...' })`.

```text
describe('rule 1: human_review never overwrites')
  proposed.verdict = human_review, existing = anything → bump

describe('rule 2: manual is sacred')
  existing = manual:X, proposed verifies same X     → bump
  existing = manual:X, proposed verifies different Y → log_and_bump('manual_conflict')
  existing = manual:X, proposed = no_match           → log_and_bump('manual_conflict')
  existing = manual:X, proposed = public_body        → log_and_bump('manual_conflict')

describe('rule 3: public_body terminal peer')
  existing = public_body, proposed = public_body                → bump
  existing = public_body, proposed = verified                   → log_and_bump('public_body_conflict')
  existing = public_body, proposed = no_match                   → bump (via rank fallback: public_body→1, no_match→0)
  existing = verified,    proposed = public_body                → log_and_bump('public_body_conflict')
  existing = no_match,    proposed = public_body                → update (rank 0 → terminal: promote)
  # ↑ debatable — see "open test cases" below

describe('rule 4: rank promotion')
  existing = no_match,                proposed = exact         → update
  existing = no_match,                proposed = token_sim     → update
  existing = token_sim,               proposed = exact         → update
  existing = previous_name,           proposed = exact         → update
  existing = token_sim,               proposed = previous_name → update

describe('rule 5: rank demotion rejected')
  existing = exact,         proposed = token_sim     → bump
  existing = exact,         proposed = previous_name → bump
  existing = previous_name, proposed = token_sim     → bump
  existing = exact,         proposed = no_match      → bump
  existing = token_sim,     proposed = no_match      → bump

describe('rule 6: same rank')
  existing = exact:X,      proposed = exact:X      → bump
  existing = exact:X,      proposed = exact:Y      → inline_score
  existing = no_match,     proposed = no_match     → bump
  existing = token_sim:X,  proposed = token_sim:Y  → inline_score
  existing = token_sim:X·0.85, proposed = token_sim:X·0.92 → bump
                                                   # same number, score wobble does NOT trigger inline_score
```

### What to test (`score-candidate.test.ts`)

The scorer is pure too — pass fixture profiles in, assert numeric output.

```text
describe('hard gate: routeTypeCompatible')
  Charity Worker + private-limited-company candidate    → -Infinity
  Charity Worker + charitable-incorporated-organisation → finite score
  Skilled Worker + private-limited-company              → finite score

describe('succession evidence')
  existing.name in candidate.previous_company_names     → +5 vs without

describe('locality match')
  candidate.locality == sponsor.town_city               → +3
  candidate.postcode_area == sponsor.postcode_area      → +2

describe('status weighting')
  candidate.status == 'active'                          → +1
  candidate.status == 'dissolved'                       → -2
  candidate.status == 'liquidation'                     → -2

describe('AsiaLink regression fixture')
  HMRC: Northwich, route=Charity Worker
  existing (CE006188, CIO, no address)                  → finite
  proposed (16920968, private Ltd, Manchester)          → -Infinity (hard gate)
  → existing wins by infinity-margin → bump
```

Open test cases (decisions to lock in via the test, not the doc):

- `existing = no_match` + `proposed = public_body` — promotion or
  conflict? The current pseudo says rule 3's XOR catches it as
  `public_body_conflict`. Probably wrong: a `no_match` row has zero
  signal to defend, and `public_body` is a stronger statement than
  `no_match`. **Decide via test.**
- `existing = human_review` (the 196 deliberate skips) +
  `proposed = verified` — should sweep promote, or always defer? Doc
  says rule 1 only governs *new* `human_review` verdicts; an
  *existing* `human_review` row falls through to the rank ladder where
  rank 1 < rank 2/3/4 → promote. Worth a test that pins this.

### Integration tests (`sweep.test.ts`)

Mock the four injected functions and assert dispatch + arguments.

```text
test('verified row passes through resolveSponsor and dispatches update')
  resolveSponsor returns verified
  expect(applyPromotion).toHaveBeenCalledWith(row, proposed, "phase5_sweep_no_match")
  expect(bumpVerifiedAt).not.toHaveBeenCalled()

test('lock-missed promotion still increments lock_missed counter')
  applyPromotion returns { ok: false, reason: 'lock_missed' }
  expect(summary.lock_missed).toBe(1)
  expect(summary.updated).toBe(0)

test('log_and_bump rows increment warned counter and bump verified_at')
  decide returns { action: 'log_and_bump', reason: 'manual_conflict' }
  expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('manual_conflict'))
  expect(bumpVerifiedAt).toHaveBeenCalled()
  expect(summary.warned).toBe(1)

test('inline_score dispatches to applyPromotion when proposed wins by MARGIN')
  decide returns { action: 'inline_score' }
  scoreCandidate stubbed: existing=2, proposed=7, MARGIN=3
  expect(applyPromotion).toHaveBeenCalled()
  expect(summary.inline_resolved).toBe(1)

test('inline_score bumps when existing wins by MARGIN')
  scoreCandidate stubbed: existing=7, proposed=2
  expect(applyPromotion).not.toHaveBeenCalled()
  expect(bumpVerifiedAt).toHaveBeenCalled()
  expect(summary.inline_resolved).toBe(1)

test('inline_score increments inconclusive counter when scores tie')
  scoreCandidate stubbed: existing=4, proposed=4
  expect(applyPromotion).not.toHaveBeenCalled()
  expect(bumpVerifiedAt).toHaveBeenCalled()
  expect(summary.inline_inconclusive).toBe(1)

test('CH errors are caught and counted, not thrown')
  resolveSponsor throws
  expect(summary.errored).toBe(1)
  # next row in batch still processed
```

### What is NOT unit-tested

- `applyPromotion`'s SQL CTE — exercised by an integration test
  against a Postgres test database (or skipped pending one),
  not Bun unit tests.
- `upsertProfile` — already tested transitively by Phase 3.
- `resolveOneSponsor` — its own existing test surface in
  `apps/web/src/lib/hmrc-ch/`.

### Run

```sh
bun test apps/web/src/lib/phase5/
```

CI gate: this directory must be in the lint/test workflow before
`phase5-sweep.ts` is wired into a GitHub Actions cron.
