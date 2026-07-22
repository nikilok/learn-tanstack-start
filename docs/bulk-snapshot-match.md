# Bulk snapshot matcher

Monthly offline recovery pass for the HMRC↔CH `no_match` backlog. Companion
to [phase5-sweep-algorithm.md](phase5-sweep-algorithm.md) (the nightly
API-driven sweeps) and the "2026-07 normalization pack" section of
[hmrc-ch-mapping-fix.md](hmrc-ch-mapping-fix.md) (the matching tiers).

## Why it exists

The nightly sweep inherits two constraints from the CH search API: it only
ever sees the top 20 search results, and it pays per request. Three failure
classes are structurally unreachable that way:

- Typo'd names the search returns nothing for ("Kdlheathcare Ltd" →
  KDL HEALTHCARE).
- Correct matches ranked below the 20-result cutoff (common names).
- Renames only discoverable via previous names the search doesn't surface.

The free monthly bulk file (`BasicCompanyDataAsOneFile-YYYY-MM-01.zip`,
~5.5M live companies with CompanyStatus, RegAddress PostTown/County and up
to 10 previous names) removes both constraints: one streaming pass compares
the entire register against the entire backlog.

## How it works

```text
scripts/bulk-snapshot-match.ts
  1. backlog  = no_match + NULL-method mapping rows, live register only,
                with town/county from the deterministic first worker row
  2. entries  = parseHmrcName(org) → legal candidate → squash key
                (public-body names and degenerate squashes are skipped)
  3. indexes  = exact Map<squash, entries>          (Tier A/A2/B lookups)
                fuzzy Map<first-3-of-squash, entries> (Tier D blocking)
  4. stream the snapshot CSV once; for each row, index lookups PRE-FILTER
     and the real pipeline matchers decide: matchTierA / matchTierASquash /
     matchTierB (trading-as exclusion intact) / matchTierD (active +
     locality-corroborated only)
  5. per org: pickForOrg — strongest tier, active-preferred, shared
     pickByLocality tiebreak; ambiguity fails closed ('tied')
  6. per pick (strongest tiers first, capped by --max-verifications):
     GET /company/{number} LIVE, re-run the tiers against the live
     name/status/previous names — snapshot staleness can never commit a
     wrong match — then decide(existing, proposed) and applyPromotion
     (optimistic lock + audit row + profile UPSERT), changed_by
     'bulk_snapshot', query_used 'bulk:<snapshot filename>'
```

Matching semantics live in ONE place — `src/lib/hmrc-ch/pipeline.ts` — so
the offline matcher can never drift from the online resolver. The bulk
modules (`src/lib/bulk-match/`) only do indexing, candidate selection, and
snapshot-row adaptation.

## Known recall limits (accepted)

- Fuzzy blocking is first-3-chars-of-squash: an edit inside the first three
  characters is not recoverable offline ("CABANA"→"KABANA").
- Tier C (token Jaccard) is not replicated offline — squash + previous-name
  + fuzzy cover more than the search-windowed Tier C did.
- The snapshot excludes long-dissolved companies, so the resolver's
  inactive-fallback matches mostly can't originate here (the nightly sweep
  still finds those via search).

## Operations

- Workflow: `.github/workflows/bulk-snapshot-match.yaml` — monthly on the
  3rd at 12:19 UTC (the snapshot publishes in the first days of the month;
  midday avoids the nightly sweep window and the shared `phase5-sweep`
  concurrency group serialises against the tiers). ~450MB download, ~2.6GB
  unpacked on the runner, nothing bulky written to Neon.
- `--dry-run` runs the full pipeline including live verification but writes
  nothing; `--max-verifications=N` caps API usage (default 2500 ≈ 25 min at
  ~1.8 req/s; capped-out orgs stay in the backlog for the next run);
  `--backlog-limit=N` and `--snapshot-file=path` support local testing.
- Committed rows leave the backlog by definition, so successive monthly
  runs converge; `bulk_snapshot` in the audit trail identifies every write
  forever.
