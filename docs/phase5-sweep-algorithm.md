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
for a separate resolver to process. As of 2026-05-19 that queue has 190
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
threshold (`SCORE_MARGIN`) keeps the row at status quo (bump) with a
warning rather than committing a wrong promotion.

### `scoreCandidate` — pure sponsor-fit scorer

```pseudo
scoreCandidate(candidate, sponsor):
  # Hard gate — domain rule that's never wrong
  if not routeTypeCompatible(sponsor.route, candidate.company_type):
      return -infinity

  score = 0

  # HMRC locality match
  if candidate.locality == sponsor.town_city:        score += 3
  if candidate.postcode_area == sponsor.postcode_area: score += 2

  # Status
  if candidate.status == 'active':                   score += 1
  if candidate.status in ('dissolved', 'liquidation'): score -= 2

  return score
```

Purely about "how well does this CH candidate fit this HMRC sponsor?"
No I/O, no DB, no fetches, no comparison to a baseline. Unit-testable
with a single fixture profile + sponsor. Score range: `-Infinity`
(route-type-incompatible) to `+6` (active + matching locality +
matching postcode area).

### `compareForInlineResolution` — pairwise decision

The pairwise decision (existing vs proposed) lives in a small helper
that both the live sweep and the drain script call. Single source of
truth for the comparison logic — there's no second implementation to
drift out of sync.

```pseudo
STATUS_QUO_BONUS = 1
SCORE_MARGIN     = 3

compareForInlineResolution(existing, proposed, sponsor):
  s_e = scoreCandidate(existing, sponsor) + STATUS_QUO_BONUS
  s_p = scoreCandidate(proposed, sponsor)

  # Succession evidence — directional and explicit
  if canonical(proposed.name) in existing.previous_company_names:
      s_e += 5    # proposed was previously known as existing (rare reverse)
  if canonical(existing.name) in proposed.previous_company_names:
      s_p += 5    # existing was renamed to proposed (the common case)

  if s_p > s_e + SCORE_MARGIN: return { s_e, s_p, action: 'promote' }
  if s_e > s_p + SCORE_MARGIN: return { s_e, s_p, action: 'keep' }
  return { s_e, s_p, action: 'inconclusive' }
```

Why split this out from `scoreCandidate`:

- The +1 `STATUS_QUO_BONUS` is an explicit, named bias toward the
  incumbent — tunable separately from sponsor-fit features. In the
  earlier 3-arg design this was buried as a "same `company_type` as
  existing" feature that masqueraded as content scoring; between two
  *different* CH companies, sharing a `company_type` carries almost no
  signal anyway (most UK firms are `private-limited-company`).
- Succession is **symmetric**: both "existing renamed to proposed" and
  the rarer reverse are checked. Forces the reader to think about both
  directions instead of hiding the asymmetry inside the scorer.
- `scoreCandidate` itself stays pure on sponsor-fit features only,
  testable with a single profile + sponsor fixture without constructing
  a baseline parameter.

### Dispatch in the sweep orchestrator

```pseudo
on action == 'inline_score':
  sponsor          = lookupHmrcSponsor(row.organisation_name)
  existing_profile = getProfile(row.company_number)         # usually local
  proposed_profile = proposed.profile                       # already loaded

  { s_e, s_p, action } = compareForInlineResolution(
                            existing_profile, proposed_profile, sponsor)

  match action:
    promote      → applyPromotion(row, proposed, changed_by)
    keep         → bumpVerifiedAt(row)
    inconclusive → console.warn(`inline_score inconclusive for ${row.organisation_name}`)
                   bumpVerifiedAt(row)    # surfaces in sweep summary's `warned`
```

`SCORE_MARGIN = 3` is conservative — at least one strong signal of
difference needed. `STATUS_QUO_BONUS = 1` codifies the bias toward the
incumbent. Both tunable as the route-type compat table and feature set
evolve.

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

### Migration of the existing 190 rows

The drain uses a one-shot CLI script with two pluggable strategies.
Both share profile hydration and the audit-trail mechanism; they differ
only in the per-row decision.

- **Trust strategy** — every queue row is swapped to its
  `proposed_company_number`. Based on manual verification of the data,
  the resolver's proposed picks are consistently the right entity for
  the 190 cases. No scoring, no inconclusive bucket. Resolution column
  records `drain_trust_swap` so the strategy stays recoverable from the
  audit trail.

- **Scorer strategy** — runs `compareForInlineResolution` (the same
  helper the live sweep uses) per row and dispatches to swap / keep /
  inconclusive. Resolution column records `drain_scorer_swap`,
  `drain_scorer_keep`, or `drain_scorer_inconclusive`.

Both strategies write through `applyPromotion` for the swap, so the
optimistic lock on `verified_at` and the audit-INSERT side-effect are
identical to a normal sweep promotion. `changed_by` in audit is
`'drain_trust'` or `'drain_scorer'` — distinguishable forever.

#### Step A — hydrate missing proposed profiles

One-shot script at `apps/web/scripts/hydrate-queue-proposed-profiles.ts`.

```pseudo
to_fetch = SELECT DISTINCT q.proposed_company_number
           FROM hmrc_company_mapping_review_queue q
           LEFT JOIN companies_house_profiles p
                  ON p.company_number = q.proposed_company_number
           WHERE q.resolved_at IS NULL
             AND p.company_number IS NULL

for number in to_fetch:
    profile = fetchProfile(number)
    upsertProfile(profile)
    sleep(550ms)        # ~2 req/sec; well under CH 600/5min limit
```

~183 calls, ~92s wall. Idempotent — re-runs are no-ops because the
LEFT JOIN already excludes cached rows. If a number 404s, log and
continue — that queue row falls into the orphan bucket in step B.

After this step every queue row has both profiles available locally;
remaining steps make zero CH calls.

#### Step B — dry-run both strategies, emit comparison

```sh
bun apps/web/scripts/drain-review-queue.ts --compare
```

Runs both `trust` and `scorer` `decide()` over all unresolved queue
rows (no writes) and emits a markdown report at
`docs/phase5-drain-comparison.md` sorted disagreement-first:

```text
| org | e_num → p_num | trust  | scorer       | s_e | s_p | reason            |
|-----|---------------|--------|--------------|-----|-----|-------------------|
| ... | ... → ...     | swap   | keep         |   8 |   3 | scorer disagrees  |
| ... | ... → ...     | swap   | inconclusive |   4 |   5 | scorer uncertain  |
| ... | ... → ...     | swap   | swap         |   2 |   9 | both agree        |
| ... | ... → ...     | swap   | orphan       |  —  |  —  | no sponsor record |
```

Eyeball the report. Rows where strategies agree are uncontroversial;
the disagreements are where the decision matters. Use this output to
choose which strategy to actually run in step C.

#### Step C — apply the chosen strategy

```sh
bun drain-review-queue.ts --strategy=trust  --apply
bun drain-review-queue.ts --strategy=scorer --apply
bun drain-review-queue.ts --strategy=scorer --apply --limit=10  # partial
```

Per row:

```pseudo
mapping = SELECT * FROM hmrc_company_mapping
          WHERE organisation_name = row.organisation_name
if mapping.company_number != row.existing_company_number:
    log("queue row stale — mapping moved on since enqueue"); skip

existing = getProfile(mapping.company_number)
proposed = getProfile(row.proposed_company_number)
sponsor  = lookupHmrcSponsor(row.organisation_name)

{ action, reason } = strategy.decide(row, existing, proposed, sponsor)

match action:
  swap         → applyPromotion(mapping,
                                syntheticResolveResult(row, proposed),
                                changed_by = `drain_${strategy.name}`)
                 markResolved(row, `drain_${strategy.name}_swap`, reason)
  keep         → markResolved(row, `drain_${strategy.name}_keep`, reason)
  inconclusive → markResolved(row, `drain_${strategy.name}_inconclusive`, reason)
```

`--limit=N` enables partial drains for safety (e.g.
`--strategy=scorer --apply --limit=10` → spot-check the 10 resolved
rows in the audit table → re-run for the rest).

#### Step D — hand-resolve residue, then drop the table

Only the scorer strategy can produce residue (`drain_scorer_keep` and
`drain_scorer_inconclusive` rows that an operator may want to revisit).
Dump those to `docs/phase5-drain-residue.md` and resolve by inspection.
The trust strategy leaves zero residue.

Once the queue is fully drained, proceed to "Dropping the table" below.

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

  score-candidate.ts       pure: (candidate, sponsor) → number
                           sponsor-fit scorer only; no I/O, no comparison

  compare-candidates.ts    pure: (existing, proposed, sponsor) →
                           { s_e, s_p, action }; calls scoreCandidate,
                           adds status-quo bias and succession checks;
                           single source of truth for the inline
                           pairwise decision (live sweep + drain both
                           call this)

  route-type-compat.ts     pure data table: HmrcRoute → Set<CHCompanyType>

  drain-strategies.ts      pure: DrainStrategy interface plus `trust`
                           and `scorer` implementations. Scorer strategy
                           calls compareForInlineResolution.

  sweep.ts                 orchestration: selects tier rows, calls
                           resolveOneSponsor (injected), calls decide,
                           dispatches to applyPromotion / bumpVerifiedAt /
                           inline-scorer flow (deps injected)

apps/web/scripts/
  phase5-sweep.ts                       thin CLI: parses --tier flag,
                                        wires real db / fetchApi /
                                        upsertProfile into sweep.ts

  hydrate-queue-proposed-profiles.ts    one-shot (Step A of the drain):
                                        fetches the ~183 missing proposed
                                        profiles from CH and UPSERTs them
                                        into companies_house_profiles.
                                        Delete after the queue table is
                                        dropped.

  drain-review-queue.ts                 one-shot (Steps B+C of the drain):
                                        drains the 190 existing queue
                                        rows using a pluggable strategy.
                                        Modes: --strategy={trust,scorer},
                                        --dry-run / --apply / --compare,
                                        --limit=N. Delete after the
                                        queue table is dropped.
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

The scorer is pure: profile + sponsor → number. Tests sponsor-fit
features only. Pairwise comparison logic lives in
`compare-candidates.test.ts`.

```text
describe('hard gate: routeTypeCompatible')
  Charity Worker + private-limited-company candidate    → -Infinity
  Charity Worker + charitable-incorporated-organisation → finite score
  Skilled Worker + private-limited-company              → finite score

describe('locality match')
  candidate.locality == sponsor.town_city               → +3
  candidate.postcode_area == sponsor.postcode_area      → +2

describe('status weighting')
  candidate.status == 'active'                          → +1
  candidate.status == 'dissolved'                       → -2
  candidate.status == 'liquidation'                     → -2

describe('combined max')
  active + matching locality + matching postcode area   → +6
```

### What to test (`compare-candidates.test.ts`)

`compareForInlineResolution` takes two profiles + sponsor and returns
`{ s_e, s_p, action }`. Tests cover the status-quo bias, succession
evidence (both directions), and the `SCORE_MARGIN` threshold.

```text
describe('status-quo bias')
  identical existing & proposed (same sponsor-fit score)
    → action='inconclusive'  (bias of +1 is below SCORE_MARGIN=3,
                              so neither side wins by the threshold;
                              status quo holds via the inconclusive
                              path. Lock the expected behaviour here.)

describe('succession evidence — forward (the common case)')
  canonical(existing.name) in proposed.previous_company_names
    → s_p += 5, expect action='promote' when other features tie

describe('succession evidence — reverse (rare)')
  canonical(proposed.name) in existing.previous_company_names
    → s_e += 5, expect action='keep'

describe('SCORE_MARGIN threshold')
  s_p - s_e > SCORE_MARGIN     → action='promote'
  s_e - s_p > SCORE_MARGIN     → action='keep'
  |s_p - s_e| ≤ SCORE_MARGIN   → action='inconclusive'

describe('hard gate plumbing through')
  scoreCandidate returns -Infinity for existing → s_e = -Infinity + bias
    = -Infinity, so any finite s_p wins                → action='promote'

describe('AsiaLink regression fixture')
  HMRC: Northwich, route=Charity Worker
  existing: CE006188, CIO, no address                   → s_e finite
  proposed: 16920968, private Ltd, Manchester           → s_p = -Infinity
                                                          (route-type hard gate)
  → action='keep' (existing wins by infinity-margin)
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

test('inline_score dispatches to applyPromotion when scorer says promote')
  decide returns { action: 'inline_score' }
  compareForInlineResolution stubbed: { s_e: 2, s_p: 7, action: 'promote' }
  expect(applyPromotion).toHaveBeenCalled()
  expect(summary.inline_resolved).toBe(1)

test('inline_score bumps when scorer says keep')
  compareForInlineResolution stubbed: { s_e: 7, s_p: 2, action: 'keep' }
  expect(applyPromotion).not.toHaveBeenCalled()
  expect(bumpVerifiedAt).toHaveBeenCalled()
  expect(summary.inline_resolved).toBe(1)

test('inline_score increments inconclusive counter when scorer says inconclusive')
  compareForInlineResolution stubbed: { s_e: 4, s_p: 4, action: 'inconclusive' }
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
