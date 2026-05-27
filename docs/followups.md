# Followups

Tracked work that's been deferred or scoped out of the in-flight PR. Each
item has enough context to be picked up later without re-reading the full
session it came from.

---

## Phase 5 sweep — review queue residue

### Hand-review the 64 `drain_scorer_inconclusive` rows

**Status**: open. **Source**: 2026-05-27 drain.

After the one-shot drain, 64 queue rows landed as
`drain_scorer_inconclusive` — genuine ambiguities where the scorer's
confidence didn't clear `SCORE_MARGIN`. These need eyeball-on-CH review
to decide each case manually.

```sql
SELECT id, organisation_name, existing_company_number, proposed_company_number
  FROM hmrc_company_mapping_review_queue
 WHERE resolution = 'drain_scorer_inconclusive'
 ORDER BY organisation_name;
```

**Done when**: every inconclusive row has either had its mapping
manually updated (via direct `UPDATE hmrc_company_mapping`) or been
explicitly accepted as "incumbent stays" with a note in the resolution
column. Then proceed to "Drop the queue table" below.

### Drop the queue table

**Status**: blocked on the above. **Source**: doc says deferred until
inconclusives are resolved.

Once the 64 inconclusive rows are reviewed:

```sql
DROP TABLE hmrc_company_mapping_review_queue;
```

Plus remove the schema definition in `packages/db/src/schema.ts` (lines
~118-157). Live sweep no longer enqueues, so the table is read-only
artefact at this point. Audit table retains the full history.

The drain scripts ([drain-review-queue.ts](../apps/web/scripts/drain-review-queue.ts)
and [hydrate-queue-proposed-profiles.ts](../apps/web/scripts/hydrate-queue-proposed-profiles.ts))
should also be deleted at the same time.

---

## Phase 5 sweep — resolver gaps

### `resolveOneSponsor` doesn't surface BR (UK Establishment) records when an FC parent exists

**Status**: open. **Severity**: medium — produces sub-optimal mappings
silently. **Source**: 2026-05-27 drain investigation, ANZ case.

For organisations that are foreign companies with a UK establishment
(e.g. Australia & New Zealand Banking Group), CH has 3 records:
- `BR…` — UK Establishment (the right HMRC mapping)
- `FC…` — Foreign Company parent
- `OE…` — Registered Overseas Entity (property register; not a sponsor)

`resolveOneSponsor` was observed to surface only OE and FC as candidates
for ANZ, never BR000580. So the queue row was `OE → FC`, the drain
swapped to FC, and we never reached the optimum BR mapping.

**Done when**: `resolveOneSponsor` proposes the BR record (when one
exists in CH search results) for foreign-parent sponsors. Verify by
re-running the resolver on ANZ and confirming `BR000580` appears in the
candidates list. The fix likely lives in the Tier-B / candidate-ranking
logic — investigate
[apps/web/src/lib/hmrc-ch/resolve-sponsor.ts](../apps/web/src/lib/hmrc-ch/resolve-sponsor.ts)
and [pipeline.ts](../apps/web/src/lib/hmrc-ch/pipeline.ts).

### Audit and manually correct sub-optimal OE→FC swaps from the drain

**Status**: open. **Source**: same as above.

The 2026-05-27 drain swapped 50 rows. At least 2 of the 5 OE→FC swaps
from spot-check #1 likely have a hidden BR record that would be a
better mapping:

| Org | Current mapping | Suspected BR |
|---|---|---|
| Australia & New Zealand Banking Group Ltd | FC009351 | **BR000580** (confirmed exists on CH) |
| All Nippon Airways Co Ltd | FC031261 | likely (large UK office) |
| AAAS Science International inc | FC017250 | probably not (small US firm) |
| Brook House Guernsey Ltd | FC025924 | probably not (Guernsey-only) |
| Anglican Missionary Congregations | 11941787 (CIC) | not BR-related (CIO/CIC pattern) |

There may be more cases in the wider 50 swaps. Query candidates with:

```sql
SELECT m.organisation_name, m.company_number, p.company_type, p.locality
  FROM hmrc_company_mapping m
  JOIN companies_house_profiles p ON p.company_number = m.company_number
  JOIN hmrc_company_mapping_audit a
    ON a.organisation_name = m.organisation_name
   AND a.changed_by = 'drain_scorer'
 WHERE p.company_type = 'oversea-company';
```

For each row, search CH for a BR record. If one exists, manually update
the mapping. Easier to do *after* the resolver gap is fixed so we're not
chasing the symptom — but operationally fine to do either way.

**Done when**: the rows above have been audited, BR mappings applied
where they exist, and any patterns surfaced from the audit are noted
(e.g., "X% of FC mappings have hidden BR records").

---

## Phase 5 sweep — GitHub Actions workflows

### Add `public_body` monthly workflow

**Status**: open. **Source**: gap analysis, 2026-05-27.

Three GitHub Actions workflows exist:
- `phase5-sweep-no-match.yaml` — daily, 4000 rows
- `phase5-sweep-non-exact.yaml` — 2×/week, 3000 rows
- `phase5-sweep-exact.yaml` — daily, 1500 rows

The `public_body` tier (monthly, 500 rows) per the doc is not yet
deployed. Add a new workflow at `.github/workflows/phase5-sweep-public-body.yaml`
following the same pattern as the others, using the
[run-phase5-sweep](../.github/actions/run-phase5-sweep/action.yaml)
custom action with `tier: public_body`.

**Done when**: workflow file exists, dispatches monthly (e.g.
`0 3 1 * *`), passes a manual `workflow_dispatch` run with `--dry-run`.
