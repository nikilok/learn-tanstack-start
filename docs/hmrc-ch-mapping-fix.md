# HMRC sponsor → Companies House mapping: failure analysis & fix design

Status: **Phase 0a, 0b, 1 all complete and applied to production · shared
library + seed refactor merged · UI null-handling shipped · Phase 3 on-demand
resolver hardening shipped · Phase 5 re-verification cron remains as follow-up
work.**

This is a design doc, not a postmortem — there was no incident, but there
was a critical data-quality bug in production (see [Concrete reproduction](#concrete-reproduction-rainbow-care-solutions-hertfordshire))
that this work has now repaired. ~19,583 sponsor cards now show either
correct CH data or correctly degrade to "no Companies House data" instead
of pointing at a wrong / dissolved / unrelated entity.

---

## TL;DR

The bug exists in **two places** that both blindly take `items[0]` from
`/search/companies?q=<orgname>&items_per_page=1`:

| File | When it runs | Practical impact today |
|---|---|---|
| [`apps/web/scripts/seed-companies-house.ts`](../apps/web/scripts/seed-companies-house.ts) | One-time, when bootstrapping a new environment | Created the bulk corruption originally — ~125k mappings, ~5–15k of which we estimate are wrong |
| [`apps/web/src/api/companiesHouse.ts`](../apps/web/src/api/companiesHouse.ts) — `getCompanyProfile` | Server-side, on user requests for unmapped sponsors | Slow leak for any *new* HMRC sponsor not yet in the mapping table — but the existing 125k mappings short-circuit this path on every request, so the leak rate is small |

This is wrong because:

1. CH's search ranking is a fuzzy relevance score that weights
   `previous_company_names` and trading-name fragments heavily. With
   `items_per_page=1` we are always taking whatever happened to win that
   ranking, even if it's a typo-similar dissolved shell or an unrelated
   company that shares one token with our query.
2. HMRC publishes a string like `Maddaford Care Services Ltd trading as
   Lakeside Residential home` in `organisation_name`. CH has no notion of
   trading names as a structured field, so the trading-name suffix becomes
   pure noise that confuses the search.
3. The mapping table has no provenance — once we've written a wrong row, we
   can't tell it from a right row without re-querying.

The fix is a six-step pipeline (parse → public-body filter → search →
score-by-tier → locality tiebreak → fail closed), plus schema changes that
make the mapping table auditable, plus a staged backfill that diffs proposed
changes before touching the live table, plus a periodic re-verification job
to catch drift.

---

## Pipeline architecture: what runs when

The system has several mechanisms touching HMRC ↔ CH data, each with a
different role. Knowing which is which prevents fixing the wrong file (which
we did once before realising):

| Mechanism | Cadence | What it does | Touches `hmrc_company_mapping`? |
|---|---|---|---|
| `seed-companies-house.ts` | One-time bootstrap | Walks every uncached HMRC org, resolves to CH | **Yes (initial bulk insert)** |
| `ingest-hmrc-csv.ts` | Each HMRC publication cycle | Updates `hmrc_skilled_workers` from CSV; new org names appear | No |
| `getCompanyProfile` ([api/companiesHouse.ts](../apps/web/src/api/companiesHouse.ts)) | Live, on user request | Returns CH profile for a sponsor; resolves on demand if not yet mapped | **Yes (on cache miss for unmapped sponsor)** |
| `ch-stream` (Railway, separate `ss-ch-stream` project) | Live, real-time | Listens to CH event stream; updates `companies_house_profiles` for renames/dissolutions/etc. | No — only updates profile data, not mappings |
| **Phase 1 apply (this doc)** | One-time, manual | Apply Phase 0a + 0b proposed corrections from the staging table to the live mapping table | **Yes (correction batch)** |
| **Phase 5 re-verification cron (this doc)** | Daily/weekly | Picks N oldest-verified mappings and re-runs `resolveOneSponsor`; updates if verdict differs | **Yes (drift correction)** |

Two takeaways:

1. **`ch-stream` keeps profile *data* fresh but cannot fix mapping *correctness*.** If we mapped Aberdeen City Council to SL004112 wrongly, ch-stream will keep updating SL004112's profile but never re-evaluate the mapping itself. Drift correction has to be a separate mechanism.
2. **`getCompanyProfile` rarely fires the buggy code path today**, because the mapping table is fully populated. Almost every request hits the `if (mapping) → return cached` branch. Fixing it is good hygiene but doesn't address the existing corruption — Phase 1 does that.

---

## How we got here (analysis trail)

This investigation went through three reframings. They're worth recording
because at least two of them produced confident wrong answers.

### Reframing 1 — "T/A poisons the search"

First instinct, after sampling 10 dissolved-sponsor mappings with no name
overlap and seeing things like:

| HMRC name | Mapped CH entity |
|---|---|
| `The Willie Birkett Partnership` | `THE CHILLIE WILLIES GHOST STORIES LTD` |
| `Girlguiding UK` | `GIRLGUIDING MERSEYSIDE INSPIRE LTD` |
| `Chennai Cafe Limited T/A Chennai Dosa` | `CHENNAI DOSA LIMITED` |

The conclusion was: strip `T/A …` before searching, and require an exact name
match before accepting `items[0]`.

**Why this was incomplete**: see Reframing 2.

### Reframing 2 — "CH's previous-name index does silent rename resolution"

The user found a case (`Masref Ltd t/a Nsave`) where CH search returns
`NSAVE LTD` (`14337994`) as the top hit. NSAVE LTD is **the same legal
entity** that was formerly named MASREF LTD — same `company_number`, just
renamed. So:

- The mapping is **correct**, not broken.
- The HMRC list is just stale relative to the rename.
- A strict "stripped-name must equal CH name" check would have **rejected
  this correct mapping** and either fallen through to a typo-similar dead
  company or failed closed. Net loss.

So Reframing 1's proposed fix would itself have introduced bugs.

I then re-bucketed the 3,288 "no overlap" dissolved mappings by whether the
HMRC name appears in the matched CH entity's `previous_company_names`:

| previous-name signal | dissolved sponsors |
|---|---|
| no_previous_names recorded | 2,677 |
| previous names exist but no overlap | 509 |
| partial previous-name match | 62 |
| **exact previous-name match** | **40** |

Only ~100 of 3,288 are explainable as legitimate CH-internal rename
resolutions. The rest are still likely wrong.

### Reframing 3 — "previous-name resolution can ALSO be a trap"

Then we hit the Rainbow Care Solutions case (see next section), which
demonstrated that even `previous_company_names` matches can be poisoned —
specifically when the previous name itself contains "TRADING AS". CH happily
indexes `"A CLASS FOOD TRADING AS ROOSTERS PIRI PIRI LIMITED"` as a previous
name and ranks it for any query containing "Roosters Piri Piri".

This is the framing the fix design assumes.

---

## Concrete reproduction: Rainbow Care Solutions Hertfordshire

This case is the cleanest reproduction of the bug currently visible in
production.

### What our site shows

For HMRC sponsor `PRIME MARQUE SERVICES LIMITED Trading as: RAINBOW CARE
SOLUTIONS HERTFORDSHIRE`, our company-detail card displays:

| Field | Value shown |
|---|---|
| Company name | `Prime Marque Services Limited Trading As: Rainbow Care Solutions Hertfordshire` (HMRC label) |
| Status | **Dissolved** |
| Location | Stevenage, Hertfordshire |
| Incorporated | 25 September 2015 |
| Last accounts filed | 30 January 2020 |
| Registration No. | `09794326` |
| Registered address | Alpha House, Tipton Street, Sedgley, West Midlands, DY3 1HE |

### What's actually in our DB

```
hmrc_company_mapping
  organisation_name : "PRIME MARQUE SERVICES LIMITED Trading as: RAINBOW CARE SOLUTIONS HERTFORDSHIRE"
  company_number    : 09794326

companies_house_profiles where company_number = 09794326
  company_name      : "TRACR SOLUTIONS LIMITED TRADING AS PRIME2LEARN LTD"
  company_status    : dissolved
  date_of_creation  : 2015-09-24
  locality          : Sedgley
  previous_company_names : [ "TRACR SOLUTIONS LIMITED" ]
```

So the dissolved entity (registered in Sedgley, West Midlands) is being
shown as the company behind a live care provider in Stevenage,
Hertfordshire. The address, status, incorporation date, and registration
number are all wrong.

### Why CH ranked TRACR above the real entity

When we search CH for the full HMRC name, the actual legal entity
(`PRIME MARQUE SERVICES LIMITED`, `12373386`) appears **third** in CH's own
ranking. Above it:

1. `TRACR SOLUTIONS LIMITED TRADING AS PRIME2LEARN LTD` — wins because its
   *current* name contains `PRIME` (from "PRIME2LEARN"), giving it strong
   token overlap with the query word "Prime".
2. `AS:TEK PROCUREMENT SOLUTIONS LIMITED` — token overlap on "SERVICES".
3. `PRIME MARQUE SERVICES LIMITED` — exact match on the legal-name portion
   of the query, still ranked third.

`items_per_page=1` discards results 2 and 3 entirely, so we silently take
TRACR.

### Scale of the problem

**Phase 0a (the local-only classifier) ran against all 125,922 mappings and
gave us a precise breakdown** — the original Skilled-Worker-only counts
below have been kept for historical context, but the headline numbers from
Phase 0a are the ones to trust now:

| Phase 0a verdict | Count | Share |
|---|---|---|
| `verified_locally` | 106,143 | 84.3% |
| `suspect_no_local_alternative` (passed to Phase 0b) | 19,340 | 15.4% |
| `public_body_skip` | 388 | 0.3% |
| `suspect_with_local_alternative` (verified swap, no API call needed) | 51 | 0.0% |
| `requires_human_review` | 0 | 0.0% |

Within `verified_locally`, the tier breakdown:

| Tier | Hits |
|---|---|
| A — exact name | 100,672 |
| B — clean previous-name match (rename catches like NSAVE LTD) | 1,947 |
| C — token similarity ≥ 0.85 | 3,524 (mostly punctuation/word-order variants; 3,491 of these score ≥ 0.95) |

So we know with high confidence that **at least 439 mappings are wrong**
(the 51 + 388) and **between ~5,000 and ~15,000 of the 19,340 suspect rows
are wrong** (Phase 0b is currently resolving these — interim numbers at the
300/19,340 mark show ~26% verified / ~73% no_match / ~1% review).

Original Skilled-Worker-only sample (kept for context):

| CH status of mapped entity | Skilled Worker sponsors |
|---|---|
| dissolved | 4,383 |
| liquidation | 815 |
| converted-closed | 149 |
| closed | 81 |
| removed | 8 |

Not all of these are wrong — the `closed` bucket is dominated by
`uk-establishment` (BR…) entities, which is a real-world UKVI/CH
inconsistency rather than our bug. But the dissolved bucket is where the bad
mappings concentrate, and a sample shows the failure mode clearly:

```
Reserve Forces' and Cadets' Association (London Branch)
  → THE INTERPOL EURASIAN CROSS-BORDER INVESTIGATION BUREAU (dissolved)

NHS Bristol, North Somerset and South Gloucestershire Integrated Care Board
  → HEALTHWATCH BRISTOL,NORTH SOMERSET & SOUTH GLOUCESTERSHIRE LTD (dissolved)

Birmingham & Solihull Mental Health Foundation NHS Trust
  → BIRMINGHAM & SOLIHULL BUSINESS LINK DBS TRUSTEE LIMITED (dissolved)

Ferrari N.V. UK Branch trading as Ferrari North Europe
  → FERRARI NORTH EUROPE LIMITED (dissolved 2004 namesake)

ALAC LTD trading as Shanghai Oriental Buffet Restaurant
  → ORIENTAL BUFFET RESTAURANT (WHITCHURCH) LIMITED (dissolved)
```

Two recurring patterns worth calling out separately:

- **Public bodies aren't on CH at all.** NHS Trusts, Integrated Care Boards,
  reserve forces, councils — these are statutory entities, not registered
  companies. Our seed always takes `items[0]` regardless, so it grabs
  whatever similarly-named Ltd happens to exist (often a dissolved shell).
- **Trading names in CH `previous_company_names`.** When a CH entity's
  *previous* name contained "TRADING AS", that previous name still gets
  indexed and can win the ranking. This is what bit the
  `1066 Foodservice Limited trading as Roosters Piri Piri →
  A CLASS FOOD LIMITED` case (former name: `A CLASS FOOD TRADING AS ROOSTERS
  PIRI PIRI LIMITED`).

---

## Design principles

These should drive every decision in the fix:

1. **Fail closed, not silently wrong.** A missing mapping is better than a
   mapping pointing at a stranger. The card UI can show "Companies House
   data unavailable for this sponsor" — that's honest. Showing data for the
   wrong company is not.
2. **CH ranking is adversarial, not just noisy.** It actively rewards
   token overlap with `previous_company_names` and trading-as suffixes.
   Treating its top hit as authoritative is the bug. Verification has to
   live on *our* side.
3. **The HMRC string is structured data, not a name.** It packs (legal
   name, trading name, branch designation, sometimes inverted ordering)
   into one field. We have to parse it before searching.
4. **Mapping rows must be auditable.** Today we can't tell a good mapping
   from a bad one without re-querying CH. Adding provenance fields is what
   makes the backfill safe and re-runnable.
5. **Idempotent backfill.** Re-running the seed should never *re-corrupt* a
   row that was already verified. This implies a `verified_at` column and a
   "skip rows verified more recently than X" rule.

---

## The pipeline (one HMRC org name → one CH company_number)

### Step 1 — Pre-filter: skip entities that aren't on CH at all

If the HMRC name matches any of these patterns, skip the CH lookup entirely
and record `is_public_body = true`:

```
\b(NHS|National Health Service)\b
\bFoundation Trust\b
\b(Integrated Care Board|ICB)\b
\b(Borough|City|County|District|Parish) Council\b
\bReserve Forces\b
\bCadets? Association\b
\b(Ministry of|Department for|Department of)\b
\b(Police Federation|Fire and Rescue Service)\b
```

Open question: do schools and universities go here too? Many are CH-registered
(Limited by guarantee), so the rule is more nuanced. Defer for now.

### Step 2 — Parse the HMRC name into ordered query candidates

Apply regex rules in priority order:

| HMRC pattern | Legal-name candidate | Trading-name candidate |
|---|---|---|
| `X T/A Y` / `X t/a Y` | `X` | `Y` |
| `X Trading As Y` / `X trading as: Y` | `X` | `Y` |
| `X d/b/a Y` | `X` | `Y` |
| `X Trading name of Y` (inverted!) | **`Y`** | `X` |
| `X (Y Branch)`, `X UK Branch`, `X UK Establishment` | `X` | — |
| no separator | `X` | — |

Output: an *ordered list* of query strings, legal-name first.

The "Trading name of" inversion is critical — note the difference:

```
"Maddaford Care Services Ltd trading as Lakeside Residential home"
  → legal: "Maddaford Care Services Ltd"
  → trading: "Lakeside Residential home"

"RICHMOND COURT RESIDENTIAL HOME Trading name of DP & S SAHNI"
  → legal: "DP & S SAHNI"          ← reversed
  → trading: "RICHMOND COURT RESIDENTIAL HOME"
```

### Step 3 — Search with `items_per_page=20`

For each candidate string, query CH with `items_per_page=20`. Same number
of API calls as today (one per HMRC name), just a richer payload to score
against.

### Step 4 — Score every result against the candidate

For each result, compute a confidence tier:

| Tier | Condition | Action |
|---|---|---|
| **A — exact** | `UPPER(result.company_name) = UPPER(candidate)` | Accept |
| **B — previous-name exact** | `UPPER(candidate) ∈ UPPER(result.previous_company_names)` AND none of the matching previous names contain `TRADING AS` / `T/A` / `D/B/A` | Accept |
| **C — token similarity** | Jaccard similarity of normalised word tokens (lowercased; suffixes `LTD`/`LIMITED`/`LLP`/`PLC` stripped; stopwords removed) ≥ **0.85** | Accept *only* if no Tier-A or Tier-B hit found across any candidate |
| **D — anything else** | — | Reject |

Tier-B's exclusion of "TRADING AS" previous names is what would have caught
the Rainbow Care / TRACR-Prime2Learn case. Without it, the previous-name
match itself becomes a poisoning vector.

### Step 5 — Locality tiebreaker

If multiple results pass at the same tier, prefer the one whose
`locality`/`region` matches the HMRC sponsor's `town_city`/`county` (we
already store these in `hmrc_skilled_workers`).

The Rainbow Care case fails this trivially:

- HMRC sponsor: Stevenage, Hertfordshire
- Wrong-mapped TRACR: Sedgley, West Midlands
- Real PRIME MARQUE SERVICES LIMITED: (presumably) Hertfordshire

### Step 6 — If nothing passes any tier across any candidate

Write a negative-cache row with `match_method = 'no_match'`. This:

- Stops us re-querying CH on every backfill for known-unmappable names.
- Lets the UI honestly say "no Companies House data available" rather than
  showing wrong data.
- Lets us periodically re-attempt the cache (CH adds entities over time).

---

## Schema changes

```sql
ALTER TABLE hmrc_company_mapping
  ADD COLUMN match_method   varchar(32),
    -- 'exact' | 'previous_name' | 'token_sim' | 'public_body' | 'no_match' | 'manual'
  ADD COLUMN match_score    numeric(4,3),  -- 0.000 to 1.000
  ADD COLUMN query_used     text,          -- the candidate string that produced the match
  ADD COLUMN verified_at    timestamp,
  ALTER COLUMN company_number DROP NOT NULL;
```

Plus a sibling audit table that captures every change so the backfill is
revertible:

```sql
CREATE TABLE hmrc_company_mapping_audit (
  id                serial PRIMARY KEY,
  organisation_name text    NOT NULL,
  old_company_number  varchar(20),
  new_company_number  varchar(20),
  old_match_method    varchar(32),
  new_match_method    varchar(32),
  changed_at          timestamp DEFAULT now() NOT NULL,
  changed_by          varchar(100)  -- 'backfill_v1', 'manual:nikilok@', etc.
);
```

Open question: do we keep `hmrc_company_mapping` as the live table and add
audit alongside, or move to a `hmrc_company_mapping_v2` and keep the old
table read-only as a safety net? The first is simpler; the second makes
rollback a single ALTER.

---

## Backfill strategy

Don't re-run the whole seed. Stage it:

### Phase 0a — local-only classifier (zero API calls)

The dry run is split in two. **Phase 0a runs first, with zero CH API calls.**
It uses only data we already have locally (the existing
`companies_house_profiles` table holds 125k+ entities — many "right" answers
are already cached) to classify every existing mapping.

**Estimated runtime**: 2–4 minutes for the full 125,922-row mapping table.
Pure SQL + in-memory string ops; no network.

#### Inputs (read-only)

```
hmrc_company_mapping        (organisation_name, company_number)
companies_house_profiles    (company_number, company_name, company_status,
                             previous_company_names, locality, region)
hmrc_skilled_workers        (organisation_name, town_city, county)  -- locality tiebreaker
```

#### Output: staging table

```sql
CREATE TABLE hmrc_company_mapping_audit_phase0a (
  organisation_name        text PRIMARY KEY,

  -- snapshot of current state
  current_company_number   varchar(20),
  current_ch_name          varchar(255),
  current_ch_status        varchar(50),

  -- proposed state (NULL when Phase 0b will fill it in)
  proposed_company_number  varchar(20),
  proposed_ch_name         varchar(255),
  proposed_ch_status       varchar(50),
  proposed_match_method    varchar(32),
  proposed_match_score     numeric(4,3),

  -- classification
  verdict                  varchar(40) NOT NULL,

  -- audit / debugging
  parsed_legal_name        text,
  parsed_trading_name      text,
  matched_via_candidate    text,
  local_alternatives       jsonb,           -- top-5 with metadata when ambiguous
  classified_at            timestamp DEFAULT now()
);
```

#### Verdict enum

| verdict | meaning | next action |
|---|---|---|
| `verified_locally` | Current mapping passes Tier A, B, or C | Mark verified in Phase 1; no swap needed |
| `public_body_skip` | HMRC name matches public-body regex | Mark `is_public_body=true` in Phase 2; null out `company_number` |
| `suspect_with_local_alternative` | Current mapping fails verification AND a different already-cached CH entity passes Tier A or B | Phase 1 candidate — verifiable swap, no API call needed |
| `requires_human_review` | Multiple plausible local alternatives; locality tiebreaker didn't resolve | Eyeball before acting; filter by `verdict` in the staging table |
| `suspect_no_local_alternative` | Current mapping fails AND no local replacement exists | Phase 0b will hit CH search for these |

#### Algorithm (per mapping row)

```
1. Parse organisation_name into ordered candidates:
   - T/A patterns (T/A, t/a, Trading As, Trading as:, d/b/a, D/B/A)
       → [legal_part, trading_part]
   - "Trading name of" inversion
       → [right_side, left_side]   ← legal is on the right!
   - "(... Branch)", "UK Branch", "UK Establishment"
       → [stripped_name]
   - Else
       → [original]

2. Normalise each candidate: trim, collapse whitespace, strip trailing
   ` LIMITED` / ` LTD` / ` LLP` / ` PLC` before comparison.

3. Public-body short-circuit:
   if PUBLIC_BODY_REGEX.test(organisation_name):
       verdict = 'public_body_skip'
       proposed_company_number = NULL
       proposed_match_method = 'public_body'
       return

4. For each candidate (in priority order), test against CURRENT mapping's
   CH entity:
     Tier A: UPPER(candidate) === UPPER(current_ch.company_name)         → 1.000
     Tier B: UPPER(candidate) IN UPPER(current_ch.previous_company_names)
             AND none of the matching previous names contain 'TRADING AS' → 0.95
     Tier C: jaccard(tokens(candidate), tokens(current_ch.company_name))
             ≥ 0.85   (lowercase, stopwords removed, suffix stripped)     → jaccard
   First hit wins. If any tier passes:
       verdict = 'verified_locally'
       proposed = current  (same number, just now provably correct)
       return

5. Local-replacement search (only if step 4 found nothing).
   IMPORTANT: query the local index using ONLY the LEGAL candidate
   (parsed.parsedLegal), NEVER the trading candidate. See "Local-replacement
   policy" subsection below for the rationale (the Subway-franchisee bug).

   For the legal candidate only, query companies_house_profiles for:
       UPPER(company_name) = UPPER(legal_candidate)
       OR UPPER(legal_candidate) ∈ UPPER(previous_company_names)
          (excluding previous names that contain 'TRADING AS')
   AND company_number != current_company_number
   LIMIT 5

   If exactly one alternative found:
       verdict = 'suspect_with_local_alternative'
       proposed = that alternative
       return

   If 2+ alternatives:
       Tiebreak by locality match (HMRC town_city/county vs CH locality/region)
       If unique winner: verdict = 'suspect_with_local_alternative'
       Else:             verdict = 'requires_human_review'
                         local_alternatives = [...top 5 with metadata]
       return

6. No local match for the legal candidate:
       verdict = 'suspect_no_local_alternative'
       proposed_company_number = NULL  (Phase 0b will resolve)
       return
```

#### Local-replacement policy: legal-only (the Subway-franchisee fix)

The first run of Phase 0a used **all candidates** (legal + trading) for
the local-replacement search. The output looked promising — 281 swap
candidates and 58 `requires_human_review` rows. Spot-checking surfaced a
systematic failure mode:

| HMRC sponsor | Proposed swap | Issue |
|---|---|---|
| `BHAV LIMITED T/A SUBWAY` | `SUBWAY LIMITED` | Brand owner, not the franchisee |
| `LLA CHAI LTD T/A Chaiiwala` | `CHAIIWALA LTD` | Brand owner |
| `Apex Restaurants Ltd T/A Pepe's Piri Piri` | `PEPE'S PIRI PIRI LIMITED` | Brand owner |
| `Nilas Stores Ltd T/A Family Shopper` | `FAMILY SHOPPER LTD` | Brand owner |

The 58 `requires_human_review` rows were *all* `<franchisee> T/A Subway`
patterns — many franchisees pointing to the same two brand-owner CH
entities (`SUBWAY LIMITED` and `ECO FRESH LIMITED`). The trading-candidate
arm of the search was matching the brand to brand-owner CH records.

**This is the same class of bug as the original `items[0]` problem**, just
with a different wrong target — mapping franchisees to the entity that
owns the brand, not the entity that holds their visa sponsor licence.

The fix is to restrict the local-replacement search to the **legal
candidate only**. Trading-name matches alone are never a valid swap — they
resolve to brand owners, not franchisees. After the fix:

| Verdict | Before fix | After fix | Change |
|---|---|---|---|
| `suspect_with_local_alternative` | 281 | 51 | −230 (the brand-owner mismatches) |
| `requires_human_review` | 58 | 0 | −58 (the Subway franchisee block) |
| `suspect_no_local_alternative` | 19,052 | 19,340 | +288 (rerouted to Phase 0b) |

The same legal-only restriction applies to Phase 0b's CH-search lookup
(Policy A), and to the seed/on-demand resolver via the shared
`resolveOneSponsor` helper. Trade-off accepted: some legitimate
franchisees whose own Ltd isn't on CH will end up `no_match_after_ch_search`
rather than mapped to their brand owner. That's the correct fail-closed
behaviour.

#### Tokenisation rules (Tier C)

The Jaccard similarity at Tier C operates on a normalised token set, not
raw words. Two pre-processing steps:

1. **Tokenise**: lowercase the string, then split on
   `\s+` and `[,&\-./()]`. Drop pure-punctuation tokens.
2. **Filter**: drop tokens in the stopword and corporate-suffix lists.

| Category | Tokens dropped |
|---|---|
| Stopwords | `the`, `and`, `of`, `for`, `at`, `in`, `on` |
| Corporate suffixes | `limited`, `ltd`, `llp`, `plc`, `uk` |

**Why we strip these.** They appear in nearly every UK company name and add
noise without signal. The 0.85 threshold only becomes meaningful if both
sides have been reduced to their *discriminating* words first.

Worked example. HMRC `Bank of Scotland Limited` vs CH `Bank of England
Limited` (different banks):

| Tokenisation | Jaccard |
|---|---|
| No stripping | `{bank, of, limited}` shared / 5 union = **0.60** |
| Strip suffixes only | `{bank, of}` / 4 = **0.50** |
| Strip suffixes + stopwords | `{bank}` / 3 = **0.33** |

Without stripping, completely unrelated companies score 0.60 purely on
filler. With stripping, 0.85 has a clean interpretation: *"at least 85% of
the meaningful tokens overlap"*.

**Risks**:
- Over-stripping makes very short names empty (e.g. `OF LIMITED` reduces
  to `[]`). Mitigation: require at least 2 non-stripped tokens on both
  sides before Tier C is even attempted; otherwise fall through to "no
  match".
- Names that differ only in a stopword (`Friends of the Earth` vs
  `Friends of Earth`) are considered identical. In practice this is
  desirable — almost always a typo or formatting difference — but worth
  flagging.
- Stopword list is English-specific. Non-English names get less
  effective deduping; acceptable given the corpus is UK-focused.

#### Actual run results

```
Phase 0a complete. Classified 125,922 mappings in 12.6s.

Verdict breakdown
─────────────────────────────────────────────────────────────────
  verified_locally                 106,143  (84.3%)  ← no action needed
  suspect_with_local_alternative        51  ( 0.0%)  ← Phase 1 swap candidates
  public_body_skip                     388  ( 0.3%)  ← Phase 2 candidates (folded into Phase 1 below)
  requires_human_review                  0  ( 0.0%)  ← (none after the legal-only fix)
  suspect_no_local_alternative      19,340  (15.4%)  ← Phase 0b will hit CH

Tier hits within verified_locally
─────────────────────────────────────────────────────────────────
  Tier A (exact name)              100,672
  Tier B (clean previous-name)       1,947
  Tier C (token sim ≥ 0.85)          3,524

Token-similarity histogram (Tier C only)
─────────────────────────────────────────────────────────────────
  0.85–0.89        31
  0.90–0.94         2
  0.95–0.99     3,491
```

The Tier-C histogram is bimodal — almost all matches cluster at 0.95+
(punctuation/word-order variants of identical names). The 33 rows below
0.95 were spot-checked and all looked correct (e.g. `International
Organisation for Peace Building and Social Justice (PSJ) UK LTD` ↔
`INTERNATIONAL ORGANISATION FOR PEACE BUILDING AND SOCIAL JUSTICE UK`).
0.85 stays as the threshold; revisit only if Phase 0b's Tier-C
distribution looks meaningfully different.

#### Code structure

The pipeline logic now lives in shared library files used by Phase 0a,
Phase 0b, and the seed (see [Code organisation](#code-organisation) for
the full layout):

```
apps/web/src/lib/hmrc-ch/pipeline.ts        ← pure functions (parser, scoring, tokenisation)
apps/web/src/lib/hmrc-ch/resolve-sponsor.ts ← orchestration helper (search → score → tiebreak)
apps/web/scripts/phase0a-classify-mappings.ts  ← imports lib, adds local-index + DB orchestration
```

`phase0a-classify-mappings.ts` does:

```text
main():
  create staging table (idempotent — drops & recreates)
  load all 125k CH profiles into in-memory indexes (byName, byPrevName)
  read all mappings + locality via JOIN (also loaded into memory as an array)
  for each row:
    parseHmrcName(orgName) → candidates
    public-body short-circuit
    matchTierA/B/C against current mapping
    if no match: findLocalAlternatives(legal_candidate) → swap or no_local_alternative
    bufferedInsert(proposed_row)
  print summary + write CSV samples
```

#### Cost

- **Memory**: O(n) in CH profiles + mappings. The two in-memory indexes
  (`byName`, `byPrevName` keyed on uppercased name) plus the mappings array
  put peak heap at ~120-150 MB for a 125k-row corpus. Acceptable on any
  developer laptop; would need to be re-architected as a streaming join
  if the corpus ever grew past low-millions.
- **DB**: 1 SELECT for profiles + 1 SELECT for mappings join + 125k
  bulk-buffered inserts to staging (~2-3 minutes total)
- **API**: zero
- **Disk**: ~190 MB staging table, ~5 MB CSV samples

### Phase 0b — CH calls for residual (overnight)

Only for rows where Phase 0a returned `suspect_no_local_alternative`
(19,340 rows from this run). Picks up from the same staging table; updates
in place. Naturally resumable — re-runs skip rows whose verdict has
already been changed.

Implemented at [`apps/web/scripts/phase0b-resolve-suspects.ts`](../apps/web/scripts/phase0b-resolve-suspects.ts).

#### Per-row pipeline

```
1. Re-parse organisation_name to get the legal candidate (same parser as Phase 0a).

2. Search CH ONCE with the LEGAL candidate only:
     GET /search/companies?q=<legal>&items_per_page=20
   (Policy A — never trading-name. Same rationale as Phase 0a's local-replacement
   policy: searching with a trading name resolves to brand owners, which is
   the wrong entity. See "Local-replacement policy" subsection above.)

3. Cache the response on disk before scoring:
     apps/web/.cache/phase0b/search-<sha256-prefix>-<slug>.json

4. Score every result against the legal candidate:
     Tier A — UPPER(result.title) === UPPER(legal)               → 1.000
     Tier B — UPPER(legal) ∈ result.previous_company_names
              (excluding entries containing TRADING AS)          → 0.95
     Tier C — jaccard(tokens(legal), tokens(result.title)) ≥ 0.85 → score

5. If no Tier A hit, fetch full profiles for the top 3 results to enable
   Tier B (search-result payload doesn't include previous_company_names —
   only profile fetches do):
     GET /company/{number}  (cached to apps/web/.cache/phase0b/profile-…json)

6. Locality tiebreak among accepted candidates (HMRC town_city/county
   vs CH locality/region).

7. Verdict transitions:
     verdict = 'verified_via_ch_search'      ← Tier A/B/C match found, single winner
     verdict = 'no_match_after_ch_search'    ← no candidates pass any tier
     verdict = 'requires_human_review_ch'    ← multiple candidates tied at same tier
```

#### Locked decisions (ratified during implementation)

- **`TIER_B_PROFILE_FETCH_TOP_N = 3`** — fetch profiles for the top 3
  search results when Tier A misses, to enable Tier B (previous-name
  match). Trade-off discussion: dropping to 1 would halve runtime
  (~6h vs ~10h) but miss legitimate renames at positions 2–3 in CH's
  ranking. Kept at 3 since this is an overnight job and recall matters
  more than throughput.
- **Cache layout**: `apps/web/.cache/phase0b/<kind>-<sha256-prefix>-<slug>.json`
  per query. Filename includes a slug for human grep-ability. Cache is
  gitignored at the repo root.
- **Single-process at ~1.8 req/sec** (`DELAY_MS = 550`). Matches the seed
  script. Two API keys would double throughput but adds coordination
  complexity; not worth it for a one-off.
- **Two `.env.local` files**: POSTGRES_URL at the monorepo root,
  COMPANIES_HOUSE_SEED_API_KEY at `apps/web/.env.local`. Script loads
  both via two `dotenv.config` calls.

#### Schema additions to staging table

```sql
ALTER TABLE hmrc_company_mapping_audit_phase0a
  ADD COLUMN IF NOT EXISTS ch_search_query_used   text,
  ADD COLUMN IF NOT EXISTS ch_search_results_top5 jsonb,
  ADD COLUMN IF NOT EXISTS phase0b_processed_at   timestamp;
```

`ch_search_results_top5` lets us audit *why* any row was matched (or not)
without re-querying CH — pull it from the staging table to see CH's
ranking for any given query.

#### Cost & runtime (in-progress observations)

- API ratio: ~3.3 calls per row (1 search + 2.3 profile fetches average,
  since Tier A misses on most suspect rows by definition)
- At 1.8 req/sec with caching: **~10 hours wall time for the first run**
- Subsequent re-runs (after threshold tuning, regex updates): **minutes**,
  because cached responses are re-scored locally without re-calling CH

#### Final results

Completed in 10h 00m 51s. 60,537 API calls (search + Tier B profile
fetches), no errors, no 429 backoffs.

| Verdict | Count | Share |
|---|---|---|
| `verified_via_ch_search` | 3,249 | 16.8% |
| `no_match_after_ch_search` | 15,895 | 82.2% |
| `requires_human_review_ch` | 196 | 1.0% |

Tier breakdown for `verified_via_ch_search` (3,249 rows):

| Tier | Count | Share |
|---|---|---|
| `exact` (Tier A) | 2,535 | 78% |
| `token_sim` (Tier C) | 690 | 21% |
| `previous_name` (Tier B) | 24 | 1% |

The 82% `no_match` rate is higher than the mid-run sample at 300/19,340
suggested (~73% at that point — see the in-progress numbers earlier in
the doc), reflecting Policy A doing exactly what was asked of it:
failing closed when the legal candidate doesn't have a verifiable CH
entity. These sponsors include sole traders, unincorporated
partnerships, foreign entities, and franchisees whose own Ltd isn't
registered — entities for which "no CH data" is the correct outcome.

---

## Phase 1 — apply the corrections to live data

This is where the actual user-visible damage gets repaired. Phase 1 takes
the staging table that Phases 0a + 0b populated and writes the proposed
corrections to the live `hmrc_company_mapping` table — every change
logged to an audit table for revertibility.

### Sub-piece 1: schema migration

Today the live mapping table has no provenance:

```sql
hmrc_company_mapping (
  organisation_name text PRIMARY KEY,
  company_number    varchar(20) NOT NULL  -- can't be null today
);
```

Phase 1 adds the columns the verdict information needs:

```sql
ALTER TABLE hmrc_company_mapping
  ALTER COLUMN company_number DROP NOT NULL,
  ADD COLUMN is_public_body boolean NOT NULL DEFAULT false,
  ADD COLUMN match_method   varchar(32),  -- exact|previous_name|token_sim|public_body|no_match|manual
  ADD COLUMN match_score    numeric(4,3),
  ADD COLUMN query_used     text,
  ADD COLUMN verified_at    timestamp;

CREATE TABLE hmrc_company_mapping_audit (
  id                 serial PRIMARY KEY,
  organisation_name  text NOT NULL,
  old_company_number varchar(20),
  new_company_number varchar(20),
  old_match_method   varchar(32),
  new_match_method   varchar(32),
  changed_at         timestamp DEFAULT now() NOT NULL,
  changed_by         varchar(100)  -- 'phase1_apply' / 'manual:nikilok@'
);
```

Generated via Drizzle's normal migration flow (`db:generate` then
`db:migrate`).

### Sub-piece 2: `phase1-apply` script

Walks the staging table; per row, writes one of these UPDATEs to
`hmrc_company_mapping`, followed by an INSERT into the audit table:

```sql
-- For verified_locally / verified_via_ch_search / suspect_with_local_alternative:
UPDATE hmrc_company_mapping SET
  company_number = $proposed_company_number,
  match_method   = $proposed_match_method,
  match_score    = $proposed_match_score,
  query_used     = $matched_via_candidate,
  verified_at    = now(),
  is_public_body = false
WHERE organisation_name = $organisation_name;

-- For public_body_skip:
UPDATE hmrc_company_mapping SET
  company_number = NULL,
  is_public_body = true,
  match_method   = 'public_body',
  verified_at    = now()
WHERE organisation_name = $organisation_name;

-- For no_match_after_ch_search:
UPDATE hmrc_company_mapping SET
  company_number = NULL,
  match_method   = 'no_match',
  query_used     = $ch_search_query_used,
  verified_at    = now()
WHERE organisation_name = $organisation_name;

-- For requires_human_review_*: skip (no automatic write)
```

### Actual outcome

| Verdict | Action | Rows | User-visible change? |
|---|---|---|---|
| `verified_locally` | provenance backfill only | 106,143 | No (mapping unchanged) |
| `verified_via_ch_search` | swap `company_number` + provenance | 3,249 | Yes — corrected mapping |
| `suspect_with_local_alternative` | swap + provenance | 51 | Yes — corrected mapping |
| `public_body_skip` | NULL number + `is_public_body=true` | 388 | Yes — UI shows "no CH data" instead of wrong entity |
| `no_match_after_ch_search` | NULL number + `match_method='no_match'` | 15,895 | Yes — UI shows "no CH data" |
| `requires_human_review_ch` | skip | 196 | None — left for manual review |

**Total writes applied**: 125,726. Of those, **19,583 changed
`company_number`** (3,300 swaps + 16,283 NULLs) — the meaningful
user-visible delta. The remaining 106,143 were provenance backfills
(invisible to users; populates the new `match_method`/`match_score`/
`verified_at` columns for any future drift-correction job).

Audit table now has 126,114 rows attributed to `phase1_apply` (slightly
more than the row count due to a known idempotency bug — see "Known
issues" below).

### Safety properties (as designed)

> **Known reliability gap — non-atomic write path.** `applyRow` in
> `apps/web/scripts/phase1-apply.ts` performs `SELECT` → `UPDATE
> hmrc_company_mapping` → `INSERT INTO hmrc_company_mapping_audit` as
> three separate statements. If the script exits between the UPDATE and
> the INSERT, or if another writer modifies the row between those
> statements, the live mapping and audit table can diverge. The two
> Phase 1 runs that have shipped both reconciled exactly (audit count
> matches expected delta), but the race window is real. Atomic
> CTE-based writes (`WITH updated AS (UPDATE ... RETURNING ...) INSERT
> INTO audit ... SELECT FROM updated`) are deferred to Phase 5, where
> the recurring cron context makes the gap matter more than it does for
> a one-shot backfill.

- **Dry-run mode** — `--dry-run` prints the diff (counts by verdict +
  sample rows per category) before any writes hit the live table
- **Sub-phasing** — script accepts `--apply-verdict=public_body_skip,suspect_with_local_alternative`
  flags so high-confidence corrections (the 439) ship first,
  inspected, then the larger Phase 0b batch
- **Revertibility** — every change goes through the `hmrc_company_mapping_audit`
  table; any row can be restored individually with one SQL statement
- **UI dependency** — landed before the data writes: the
  `getCompanyProfile` server fn now returns `null` when `mapping.companyNumber`
  is NULL, the company-detail page already had `{profile && (...)}`
  guards on the CH panel, so the page degrades to base sponsor data only

### Rollout that actually happened

1. ✅ Schema migration generated + applied
   (`packages/db/migrations/0022_jittery_famine.sql`)
2. ✅ UI null-handling shipped (one-line guard in `getCompanyProfile`)
3. ✅ `phase1-apply --dry-run` showed expected counts
4. ✅ Applied the 439 high-confidence subset
   (`--apply-verdict=suspect_with_local_alternative,public_body_skip`)
5. ✅ Spot-checked Rainbow Care Solutions Hertfordshire (now correctly
   shows PRIME MARQUE SERVICES LIMITED active in Stevenage),
   AB Offlicence Limited, A Patel, BABUL'S (DARLINGTON) LTD,
   Aberdeen City Council, Birmingham & Solihull NHS Trust,
   Reserve Forces' and Cadets' Association — all rendering correctly
6. ✅ `phase1-apply` (full run) applied the remaining ~125k rows over
   a few hours, no errors
7. ⏭ Cache flush via Vercel deploy (push to main triggered automatic
   data-cache invalidation)

### Known issues from the run

**Idempotency bug for repeat-applied NULL rows**. The 388
`public_body_skip` rows were re-written on the second run instead of
detected as "already in target state" no-ops. Cause: in `applyRow`,
`oldNumberLive = old[0]?.company_number ?? oldNumber` clobbered an
explicit NULL with the staging snapshot's original value, so the
idempotency guard never fired. **No data corruption** — the same
correct values were written twice; just 388 redundant UPDATEs + 388
extra audit rows. Fixed in a follow-up to `phase1-apply.ts`:

```ts
// before
const oldNumberLive = old[0]?.company_number ?? oldNumber;

// after — distinguishes "row missing" from "column is NULL"
const oldNumberLive = old.length > 0 ? old[0].company_number : oldNumber;
```

### Round 2: post-merge re-run (after PR #69 review)

A CodeRabbit review on PR #69 surfaced a **second instance of the
franchisee→brand-owner trap** that wasn't caught during initial
implementation. The original "Local-replacement policy: legal-only"
subsection in this doc only addresses `findLocalAlternatives`. The
*verification* loop in `classifyOne` (`phase0a-classify-mappings.ts`)
was still iterating `parsed.candidates` (legal + trading), which meant
any franchisee currently mapped to its brand owner would pass
`verified_locally` via Tier A on the trading-name candidate — same
class of bug, different code path.

```ts
// before — verifies against trading candidate too
for (const candidate of parsed.candidates) {
  const a = matchTierA(candidate, currentCh);
  if (a !== null) return { verdict: 'verified_locally', ... };
  // ...
}

// after — legal candidate only (matches findLocalAlternatives policy)
{
  const candidate = parsed.parsedLegal;
  const a = matchTierA(candidate, currentCh);
  if (a !== null) return { verdict: 'verified_locally', ... };
  // ...
}
```

**Re-run sequence**: fix landed → Phase 0a re-run → Phase 0b re-run →
Phase 1 re-run. All three were cheap thanks to existing artefacts
(staging table is dropped & recreated each time, Phase 0b's disk cache
made the second resolution run mostly cache-hit).

**Phase 0a re-run results** (~109k rows in scope; 16,283 already-NULLed
rows excluded by the inner join):

| Verdict | Count | vs. original run |
|---|---|---|
| `verified_locally` | 105,525 | −618 (rows reclassified out via the fix) |
| `suspect_with_local_alternative` | 13 | new |
| `requires_human_review` | 2 | new |
| `suspect_no_local_alternative` | 884 | the workload for Phase 0b round 2 |

**Phase 0b re-run** completed in **10 minutes** (vs 10 hours for the
original) thanks to disk cache hits; 884 rows resolved with only 1,014
fresh API calls:

| Verdict transition | Count | Share |
|---|---|---|
| `verified_via_ch_search` | 537 | 60.7% |
| `requires_human_review_ch` | 213 | 24.1% |
| `no_match_after_ch_search` | 134 | 15.2% |

**Phase 1 re-run** processed 106,209 rows in ~2h. The idempotency
check (post-bug-fix) correctly short-circuited 105,473 verified_locally
rows that already had matching provenance from the previous Phase 1
run. Actual writes:

| Action | Rows |
|---|---|
| `company_number` swapped | 550 |
| Provenance reclassified (verified_locally rows whose match_method changed) | 52 |
| NULLed + `match_method='no_match'` | 134 |
| Already in target state (no-op) | 105,473 |

**Audit table delta**: +736 rows (550 + 52 + 134). New total: 126,850.

### Cumulative impact across both rounds

| Round | Swaps | NULLs | Total user-visible corrections |
|---|---|---|---|
| Round 1 (original Phase 1) | 3,300 | 16,283 | 19,583 |
| Round 2 (post-fix re-run) | 550 | 134 | 684 |
| **Grand total** | **3,850** | **16,417** | **20,267** |

Out of 125,922 mappings, **~16.1% had user-visible corrections
applied**. Plus 105,525 silent provenance backfills for the rows that
were already correct.

---

## Phase 2 — (folded into Phase 1 above)

The original Phase 1 / Phase 2 split (corrections vs public-body cleanup)
is now redundant — both verdicts are handled by the same `phase1-apply`
script, distinguished by the `--apply-verdict=` flag. Kept as a section
header here only because earlier conversations referenced "Phase 2".

---

## Phase 3 — on-demand resolver hardening (shipped)

The on-demand resolver in [`apps/web/src/api/companiesHouse.ts`](../apps/web/src/api/companiesHouse.ts)
(`getCompanyProfile`) had the same `items_per_page=1 → take items[0]` bug
as the original seed. It rarely fired post-Phase 1 because the mapping
table was fully populated, but `phase1-sanity-check` measured ~15
unverified mappings/24h leaking through the buggy `else` branch (≈ 1
per hour, naive-linear ≈ 5,000/year, of which ~15% historically map
wrong → ~750 wrong mappings/year silently re-corrupting the dataset
Phase 1 just cleaned). All sample leaks matched the populations most
vulnerable to `items[0]` — T/A franchisees and BR-prefix UK Establishments.

The fix replaces the buggy `else` branch with `resolveOneSponsor` from
[`src/lib/hmrc-ch/resolve-sponsor.ts`](../apps/web/src/lib/hmrc-ch/resolve-sponsor.ts),
the same orchestration helper used by the seed and Phase 0b. The
resolver returns one of four verdicts; each is now persisted with full
provenance so the row never hits the resolver again on the next visit:

| Verdict | Mapping row written |
|---|---|
| `verified` | `company_number` + `match_method` (exact / previous_name / token_sim) + `match_score` + `query_used` + `verified_at` |
| `public_body` | `company_number = NULL`, `is_public_body = true`, `match_method = 'public_body'`, `verified_at` |
| `no_match` | `company_number = NULL`, `match_method = 'no_match'`, `query_used`, `verified_at` |
| `human_review` | cached as `no_match` (multiple-tied verdicts won't disambiguate without ch-stream data updates; Phase 5 re-verification can revisit) |

### Locality plumbing

`getCompanyProfile` queries `hmrc_skilled_workers` for the sponsor's
`town_city` / `county` inside the resolver branch (one extra DB read on
the cold path only — never fires once a mapping is cached). Querying
inside the handler keeps the server-fn input surface unchanged and avoids
trusting client-supplied locality.

### Latency

The verified pipeline issues up to 5 sequential CH API calls (1 search +
3 Tier B profile fetches + 1 verified-profile fetch). At ~200-500ms
each, worst case adds ~1.0-2.5s to the *first* user request that
creates a new mapping. Subsequent requests hit the cache. Acceptable
for an infrequent path.

### Validation

Run `bun apps/web/scripts/phase1-sanity-check.ts` daily for a week
post-deploy. The `new_since_phase1` count (Section 4) should plateau —
new sponsors now get verified provenance and are no longer counted in
that proxy. Pre-fix it climbed roughly linearly at ~15/day.

---

## Phase 4 — agentic resolver for `requires_human_review_*` (pending)

Phase 0b ended with **196 rows tied at the same tier with no locality
winner** (`requires_human_review_ch`), plus 0 from Phase 0a after the
legal-only fix. Phase 1 deliberately skips these — they have no
deterministic answer. They sit unmapped today.

These are the only rows where token-Jaccard runs out of road, and they
are a small enough population (~196) that a per-row LLM call is cheap
(~$1 total at small-model rates). The model has clear signal to work
with: CH search results, `previous_company_names`, candidate
registered addresses, and (if needed) the candidates' websites for
franchisee-vs-brand-owner disambiguation.

Sketch (`apps/web/scripts/phase4-resolve-human-review.ts`, not yet
written):

1. Read every row from `hmrc_company_mapping_audit_phase0a` where
   `verdict IN ('requires_human_review', 'requires_human_review_ch')`.
2. For each, pull the cached CH search response (already on disk under
   `apps/web/.cache/phase0b/`) plus the top-N candidate profiles.
3. Hand the HMRC name, locality, and the candidate set to the model.
   Same agentic shape as
   [`find-hmrc-csv-url.ts`](../apps/web/scripts/find-hmrc-csv-url.ts) —
   structured JSON output, max-steps loop, fail-closed if the model
   isn't confident.
4. Write the model's verdict + reasoning into new staging columns
   (`agent_verdict`, `agent_reasoning`).
5. **Human approval gate** — `phase4-apply.ts` shows each agent verdict
   for one-key approve/reject before any write hits the live mapping
   table. The agent never writes directly.

The Tier-C sub-0.95 spot-check originally scoped under Phase 4 was
absorbed into Phase 1's rollout step #5 and is complete.

This is the *only* place an LLM is appropriate in this pipeline. See
"Decisions locked in" below for why.

---

## Operational monitoring: `phase1-sanity-check`

A lightweight, on-demand integrity check that runs against the live mapping
table and the staging table to verify Phase 1 is holding and to surface
drift / leak between full re-verification runs. Implemented at
[`apps/web/scripts/phase1-sanity-check.ts`](../apps/web/scripts/phase1-sanity-check.ts)
(landed in PR #74).

### When to run it

```sh
bun apps/web/scripts/phase1-sanity-check.ts
```

- **Anytime** — pure read-only, no writes, no API calls. ~5 seconds wall time.
- **Weekly cadence as a post-hardening regression check.** Now that Phase 3 has
  shipped, the `new_since_phase1` count should stay near zero — every new
  sponsor that hits the on-demand resolver gets verified provenance written, so
  it stops counting toward this proxy. Sustained linear growth indicates a
  regression (provenance not being written) or a new writer path bypassing the
  resolver. Treat any week-over-week climb as an alert.
- After running Phase 5's re-verification cron (when it ships), to spot-check
  that the cron's writes look right.

### Six sections it reports

| # | Section | What it answers |
|---|---|---|
| 1 | `match_method` breakdown of all mappings + totals | Provenance distribution looks like the documented Phase 1 outcome. ~103k exact, ~16k no_match, ~4k token_sim, ~2k previous_name, 388 public_body, ~211 NULL. |
| 2 | Audit table breakdown by `changed_by` | Should show ~126,850 rows attributed to `phase1_apply`. Any other `changed_by` value would indicate a different actor (manual ops, future Phase 5 cron). |
| 3 | Mappings modified after the most recent `phase1_apply` audit timestamp | Drift detection. The cutoff is dynamically derived from `MAX(changed_at) WHERE changed_by = 'phase1_apply'` so it self-resets on Phase 1 re-runs and is safe in fresh environments. |
| 4 | New mappings created since Phase 1 (Phase 3 leak proxy) | The headline metric. Counts mappings with NULL `match_method` whose org name is *not* in the staging table as a `human_review` verdict. Excludes the 196+2 deliberate human_review skips so the number reflects only genuinely new sponsors created by something other than `phase1_apply` — almost always `getCompanyProfile.else`. |
| 5 | Sanity-check the 196+2 `requires_human_review` rows | Are any manually resolved? Did any get deleted from the live table (LEFT JOIN surfaces this via `missing_in_live`)? Should be `manually_resolved=0` and `missing_in_live=0` unless someone has been picking off ambiguous cases by hand. |
| 6 | Method distribution sanity (printed expected vs. read in section 1) | Eyeball comparison against the documented post-Phase-1 numbers. |

### What the first run found (2026-04-27, ~24h after Phase 1)

```text
Total mappings:                           125,938   (Phase 0a snapshot was 125,922 → +16 since Phase 1)
phase1_apply audit rows:                  126,850   ✓ matches expected
Drift rows since phase1_apply cutoff:           0   ✓ no anomalous activity
new_since_phase1 (leak proxy):                ~15   ⚠ first measurement of Phase 3 leak rate
total_null_provenance:                        211   = 196 human_review skips + ~15 new
Manually resolved human_review rows:           19   17 from prior buggy classification + 2 phase0a
```

The 15-mappings/24h leak rate was the pre-hardening headline finding that
motivated Phase 3 (issue [#70](https://github.com/nikilok/learn-tanstack-start/issues/70)).
Post-Phase-3, treat it as baseline history; renewed growth is a regression signal.

The sample of untracked mappings was the smoking gun: every single one
matched the population most vulnerable to the `items[0]` bug — T/A
franchisees (`AKM Trading Ltd T/A Gosport Community Pharmacy`,
`ASDF LTD t/a Papa Johns`, `AL AMANA LTD T/A GREEN LEAF`, etc.) and BR-prefix
UK Establishments (`A.Menarini Farmaceutica Internazionale SRL-UK Branch`,
`ABN AMRO Bank N.V., UK Branch`). Same bug class, different code path.

### Notable design choices in the script

- **`changed_at` cutoff sourced from the audit table itself**, not a hardcoded
  date. Re-runs of `phase1_apply` advance the cutoff naturally; fresh
  environments fall back to epoch-zero (so the query is safe before any
  `phase1_apply` rows exist). Both the comparison and the displayed cutoff
  use the same `COALESCE(MAX(changed_at), '1970-01-01'::timestamp)` so they
  always agree.
- **`new_since_phase1` excludes deliberate human_review skips** by checking
  the staging table directly (`NOT EXISTS … verdict IN ('requires_human_review',
  'requires_human_review_ch')`). Without this guard the count would conflate
  the genuine leak with the 196+2 skip rows that legitimately have NULL
  provenance.
- **Section 5 uses `LEFT JOIN`** on the staging-to-live join so any future
  deletion from `hmrc_company_mapping` shows up as `missing_in_live` rather
  than silently dropping the row from `staging_count`. Sanity checks should
  fail loud, not silent.

These were all CodeRabbit-prompted refinements during PR #74 review.

---

## Phase 5 — periodic re-verification (drift correction)

Phase 1 fixes a snapshot. Phase 5 keeps it correct over time.

### What this addresses

- **CH renames / dissolutions / acquisitions** that happen after a
  mapping is verified
- **HMRC sponsor name updates** between ingest cycles
- **Newly-seeded CH profiles** that would now win a previously-failing
  match (e.g. ch-stream just added the right entity to our local cache
  for a row that was previously `no_match_after_ch_search`)
- **Improvements to the verification pipeline itself** — when we tighten
  a rule or add a regex, periodic re-verification picks up the
  improvement organically

### Three options, in order of complexity

#### A. Periodic batch job (simplest — recommended for v1)

A daily/weekly cron that:

1. Selects N rows from `hmrc_company_mapping` ordered by `verified_at` ASC
   (oldest first)
2. For each, runs `resolveOneSponsor` exactly like Phase 0b
3. If the new verdict differs from the current one AND the new one has
   higher confidence (better tier, exact-name, or active vs dissolved),
   updates the mapping and writes to the audit table
4. Otherwise, just updates `verified_at = now()` so the row drops to the
   bottom of the queue

Sizing:
- 1k rows/day → full corpus re-verified every ~4 months
- 5k rows/day → ~25 days
- Either is well within the CH API rate limit (1k calls × 3.3 = 3.3k =
  ~30 minutes/day)

Same code path as `phase0b-resolve-suspects.ts`, just running against a
different SELECT.

#### B. ch-stream-triggered re-verification

When ch-stream observes a name-change or dissolution event for a
`company_number` that's referenced in `hmrc_company_mapping`, queue a
re-verification of every HMRC sponsor pointing at that number. More
targeted, more "live", but requires changes on the ch-stream side.

#### C. Visit-driven refresh

In `getCompanyProfile`, when serving a cached profile, check the
mapping's `verified_at`. If older than 90 days, `waitUntil(reverify(...))`
in the background. Uses real user traffic as the priority signal —
popular sponsors get verified more often.

**Trade-off**: adds modest complexity to the hot path. Could ship A
first and add C later for popularity-weighted priority on top of the
default cron schedule.

### Recommendation

Ship A first (simple cron, predictable schedule, easy to reason about).
Layer C later if popularity-weighted refresh would be useful (probably
not unless we get user traffic data showing high concentration on a
small subset of sponsors).

---

## Decisions locked in

Recorded here so future readers don't relitigate them:

### Phase 0a (classifier)

1. **Tier-C threshold = 0.85.** Phase 0a's histogram showed only 33
   matches below 0.95; spot-checks all looked correct. Threshold stays.
2. **Staging table name = `hmrc_company_mapping_audit_phase0a`** (real
   table in main DB, not temp — queryable interactively).
3. **`requires_human_review` rows live in the same staging table**,
   filtered by `verdict`. No separate review table.
4. **Public-body regex = the 8 patterns listed in Step 1.** Schools
   and universities deliberately not included for v1.
5. **Tokenisation rules** — lowercase; split on `\s+|[,&\-./()]`;
   drop pure-punctuation; drop stopwords (`the`, `and`, `of`, `for`,
   `at`, `in`, `on`); drop suffix tokens (`limited`, `ltd`, `llp`,
   `plc`, `uk`).
6. **Local-replacement search uses LEGAL candidate only** (the
   Subway-franchisee fix; ratified after the first Phase 0a run
   produced 230 brand-owner mismatches).

### Phase 0b (CH search resolver)

7. **Policy A — search with the LEGAL candidate only.** Never fall
   back to a trading-name search. Same rationale as decision #6.
8. **`TIER_B_PROFILE_FETCH_TOP_N = 3`.** Fetch profiles for top-3
   results when Tier A misses to enable Tier B (previous-name match).
   Trade-off: ~10h vs ~6h for top-1; recall over throughput because
   it's an overnight job.
9. **Cache layout** = `apps/web/.cache/phase0b/<kind>-<sha256>-<slug>.json`,
   gitignored at repo root.
10. **Single-process at ~1.8 req/sec** (`DELAY_MS = 550`). No
    parallelisation with multiple API keys for v1.

### Phase 1 (live writes — to confirm before applying)

11. **Schema approach** — extend the existing `hmrc_company_mapping`
    table (add nullable + provenance columns), don't fork to a `_v2`.
    Audit table provides revertibility instead.
12. **Sub-phasing** — apply the 439 high-confidence corrections
    (`suspect_with_local_alternative` + `public_body_skip`) before
    the larger ~19k Phase 0b batch. Spot-check production for a day
    in between.
13. **UI for `company_number IS NULL`** — render a "no Companies
    House data" panel state. Same component used for both
    `is_public_body=true` and `match_method='no_match'` cases.

### Deterministic vs agentic boundary

14. **Bulk classification stays deterministic.** Phase 0a, 0b, 1, 3,
    and 5 all use pure-function scoring (Tier A/B/C, locality
    tiebreak). Reasons:
    - **Cost** — 125k rows × per-call LLM pricing dwarfs the free CH
      API budget the deterministic path uses.
    - **Reproducibility** — re-running Phase 0a on the same input
      produces bit-identical output. LLM verdicts vary run-to-run,
      which makes regression queries (e.g. `phase1-sanity-check`'s
      `new_since_phase1`) un-auditable.
    - **The 84% case is trivially deterministic.** Sending exact-name
      and punctuation-variant matches through a model is paying tax on
      the easy cases to maybe-do-better on the 0.5% that's hard.
15. **LLM use is allowed only for the `requires_human_review_*`
    long tail (Phase 4).** ~196 rows where token-Jaccard ran out of
    road and locality didn't break the tie. Cost-effective at this
    scale, and a human approval gate sits between the agent and the
    live mapping table.
16. **The on-demand resolver (Phase 3) must stay deterministic.**
    Runs on every cold-path page request; LLM latency would push the
    1–2.5s budget to 4–6s, and "model hallucinates a plausible-sounding
    company number" is exactly the bug class this whole document
    exists to prevent.

## Open questions (still need decisions)

1. **Public-body regex coverage extensions.** The 8 starting patterns
   catch the obvious cases. Phase 0b's `requires_human_review_ch`
   bucket will surface the next layer (specific NHS body types,
   devolved-nation councils). Tune iteratively after Phase 0b
   completes.
2. **Address tiebreaker quality.** HMRC `town_city` is free-text and
   noisy; CH `locality` is also free-text. Exact equality is what we
   use today. Postcode-prefix comparison would be more robust if HMRC
   data has postcodes — needs investigation. Don't optimise until
   `requires_human_review_ch` shows it's a bottleneck.
3. **Phase 5 cadence**: 1k rows/day (4-month cycle) vs 5k rows/day
   (25-day cycle) vs another value. Pick after Phase 1 ships and we
   have a baseline drift rate to compare against.
4. **Whether to also cache Phase 5's CH responses.** Phase 0b caches
   to disk; Phase 5 running on the same cache could mostly hit it for
   recently-verified rows, but cache-invalidation semantics need
   thought (we DON'T want re-verification to read stale CH responses).
   Probably best to use a separate, time-limited cache or no cache at
   all for Phase 5.

## Code organisation

The verification pipeline lives in shared library files used by every
mechanism that touches the mapping table:

```
apps/web/src/lib/hmrc-ch/
  pipeline.ts             Pure functions only (no I/O):
                            parseHmrcName / parseLegalCandidate
                            normaliseForComparison / tokenise / jaccard
                            matchTierA / matchTierB / matchTierC
                            pickByLocality
                            constants: TIER_C_THRESHOLD, PUBLIC_BODY_REGEX,
                                       STOPWORDS, CORPORATE_SUFFIXES
                            types: CHCandidate, ScoredCandidate, MatchMethod

  resolve-sponsor.ts      Orchestration helper (caller-injected fetchApi):
                            resolveOneSponsor(orgName, hmrcLocation, fetchApi)
                              → ResolveResult { verdict: verified | public_body
                                              | no_match | human_review }
                            handles search → tier scoring → top-N profile
                            fetch for Tier B → locality tiebreak → fail closed
```

The library lives under `src/lib/` rather than `scripts/lib/` because it's
runtime code now — the on-demand resolver in `apps/web/src/api/companiesHouse.ts`
imports it on every request that hits an unmapped sponsor (Phase 3). The
scripts continue to import via the same path.

Callers:

| File | Uses |
|---|---|
| `phase0a-classify-mappings.ts` | `pipeline` (pure helpers, no resolveOneSponsor — local-only) |
| `phase0b-resolve-suspects.ts` | `pipeline` (pure helpers); has its own search/cache orchestration today, could be refactored to use `resolveOneSponsor` after the current run finishes |
| `seed-companies-house.ts` | `resolveOneSponsor` directly |
| `getCompanyProfile` ([api/companiesHouse.ts](../apps/web/src/api/companiesHouse.ts)) | `resolveOneSponsor` (Phase 3 hardening) |
| Future: `phase1-apply.ts` | reads staging table, no pipeline calls needed |
| Future: `phase5-reverify.ts` | `resolveOneSponsor` |

The injected-`fetchApi` shape lets each caller bring its own auth,
rate-limiting, caching, and retry behaviour without the pipeline lib
needing to know.

---

## What I would NOT do

For the record, things considered and rejected:

- **Strip `T/A` from `hmrc_skilled_workers.organisation_name` directly.**
  The user-facing fuzzy search relies on the trading name being present in
  this field. T/A stripping is for the seed-time CH query only, not the
  stored value.
- **Reject all matches where names don't exactly equal.** Would have
  killed the legitimate `Masref Ltd t/a Nsave → NSAVE LTD` rename
  resolution and ~1,100 similar cases. Tier-B (previous-name match with
  TRADING-AS exclusion) is the right way.
- **Bulk re-seed by truncating the mapping table.** Loses the manual fixes
  someone might have made by hand, loses the audit trail, and re-corrupts
  the rows we already know are right.
- **Use CH's advanced search instead.** Same ranking algorithm, same
  problem.

---

## Future v2: enriching public bodies via CH officer records

Out of scope for the current fix, but worth capturing while it's fresh.

### What we discovered

CH has two distinct identifier spaces, and statutory public bodies (Councils,
NHS Trusts, Reserve Forces, etc.) live exclusively in the second one:

| Concept | Identifier scheme | URL pattern | API endpoint |
|---|---|---|---|
| **Company** (files accounts) | numeric/prefixed (`14337994`, `SL004112`, `BR011845`) | `/company/<number>` | `/company/{number}` |
| **Officer** (person OR corporate body that holds appointments) | opaque base64-ish hash (`4E4AxVgMkEr1imLfqNB7QijqNHQ`) | `/officers/<id>/appointments` | `/officers/{id}` and `/officers/{id}/appointments` |

A statutory body like Aberdeen City Council can hold *appointments* (e.g. as
LLP Designated Member of `ABERDEEN NHT 2014 LLP`) without itself *being* a
registered company. CH's officer record for the council shows:

- Legal form: "A LOCAL AUTHORITY CONSTITUTED AND..." (truncated by CH UI)
- Law governed: "SCOTS LAW"
- Correspondence address: "Town House, Broad Street, Aberdeen, AB10 1AQ"
- List of company appointments

That's strictly more useful information than what we currently show (a wrong
or unrelated Ltd), but it's a different data shape from `companies_house_profiles`.

### Why we're deferring it

1. Phase 2 (null + `is_public_body=true`) already stops the bleeding —
   users stop seeing wrong-entity data for these 388 sponsors.
2. Officer enrichment requires a second scrape pipeline, a second schema,
   and a UI panel that doesn't exist yet. None of that is on the critical
   path for fixing the misleading Rainbow Care / NHS Trust / Council cards.
3. Product demand isn't proven. The `is_public_body=true` UI ("This sponsor
   is a public body and is not registered with Companies House") is honest
   and complete by itself.

### Sketch of v2 if we ever build it

**Schema additions** (alongside the existing nullable `company_number`):

```sql
ALTER TABLE hmrc_company_mapping
  ADD COLUMN ch_officer_id varchar(64);  -- nullable; only populated for is_public_body=true rows

CREATE TABLE companies_house_officers (
  officer_id           varchar(64) PRIMARY KEY,
  name                 varchar(255) NOT NULL,
  legal_form           text,           -- "A LOCAL AUTHORITY CONSTITUTED AND..."
  law_governed         varchar(100),   -- "SCOTS LAW", "ENGLAND AND WALES", etc.
  correspondence_address text,
  appointments_count   integer,
  fetched_at           timestamp DEFAULT now()
);

CREATE TABLE companies_house_officer_appointments (
  officer_id      varchar(64) REFERENCES companies_house_officers,
  company_number  varchar(20),
  role            varchar(100),       -- 'LLP Designated Member', etc.
  appointed_on    date,
  resigned_on     date,
  PRIMARY KEY (officer_id, company_number, appointed_on)
);
```

**Resolution pipeline** (mirrors the company pipeline, same discipline):

1. **Search**: `GET /search/officers?q=<hmrc_name>&items_per_page=20` —
   same fuzzy-ranking risk as `/search/companies`, so same verification rule
   applies.
2. **Verify**: accept only when `UPPER(returned.name) = UPPER(hmrc_name)`,
   or via a Tier-B equivalent on previous officer names if CH exposes them.
   Reject otherwise — fail closed exactly as Phase 0a/0b do.
3. **Hydrate**: on first verified match, fetch `/officers/{id}` and
   `/officers/{id}/appointments` and upsert.
4. **Refresh**: same daily/periodic cadence as the company seed.

**UI implication**: when `is_public_body=true` and `ch_officer_id` is set,
render a separate "Officer record" panel on the detail page (legal form,
governing law, correspondence address, recent appointments). When
`is_public_body=true` and `ch_officer_id` is NULL, fall back to the Phase 2
default ("not registered with CH").

### Triggers for prioritising v2

Build this when *any* of:

- User feedback explicitly asks for richer detail on public-body sponsors
- A material fraction of search traffic lands on `is_public_body=true` cards
- We need it for SEO (public-body pages are too thin to rank well)
- A product feature requires officer-level information (e.g. "show all
  companies this council is a designated member of")

Until then: leave the v2 columns and tables uncreated, and revisit when
the trigger fires.

---

## Appendix: queries used in this analysis

For reproducibility — these are the ones that produced the numbers above.

```sql
-- 1. Distinct CH statuses across the corpus (Status badge palette source)
SELECT company_status, COUNT(*)::int
FROM companies_house_profiles
WHERE company_status IS NOT NULL
GROUP BY company_status
ORDER BY 2 DESC;

-- 2. Skilled Worker sponsors whose CH status is non-active
SELECT chp.company_status, COUNT(DISTINCT chp.company_number)::int
FROM companies_house_profiles chp
JOIN hmrc_company_mapping m ON m.company_number = chp.company_number
JOIN hmrc_skilled_workers sw ON sw.organisation_name = m.organisation_name
WHERE sw.route = 'Skilled Worker'
  AND chp.company_status IN ('closed','converted-closed','removed','dissolved','liquidation')
GROUP BY 1 ORDER BY 2 DESC;

-- 3. Dissolved-sponsor mappings bucketed by HMRC↔CH name overlap
SELECT
  CASE
    WHEN UPPER(m.organisation_name) = UPPER(chp.company_name) THEN 'exact_match'
    WHEN UPPER(chp.company_name) LIKE UPPER(m.organisation_name) || '%'
      OR UPPER(m.organisation_name) LIKE UPPER(chp.company_name) || '%' THEN 'prefix_match'
    WHEN POSITION(UPPER(chp.company_name) IN UPPER(m.organisation_name)) > 0
      OR POSITION(UPPER(m.organisation_name) IN UPPER(chp.company_name)) > 0 THEN 'substring_match'
    ELSE 'no_textual_overlap'
  END AS match_quality,
  COUNT(DISTINCT chp.company_number)::int
FROM companies_house_profiles chp
JOIN hmrc_company_mapping m ON m.company_number = chp.company_number
JOIN hmrc_skilled_workers sw ON sw.organisation_name = m.organisation_name
WHERE sw.route = 'Skilled Worker' AND chp.company_status = 'dissolved'
GROUP BY 1 ORDER BY 2 DESC;

-- 4. Of the no-overlap rows, how many are explained by previous_company_names
WITH no_overlap AS (
  SELECT chp.company_number, m.organisation_name AS hmrc_name,
         chp.previous_company_names
  FROM companies_house_profiles chp
  JOIN hmrc_company_mapping m ON m.company_number = chp.company_number
  JOIN hmrc_skilled_workers sw ON sw.organisation_name = m.organisation_name
  WHERE sw.route = 'Skilled Worker' AND chp.company_status = 'dissolved'
    AND POSITION(UPPER(chp.company_name) IN UPPER(m.organisation_name)) = 0
    AND POSITION(UPPER(m.organisation_name) IN UPPER(chp.company_name)) = 0
)
SELECT
  CASE
    WHEN previous_company_names IS NULL OR cardinality(previous_company_names) = 0 THEN 'no_previous_names'
    WHEN EXISTS (SELECT 1 FROM unnest(previous_company_names) p WHERE UPPER(p) = UPPER(hmrc_name)) THEN 'exact_previous_name_match'
    WHEN EXISTS (SELECT 1 FROM unnest(previous_company_names) p
                 WHERE POSITION(UPPER(p) IN UPPER(hmrc_name)) > 0
                    OR POSITION(UPPER(hmrc_name) IN UPPER(p)) > 0) THEN 'partial_previous_name_match'
    ELSE 'no_previous_name_overlap'
  END,
  COUNT(DISTINCT company_number)::int
FROM no_overlap
GROUP BY 1 ORDER BY 2 DESC;
```
