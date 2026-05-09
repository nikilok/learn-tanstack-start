# Review queue resolver — agentic mechanism

Status: **proposed (2026-05-09).** No code yet. Companion to
[hmrc-ch-mapping-fix.md](hmrc-ch-mapping-fix.md) and
[phase5-sweep-algorithm.md](phase5-sweep-algorithm.md).

Phase 5's sweep enqueues rows into `hmrc_company_mapping_review_queue`
when its `decide()` step lands in `manual_conflict`,
`public_body_conflict`, or `same_rank_different_number`. The sweep is
append-only into that queue — it never resolves anything. As of
2026-05-09 the unresolved backlog is **96 rows** and growing with every
sweep cycle.

This doc specifies the consumer: a daily GitHub Actions cron that drains
the queue by verifying proposed mappings against the live Companies
House API, applying the verified ones via `applyPromotion`, and closing
the queue rows.

---

## Why a separate mechanism (not part of Phase 5)

Phase 5's per-row budget is a single CH search call. The cases that
land in the queue are exactly the ones where a single search wasn't
decisive — so re-running the same logic with the same budget produces
the same enqueue. Resolving these requires *more* signal: fetch the
existing CH profile, fetch the proposed CH profile, compare
`previous_company_names` / addresses / status, and weigh trade-offs the
deterministic ladder can't.

That's what a model is good at. The Phase 5 sweep stays cheap and
deterministic; the resolver is the slower, smarter, narrower path.

---

## What runs

One script: `apps/web/scripts/resolve-review-queue.ts`. Invoked daily
from a GitHub Actions cron with no flags. Default behaviour: drain
**every** unresolved row in the queue, oldest first.

```text
Daily, no per-run cap, oldest unresolved first.
```

At ~96 rows × 2 CH fetches × ~550ms pacing the full backlog runs in
~2 minutes plus model latency — well under any GH Actions or CH rate
limits (CH allows 600 req / 5-min window).

### First-run safety cap (temporary)

Before steady-state, the script accepts a `--max-rows=N` flag. Use it
for the first one or two runs to limit blast radius if the agent
miscalibrates: at most N wrong mappings get written before a human
inspects the audit and decides whether to continue. Suggested ramp:

```text
Run 1   --max-rows=10   (manually inspect audit + queue outcomes)
Run 2   --max-rows=30   (if Run 1 looks clean)
Run 3+  no flag         (drain everything; this is the steady state)
```

The flag exists for cautious rollouts only. Once removed from the
GH Actions invocation, it stays removed — there is no production
reason to cap, given Phase 5's inflow rate of 1-3 rows/day and the
fail-closed `low_confidence` default that prevents writes on
ambiguity.

---

## Tables touched

| Table | Access |
|---|---|
| `hmrc_company_mapping_review_queue` | SELECT (claim N rows), UPDATE (close them) |
| `hmrc_company_mapping` | Read live state via `applyPromotion`'s CTE; UPDATE on `verified` verdict |
| `hmrc_company_mapping_audit` | INSERT (one row per `applyPromotion` write) |
| `companies_house_profiles` | UPSERT when the agent fetches and verifies a proposed profile not yet in our cache |

The script never writes to the queue table directly outside of closing
rows. The queue is owned by Phase 5; this script is its consumer, not
a co-writer.

---

## Top-level flow

```pseudo
resolve_review_queue():
  rows = SELECT * FROM hmrc_company_mapping_review_queue
         WHERE resolved_at IS NULL
         ORDER BY detected_at ASC
         [LIMIT max_rows]               # only set during cautious rollout
         FOR UPDATE SKIP LOCKED         # safe under concurrent runs

  for row in rows:
    process(row)
    sleep(550ms)                       # keep CH API under 2 req/sec
                                       # at 2 fetches/row average

  print summary(verified, declined, already_applied,
                superseded, lock_missed, errored)
```

`SKIP LOCKED` matters. Manual triggers can overlap a scheduled run; we
don't want two agents fighting for the same row. The locked rows simply
fall to the next worker.

---

## Per-row flow

```pseudo
process(queue_row):
  # 1. Read live mapping — never trust the queue's stored snapshot
  live = SELECT * FROM hmrc_company_mapping
         WHERE organisation_name = queue_row.organisation_name

  # 2. Reconciliation: did something already converge?
  if live.company_number == queue_row.proposed_company_number:
      close(queue_row, resolution = 'already_applied')
      return

  if live.company_number != queue_row.existing_company_number:
      # The world moved while this row sat in the queue. The agent
      # shouldn't act on a stale `existing` snapshot.
      close(queue_row, resolution = 'superseded')
      return

  # 3. Fetch both CH profiles
  existing_profile = ch_get_profile(live.company_number)        # may be 404
  proposed_profile = ch_get_profile(queue_row.proposed_company_number)

  # 4. Hand to the model with strict JSON contract (see Verdict schema)
  verdict = ask_model(queue_row, live, existing_profile, proposed_profile)

  # 5. Act on verdict
  match verdict.verdict:
    'verified' →
        result = applyPromotion(live, proposed_from(verdict), changed_by='review_queue_agent')
        if result.ok:
            upsert_profile(proposed_profile)
            close(queue_row, resolution = 'verified')
        else:  # lock_missed
            # Another writer changed verified_at between our SELECT and
            # applyPromotion. Leave the queue row open; next run picks
            # it up against the fresh state.
            return

    'rejected' →
        # Agent affirmatively says proposed is wrong. Existing stays.
        close(queue_row, resolution = 'rejected')

    'low_confidence' →
        close(queue_row, resolution = 'agent_declined')
        # Phase 5's partial unique index allows a future sweep to
        # re-enqueue if the ambiguity persists. See "Re-enqueue loop"
        # below for the open question on backoff.
```

The script never writes `applyPromotion`'s contract — it calls it
unchanged. `applyPromotion` continues to know nothing about the
review queue. Its single responsibility (atomic mapping UPDATE +
audit INSERT + conditional profile UPSERT) is preserved. The queue
row update is a *separate* statement issued by this script, after
`applyPromotion` returned `ok: true`.

---

## The two-statement gap (mapping + queue close)

`applyPromotion` is one atomic CTE. Closing the queue row is a
*second* statement. If the script crashes between the two, the
mapping is promoted but the queue row stays open.

This is acceptable because the next run's reconciliation step (#2
above) detects exactly this state: `live.company_number ==
queue_row.proposed_company_number` → close with
`resolution = 'already_applied'`. The audit row from the first run
already captures what changed; the second run is just bookkeeping.

This is the explicit design trade for keeping `applyPromotion`'s
single responsibility. The alternative — extending the CTE to also
update the queue row — was considered and rejected: it would couple
two domains (live mapping vs. backlog tracking) that have different
write paths and different consumers.

---

## Verdict schema (strict, fail-closed)

The model output must parse as JSON against this exact shape:

```ts
type Verdict =
  | { verdict: 'verified';      reasoning: string }   // ≤ 500 chars
  | { verdict: 'rejected';      reasoning: string }
  | { verdict: 'low_confidence'; reasoning: string };
```

- Any other value, missing field, or extra key → coerce to
  `low_confidence` with `reasoning = 'invalid_model_output'`. No
  silent salvage attempts.
- `reasoning` is capped at 500 chars and stripped of any prompt
  fragments before storage (defence against the model echoing its
  instructions back).
- `verified` does **not** carry a `company_number` from the model —
  the proposed number is taken from the queue row, not generated by
  the model. The model's job is to confirm or refute, not propose.
  This collapses the prompt-injection attack surface to "make the
  model say yes when it shouldn't" rather than "make the model
  emit an arbitrary company number".

`low_confidence` is the fail-closed default. It is impossible for an
unparseable response to write to `hmrc_company_mapping`.

---

## What "good" means — verification criteria

The prompt asks the model to weigh, in order:

1. **`previous_company_names` containment.** Does the proposed
   profile's `previous_company_names` list contain the HMRC
   organisation name (case-insensitive, normalised)? Strongest signal.
2. **Existing profile no longer matches.** Is the existing profile
   `dissolved`, `liquidation`, redirected, or does its current name no
   longer match the HMRC name? Justifies replacement even without (1).
3. **Address overlap.** Do existing and proposed share registered
   address line/postcode? Reasonable signal that proposed is the
   continuation of existing.
4. **Active status.** Is the proposed profile `active`? Required for
   `verified`; an inactive proposed profile is automatic
   `low_confidence` regardless of name signal.

The AsiaLink case from the brief — `CE006188` → `16920968` — passes
(1) + (2) + (4): proposed has AsiaLink in its previous names, existing
is dissolved, proposed is active.

A case that fails (1)+(2)+(3) and only has token-similar names →
`rejected`. A case where the model can't tell from CH data alone →
`low_confidence`.

---

## Resolution values (`hmrc_company_mapping_review_queue.resolution`)

| Value | Meaning | Mapping write? |
|---|---|---|
| `verified` | Agent confirmed proposed; `applyPromotion` succeeded | Yes |
| `rejected` | Agent says proposed is wrong; existing stays | No |
| `agent_declined` | Model returned `low_confidence` or invalid JSON | No |
| `already_applied` | Reconciliation: live mapping already matches proposed | No (already done) |
| `superseded` | Reconciliation: live mapping no longer matches the queue's `existing_company_number` snapshot | No |

`changed_by` for the audit row is `review_queue_agent`. The queue
row's `resolved_by` is the same. Distinguishable from
`phase5_sweep_*` and `phase1_apply` for downstream filtering.

---

## Why no Playwright

The sweep already cached `ch_search_results_top5` when it enqueued.
Both the existing and proposed CH numbers are known. The
`/company/{number}` JSON endpoint returns everything the model needs:
`company_status`, `previous_company_names`, `registered_office_address`,
`date_of_creation`, `date_of_cessation`. This is structurally richer
than scraping the HTML page — Playwright was the right shape for
[find-hmrc-csv-url.ts](../apps/web/scripts/find-hmrc-csv-url.ts)
because gov.uk has no equivalent JSON, but Companies House does.

If a future case genuinely requires reading something CH only renders
on its HTML page (filings tab, officer history), add Playwright then.
Don't preemptively pay the cost.

---

## Open questions

### Re-enqueue loop on `agent_declined`

Phase 5's partial unique index is on unresolved rows. So a closed
`agent_declined` doesn't block Phase 5 from re-enqueueing the same
`(organisation_name, reason)` on its next sweep, the agent declines
again, and we burn a model call per cycle for no progress.

Three possible mitigations:

- **Backoff window in the resolver.** Skip rows whose previous
  `agent_declined` resolution is more recent than (say) 30 days.
  Implementation: `WHERE NOT EXISTS (SELECT 1 FROM ... WHERE
  organisation_name = ... AND resolution = 'agent_declined' AND
  resolved_at > now() - interval '30 days')` joined to the queue
  SELECT.
- **Track last-declined on the mapping row.** Add a column to
  `hmrc_company_mapping` so Phase 5 can skip enqueueing if recently
  declined. Pollutes the mapping schema with resolver state.
- **Accept the cost.** Model calls at small-model rates are cheap;
  burning ~$1/month on duplicate declines may be fine.

Recommend starting with no mitigation, measuring re-enqueue rate
after one month, then deciding.

### Human approval gate (deliberately skipped)

[hmrc-ch-mapping-fix.md:1163](hmrc-ch-mapping-fix.md#L1163) scoped
Phase 4 with a human approve/reject step before the agent's verdicts
hit the live mapping. This design skips that and writes directly. The
trade:

- The queue rows are a *much smaller* and more structured input than
  Phase 4 imagined (existing CH number + proposed CH number both
  known; the model is confirming, not searching).
- The fail-closed `low_confidence` default ensures no write happens
  on ambiguity.
- The audit table captures every write with `changed_by =
  'review_queue_agent'`, so reverting a bad batch is a SQL operation
  not an investigation.

If a wrong-write incident happens, escalate to: agent writes go to a
staging column instead, with a separate `apply` script that requires
a one-key human gate. Same shape as `phase4-apply.ts` was originally
scoped.

### Throughput vs. inflow

With no cap in steady state, inflow is the only relevant rate. Phase
5 currently enqueues ~1-3 rows/day; the daily cron handles that
trivially. Watch `SELECT count(*) FROM hmrc_company_mapping_review_queue
WHERE resolved_at IS NULL` weekly — sustained growth would mean the
agent is declining most rows (calibration issue) rather than that the
cap is too low.

---

## What this design preserves

- `applyPromotion` continues to know nothing about the queue. Its
  contract (atomic UPDATE + audit + conditional profile UPSERT) is
  unchanged. A future caller — say, an admin UI for manual
  corrections — can use the same function without inheriting any
  queue assumptions.
- Phase 5's enqueue path is unchanged. It writes; this script reads
  and closes. The two pipelines never share state beyond the queue
  table itself.
- The resolver is fail-closed at every layer: lock missed → row
  stays open; invalid model output → `low_confidence`; reconciliation
  mismatch → close without write; CH 404 on proposed → `low_confidence`.

---

## Next step

Implement `apps/web/scripts/resolve-review-queue.ts` against this
design and a sibling `.github/workflows/resolve-review-queue.yml`
cron. Reuse the model-call shape from
[find-hmrc-csv-url.ts](../apps/web/scripts/find-hmrc-csv-url.ts) for
the JSON-mode contract, but constrain the verdict schema as specified
above.
