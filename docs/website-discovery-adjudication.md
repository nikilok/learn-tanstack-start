# Search website discovery — the unpublishable residue

Status as of 2026-08-01. Written as a handoff: the deterministic path is ready
to ship, an agentic path was prototyped and **rejected on measurement**, and the
open question needs data that only production runs can supply.

Read this before rebuilding any of it. Most of what follows is negative results,
which are the expensive part.

## The problem in one paragraph

Search discovery finds a company's website by querying Serper and then proving
ownership from the page itself. Only one proof is strong enough to publish: the
company's own registration number on its own site (`crn_on_page`, 0.990). The
registered office **postcode** on the page (`postcode_on_page`, 0.850) is far
more common but is not in `PUBLISHABLE_EVIDENCE`, because its precision has
never been measured on a searched population. On representative samples
(pooled n=80) that tier is 16.25% of rows against 11.25% publishable, so
closing it would roughly 2.4× what renders. (An earlier head-biased sample put it at 15 of 20,
which overstated the prize considerably — see the measured section below.)

## What ships (deterministic, no model)

Per company: reduce each Serper result to its **origin**, dedupe preserving rank,
then walk disclosure paths on the **rank-1 non-aggregator** candidate only.

```text
'', '/privacy', '/privacy-policy', '/terms-and-conditions', '/terms',
'/legal', '/contact-us', '/contact', '/about-us', '/about'
```

`/privacy` is first deliberately. GDPR requires a privacy policy to identify the
data controller as a legal entity, so it names the registered company and number
even on sites that are otherwise pure brand. Both new wins in the method lab came
off `/privacy`.

## Measured: method comparison

20 companies, identical cached pages, self-verifying score (a non-aggregator page
carrying the company's own CRN *is* that company's page).

| method | CRN | postcode | none | fetches |
|---|---|---|---|---|
| A origins, homepage only (post-origin-fix baseline) | 1 | 14 | 5 | 4.7 |
| B disclosure walk on ALL candidates | 3 | 13 | 4 | 42.3 |
| **C disclosure walk on RANK-1 non-aggregator** | **3** | **13** | **4** | **13.6** |
| D homepages, then Gemma picks, then walk | 2 | 11 | 7 | 11.8 |
| E rank-1 walk, escalate to rank-2/3 | 3 | 13 | 4 | 28.6 |
| F rank-1 walk + Gemma validates postcode | 3 | 11 | 6 | 13.6 |

Three conclusions:

- **The disclosure walk is the win.** Publishable rows tripled, 1 → 3. Fetches
  are free; only Serper queries cost money.
- **Rank-1 equals exhaustive.** C matches B on every outcome at a third of the
  cost, and E proves escalation to ranks 2–3 buys nothing. If the CRN is not on
  rank 1's site it is not on rank 2's either. Serper's ranking is already good.
- **Gemma lost in both roles.** See below.

## Rejected: Gemma as candidate selector

Gemma 4 E2B via LiteRT-LM/WebGPU, `@ss/gemma`, ~1.5s per inference on Apple
Metal-3 with 5.3s engine start. (The original plan assumed 10s and concluded
"two years for 115k" — that arithmetic was about the 15-minute `macos-latest` CI
cap, not about Gemma. Locally it is ~16 hours for the whole population.)

Method D dropped a CRN win and two postcode rows versus the trivial rank-1
heuristic. The cause is instructive: it correctly extracted `Red Funnel Ferries`
from `redfunnel.co.uk`, could not match that to
`SOUTHAMPTON ISLE OF WIGHT AND SOUTH OF ENGLAND ROYAL MAIL STEAM PACKET COMPANY
LIMITED`, and abstained — while rank-1 walked the same site and found the CRN on
`/privacy` without ever asking whose name it was.

**The general lesson: a trading-name knowledge gap does not need closing.** The
CRN sidesteps name identity entirely, which is the same principle as
"never match by name across systems, use stable IDs".

## Rejected: multi-signal corroboration

Proposed twice, falsified twice. The idea was to corroborate an extracted owner
name against SIC descriptions, town, postcode and incorporation year.

```text
             name    town    postcode   year
own   n=14   0.79    0.21    0.29       0.00
OTHER n=2    0.00    0.50    0.50       0.00
```

- **Name overlap is the only signal that separates**, and it separates cleanly.
- **Address signals are anti-correlated with truth.** The false positives scored
  *twice as high* on town and postcode. A page that displays a company's address
  is more likely to be a directory listing than the company's own site — listings
  exist to state addresses, real homepages often do not. This is the same effect
  that makes `postcode_on_page` weak as a selector in the first place.
- SIC matching by token overlap fails: SIC is statistical vocabulary
  ("Other processing and preserving of fruit and vegetables"), pages are
  marketing prose ("Brewing quality cask ales"). Needs semantic comparison or a
  direct model judgement, not bag-of-words.
- Year extraction reads the copyright line, not the founding date.

## What Gemma was actually good at

Owner extraction: **15/16**, including `LEAF (Linking Environment And Farming)`,
`Solvents Industry Association`, `Diocese of Liverpool`, `Red Funnel Ferries`.
The single failure was on a deep `/contact-us` page, which origin reduction
removes. Its weakness is *deciding whether two names are the same company*, not
reading pages.

That points at validation of the postcode tier rather than selection — but
method F made exactly two rejections, one correct (`solvents.org.uk` for Moeve)
and one wrong (`therhinos.co.uk` for Leeds). That is no evidence in either
direction.

## The open question

**Is `postcode_on_page` publishable, and under what conditions?**

Needed: a hand-labelled sample of post-origin-fix `postcode_on_page` rows drawn
from a **representative** slice, with a Wilson lower bound against the 95% bar —
the same process `registry_confirmed` went through (it shipped at 94.0% with the
shortfall recorded in `publishable.ts`'s docstring as an explicit product
judgement).

A candidate gate, unproven: **postcode discriminating power.** Companies sharing
a registered postcode, across 114k mapped sponsors:

| companies at that postcode | sponsors | kept if cut here |
|---|---|---|
| 1 | 42,893 | 37.6% |
| 2 | 15,914 | 51.5% |
| 3 | 8,704 | 59.1% |
| 4–5 | 9,638 | 67.6% |
| 6–10 | 11,715 | 77.9% |
| 11–20 | 9,829 | 86.5% |
| 21–50 | 8,346 | 93.8% |
| 51–100 | 2,839 | 96.3% |
| 101–300 | 1,609 | 97.7% |
| 300+ | 2,652 | 100.0% |

`EC1V 2NX` has 713 companies, `WC2H 9JQ` 605, `W1W 5PF` 500 — formation agents
and mail-forwarding services. For those the postcode carries no identifying
information, and worse, if the search returns the *agent's* site its homepage
displays that postcode, so the match is a guaranteed false positive rather than
a random one. There is **no knee in the distribution**; the mechanism argument
only clearly bites above ~50. Carry the share count onto the row so precision can
later be measured stratified by it, and set the threshold from data.

## Measured on REPRESENTATIVE samples (two seeded draws, pooled n=80)

Each drawn at random across the whole undiscovered population (seed 08-01:
incorporation years 1986–2025, median 2017; seed 08-02: 1910s–2020s; mixed
jurisdictions) by
`scripts/measure-search-yield.ts`, which runs the real orchestrator with a
seeded-random `selectRows` plus measurement instrumentation — a write wrapper
recording persisted outcomes, and per-run caps. Production probing, walking and
persistence are unchanged.

Two independent seeded samples of 40, pooled:

| outcome | seed 08-01 | seed 08-02 | pooled n=80 | share |
|---|---|---|---|---|
| `crn_on_page` (publishable) | 5 | 4 | 9 | **11.25%** |
| `postcode_on_page` | 7 | 6 | 13 | 16.25% |
| nothing | 28 | 30 | 58 | 72.5% |

Wilson 95% CI on the pooled publishable rate: **6.0% – 20.0%** (n=40 alone was
5.5–26.1). At the point estimate the remaining balance buys ~5,900 rendered
websites (range 3,100–10,400) at roughly $0.009 (≈£0.007) each. The second
sample also validated the evidence pointers end to end: all 27 verified rows
written since `evidence_url` was populated carry their claimed proof on the
exact page recorded — re-fetched and re-checked, zero failures — including the
6 whose proof lives on a disclosure page or post-redirect URL rather than the
stored origin.

This corrects two earlier readings badly:

- **The 0-for-10 live run was the head bias, not the method.** The pooled
  11.25% (12.5% and 10.0% in the two draws) is consistent with the lab's
  3-in-20.
- **"Three quarters of every credit lands in the postcode tier" was an artefact
  of the oldest companies.** On pooled representative data the postcode tier
  is 16.25%, and the dominant outcome is *nothing at all* (72.5%). Unlocking it
  would roughly 2.4× publishable output — still the largest single lever, but
  much smaller than the head sample implied.

The nothing bucket was then decomposed for the FIRST sample only — seed
08-01's 28 `none` rows; seed 08-02's 30 have not been decomposed — by
`scripts/measure-none-breakdown.ts` (zero
credits — it re-reads the banked candidates and re-fetches pages, mirroring
production probing: all five origins, aggregator judged post-redirect, with
Gemma owner-extraction as the ownership estimator). Corrected run, 2026-08-01:

| why the row is `none` (seed 08-01) | n | of its none | of its 40 |
|---|---|---|---|
| no own-looking page in the SERP — no site, a site search missed, or a JS shell (flagged per row) | 14 | 50% | 35% |
| own site found and walked, carries **neither statutory signal** | 10 | 36% | 25% |
| own-looking site below rank 1 (walked on production's default cap, `--max-disclosure=5` of the ten-path list: **0 of 4 carried the CRN**) | 4 | 14% | 10% |
| search returned nothing / all directories / all dead | 0 | — | — |

An earlier flawed run reported 16/9/3: it judged aggregators pre-redirect,
fetched only three origins, and checked two paths on lower-rank sites. The
corrected reconstruction moved two rows (one company's real site surfaced only
in origins 4–5).

Three conclusions, scoped to what the measurement can support:

- **No mechanical loss was found, but `no_ownership` is a mixed bucket.** Zero
  dead-fetch rows, zero all-directory rows, one JS-shell flag (a page that is
  plainly not the company), and zero padding-blind numbers — the cohort
  contains no company with two-plus leading zeros, so that failure mode was
  untestable here and the tooling now flags it. The 50% bucket is *mostly*
  small companies with no site (takeaways, corner shops), but a site absent
  from the top-10 SERP lands here indistinguishably, and the measured recall
  gap (80.7%@5) allows for up to roughly a third of it. "Likely no website"
  is the right reading; "proven no website" is not.
- **Rank-1-only walking survives representative data.** All four lower-rank
  own-looking sites were walked on the same five paths production uses and
  none carries the number. n=4 — consistent with the lab, not proof.
- **~27.5% is the observed statutory-signal rate under the shipped procedure,
  not a population ceiling.** 11.25% CRN + 16.25% postcode is what this
  provider's top five origins and the five-path walk surfaced at pooled n=80.
  Recall
  misses (80.7%@5) mean some signal-bearing sites were never reached, so the
  population's true rate sits somewhat higher — better recall could still
  raise yield. What the rate does establish: the own-but-silent pool (~25% of
  seed 08-01, the one sample the estimator ran on) has NO deterministic
  evidence at all, so reaching it needs a different evidence
  class (Common Crawl CRN sweep, or an adjudicated tier), not a better walk.
  Ownership buckets are estimator-based (15/16 on labelled data), so treat
  their sizes as ±2 rows.

## Sampling warning

The PRODUCTION selector still walks `company_number` ascending, so scheduled
runs process the oldest, most institutional companies first (incorporated
1861–1889 in the first slices) — the population least likely to publish a
registration number and most likely to trade under an unrelated brand. The
method-lab table above comes from that head; the representative section is the
corrective, drawn by `measure-search-yield.ts`'s seeded random sample.

**Do not recalibrate anything on early production runs**: their yield will read
far below the pooled representative 11.25% until the selector is past the head. If the
ascending order ever becomes a problem rather than a quirk, randomise the
selector — but that trades away its predictable resumability.

## How to resume cheaply

The method lab that produced the table above is the pattern to reuse:

1. Fetch every candidate origin and disclosure path **once** into a JSON cache.
2. Evaluate every method offline against that cache.

Iterating on a method then costs no fetches, no credits, and no politeness
budget, and every method sees identical bytes. Building the cache for 20
companies was ~450 fetches; the file was 1.2MB. The scoring is self-verifying via
the CRN, so no hand labels are needed for the headline metric — hand labels are
only needed for the postcode-tier precision question.

## Ledger

- Serper: 52,324 credits at $50. **115 spent**, itemised: 5 dry-run + 20 live
  (head, pre-walk) + 10 live (head, first walk run — the "0-for-10") + 40 + 40
  representative yield samples (seeds 08-01, 08-02). Balance 52,209. 106 rows
  written.
- Target population: 109,318 companies with no website row at the start; one
  search each covers **48%** of them (shortfall 56,994).
- `crn_on_page` is the only tier this job publishes. At the pooled 11.25% the
  balance buys ~5,900 rendered sites; the postcode question is worth settling
  before the bulk spend, and the own-but-silent pool needs a different
  evidence class entirely.
