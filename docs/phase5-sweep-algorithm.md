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
- `companies_house_profiles` — UPSERT when a `no_match` flips to `verified`
- `hmrc_company_mapping_review_queue` *(new)* — INSERT for ambiguous cases
- `hmrc_skilled_workers` — read for locality tiebreak

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

  print summary(updated, bumped, queued, lock_missed, errored)
```

## Per-row flow

```pseudo
process(row, changed_by):
  loc       = lookupLocality(row.organisation_name)
  proposed  = resolveOneSponsor(row.organisation_name, loc, fetchApi)
  # proposed.verdict ∈ {verified, public_body, no_match, human_review}

  action = decide(existing = row, proposed)

  match action:
    bump   → bumpVerifiedAt(row)
    update → applyPromotion(row, proposed, changed_by)
    queue  → enqueueReview(row, proposed, action.reason, changed_by)
             bumpVerifiedAt(row)   # so it doesn't re-queue every run
    no_op  → bumpVerifiedAt(row)
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
          return bump                       # human override re-confirmed
      return queue("manual_conflict")

  # 3. public_body is a terminal peer
  if existing.match_method == 'public_body' and proposed.verdict == 'public_body':
      return bump
  if existing.match_method == 'public_body' xor proposed.verdict == 'public_body':
      return queue("public_body_conflict")

  # 4. ranked comparison
  if rank(proposed) > rank(existing):  return update         # promote
  if rank(proposed) < rank(existing):  return bump           # reject demote

  # rank(proposed) == rank(existing)
  if proposed.company_number == existing.company_number:
      return bump
  return queue("same_rank_different_number")
```

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

## The queue (defer to human/agentic review)

```pseudo
enqueueReview(row, proposed, reason, changed_by):
  if exists(review_queue WHERE organisation_name = row.organisation_name
                           AND reason = reason
                           AND resolved_at IS NULL):
      return                          # idempotent across sweep cycles

  INSERT INTO hmrc_company_mapping_review_queue
    (organisation_name, reason,
     existing_company_number, existing_match_method, existing_match_score,
     proposed_company_number, proposed_match_method, proposed_match_score,
     proposed_query_used, ch_search_results_top5,
     detected_by)
  VALUES (...);
```

## DDL (single migration)

```sql
CREATE TABLE hmrc_company_mapping_review_queue (
  id                       serial PRIMARY KEY,
  organisation_name        text NOT NULL,
  reason                   varchar(40) NOT NULL,
    -- 'manual_conflict' | 'public_body_conflict' | 'same_rank_different_number'
  existing_company_number  varchar(20),
  existing_match_method    varchar(32),
  existing_match_score     numeric(4,3),
  proposed_company_number  varchar(20),
  proposed_match_method    varchar(32),
  proposed_match_score     numeric(4,3),
  proposed_query_used      text,
  ch_search_results_top5   jsonb,
  detected_by              varchar(100) NOT NULL,
  detected_at              timestamp NOT NULL DEFAULT now(),
  resolved_at              timestamp,
  resolved_by              varchar(100),
  resolution               varchar(40)
);

CREATE INDEX idx_review_queue_unresolved
  ON hmrc_company_mapping_review_queue (detected_at)
  WHERE resolved_at IS NULL;

CREATE INDEX idx_mapping_method_verified
  ON hmrc_company_mapping (match_method, verified_at NULLS FIRST);
```

No changes to `hmrc_company_mapping`, `hmrc_company_mapping_audit`, or
`companies_house_profiles` — those already have everything Phase 5
needs.

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
  selected     : N
  updated      : N
  bumped       : N
  queued       : N
  lock_missed  : N
  errored      : N
  api_calls    : N
  duration     : Xs
```

## Testing strategy (TDD)

The decision logic is non-trivial and easy to break silently — a
single missed branch could demote a `manual` row, swallow a
legitimate promotion, or stack duplicate review-queue entries. The
fix is to keep the decision function **pure** (no I/O, no DB, no CH
calls) and drive it with `bun:test` cases that enumerate every
branch in the rank table.

### Code split for testability

```text
apps/web/src/lib/phase5/
  decide.ts          pure: (existing, proposed) → DecideResult
                     no imports from db, fs, fetch, or resolveOneSponsor

  rank.ts            pure: rank(matchMethod) → number
                     plus the terminal-peer predicates

  sweep.ts           orchestration: selects tier rows, calls
                     resolveOneSponsor (injected), calls decide,
                     dispatches to applyPromotion / bumpVerifiedAt /
                     enqueueReview (all injected as fns)

apps/web/scripts/
  phase5-sweep.ts    thin CLI: parses --tier flag, wires real db /
                     fetchApi / upsertProfile into sweep.ts
```

`decide.ts` is the unit-test surface. `sweep.ts` is integration —
mock the four injected functions (`resolveSponsor`, `applyPromotion`,
`bumpVerifiedAt`, `enqueueReview`) and assert it dispatches them in
the right shape.

### What to test (`decide.test.ts`)

One `describe` per rule in the decision table; one `test` per
representative case. Every test is `expect(decide(existing,
proposed)).toEqual({ action: '...', reason?: '...' })`.

```text
describe('rule 1: human_review never overwrites')
  proposed.verdict = human_review, existing = anything → bump

describe('rule 2: manual is sacred')
  existing = manual:X, proposed verifies same X     → bump
  existing = manual:X, proposed verifies different Y → queue manual_conflict
  existing = manual:X, proposed = no_match           → queue manual_conflict
  existing = manual:X, proposed = public_body        → queue manual_conflict

describe('rule 3: public_body terminal peer')
  existing = public_body, proposed = public_body                → bump
  existing = public_body, proposed = verified                   → queue public_body_conflict
  existing = verified,    proposed = public_body                → queue public_body_conflict
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
  existing = exact:X,      proposed = exact:Y      → queue same_rank_different_number
  existing = no_match,     proposed = no_match     → bump
  existing = token_sim:X,  proposed = token_sim:Y  → queue same_rank_different_number
  existing = token_sim:X·0.85, proposed = token_sim:X·0.92 → bump
                                                   # same number, score wobble doesn't queue
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

test('queued rows also bump verified_at to avoid re-queueing')
  decide returns { action: 'queue', reason: 'manual_conflict' }
  expect(enqueueReview).toHaveBeenCalled()
  expect(bumpVerifiedAt).toHaveBeenCalled()       # both, in that order

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
