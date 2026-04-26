# HMRC sponsor → Companies House mapping: failure analysis & fix design

Status: **draft for review**. Nothing in this doc has been built yet.

This is a design doc, not a postmortem — there has been no incident, but there
is a critical data-quality bug in production right now (see [Concrete reproduction](#concrete-reproduction-rainbow-care-solutions-hertfordshire))
and we want a principled fix that lets us re-run a batch backfill safely.

---

## TL;DR

`apps/web/scripts/seed-companies-house.ts` resolves an HMRC sponsor name to a
Companies House `company_number` by calling
`/search/companies?q=<orgname>&items_per_page=1` and **blindly trusting the top
result** — no verification that the returned name has any relationship to the
input.

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

The fix is a four-piece pipeline (parse → search → verify → tier),
plus schema changes that make the mapping table auditable, plus a staged
backfill that diffs proposed changes before touching the live table.

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

For Skilled Worker route only:

| CH status of mapped entity | sponsors |
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
  changed_at          timestamp DEFAULT now(),
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

5. Local-replacement search (only if step 4 found nothing):
   For each candidate, query companies_house_profiles for:
       UPPER(company_name) = UPPER(candidate)
       OR UPPER(candidate) ∈ UPPER(previous_company_names)
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

6. No local match for any candidate:
       verdict = 'suspect_no_local_alternative'
       proposed_company_number = NULL  (Phase 0b will resolve)
       return
```

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

#### Summary printed to stdout

```
Phase 0a complete. Classified 125,922 mappings in 0:02:34.

Verdict breakdown
─────────────────────────────────────────────────────────────────
  verified_locally                  87,xxx  (xx.x%)  ← no action needed
  suspect_with_local_alternative    xx,xxx  (xx.x%)  ← Phase 1 swap candidates
  public_body_skip                   x,xxx  ( x.x%)  ← Phase 2 candidates
  requires_human_review                xxx  ( x.x%)  ← eyeball before acting
  suspect_no_local_alternative      xx,xxx  (xx.x%)  ← Phase 0b will hit CH

Tier hits within verified_locally
─────────────────────────────────────────────────────────────────
  Tier A (exact name)               7x,xxx
  Tier B (clean previous-name)       x,xxx
  Tier C (token sim ≥ 0.85)          x,xxx

Token-similarity histogram (Tier C only)
─────────────────────────────────────────────────────────────────
  0.85–0.89  ████░░░░░░  x,xxx
  0.90–0.94  ███░░░░░░░    xxx
  0.95–0.99  ██░░░░░░░░    xxx

Phase 0b projection
─────────────────────────────────────────────────────────────────
  CH search calls needed:           xx,xxx
  Wall time @ 2 req/sec:            x:xx hours
  Wall time @ 4 req/sec (2 keys):   x:xx hours

Sample CSV files written to /tmp/:
  phase0a_verified_locally.csv               (50 random rows)
  phase0a_suspect_with_local_alternative.csv (50 random rows)
  phase0a_public_body_skip.csv               (all rows — usually small)
  phase0a_requires_human_review.csv          (all rows)
```

The Tier-C histogram is what tells us whether 0.85 is the right cutoff or
needs adjustment for the Phase 0b run. If most accepts cluster at 0.85–0.89
and spot-checks reveal noise there, raise the threshold and re-run (it's
cheap; minutes).

#### Code structure (~300 LOC)

```
apps/web/scripts/phase0a-classify-mappings.ts

  parseHmrcName(orgName)           → { candidates, isPublicBody }
  normaliseForComparison(name)     → string
  tokenise(name)                   → string[]
  jaccard(a, b)                    → number

  matchTierA(candidate, ch)        → number | null
  matchTierB(candidate, ch)        → number | null
  matchTierC(candidate, ch)        → number | null

  findLocalAlternatives(...)       → CHCandidate[]
  pickByLocality(alternatives,...) → CHCandidate | 'tied'

  classifyOne(mapping, currentCh, hmrcLocation) → ProposedRow

  main():
    create staging table (idempotent)
    truncate it
    for await (row of streaming join cursor):
      bufferedInsert(classifyOne(row, ...))
    flush
    print summary
    write CSV samples
```

Streamed cursor for the main loop — does not pull all 125k rows into memory.

#### Cost

- **Memory**: O(1) — streams the join cursor
- **DB**: 1 join read pass + 125k inserts to staging (~2-3 minutes)
- **API**: zero
- **Disk**: ~190 MB staging table, ~5 MB CSV samples

### Phase 0b — CH calls for residual (overnight)

Only for rows where Phase 0a returned `suspect_no_local_alternative`. For
each, run the full pipeline (Steps 1-6 above) including CH `/search/companies`
calls with `items_per_page=20` and tier scoring against returned results.

Cache CH search responses to disk as JSON. If we have to re-run after tuning
the threshold or adding a regex, we re-score against the cached responses
without re-paying for API calls.

Update the same staging table (`hmrc_company_mapping_audit_phase0a`) in
place — Phase 0b only writes to rows where `verdict = 'suspect_no_local_alternative'`,
overwriting their `proposed_*` columns and updating `verdict` to a final
value.

Estimated wall time: depends entirely on Phase 0a's residual size. The
projection in the Phase 0a summary tells us before we commit.

### Phase 1 — high-confidence corrections only

Apply changes where ALL of:

- Current mapping is "no overlap, no previous-name match" (the ~3.3k worst
  dissolved + ~8.5k worst active rows we identified)
- New pipeline produces a Tier-A or Tier-B match
- New mapping's CH entity is `active` OR has a more recent
  `date_of_creation` than the current dissolved one

### Phase 2 — public-body cleanup

Apply `is_public_body=true` and null out `company_number` for all
pre-filter matches. Pure metadata change, no risk.

### Phase 3 — fresh inserts going forward

The new pipeline becomes the seed for any HMRC org name not yet in the
mapping table. Nothing exotic — it just *is* the seed from now on.

### Phase 4 — Tier-C audit

Token-similarity matches are inherently fuzzy. Generate a report of the
lowest-scoring Tier-C accepts and eyeball them before adopting. If volume
is small (likely a few hundred), manual review is fine.

---

## Cost & runtime

CH's free public API: **600 requests / 5 minutes** (~2/sec). With ~50k
HMRC sponsors and 1–3 candidate searches per name (worst case, with
retries), full backfill ≈ **100k–150k requests = 4–6 hours of wall time**.

Acceptable for a one-off. Should be runnable in batches so we can pause
and inspect between phases.

---

## Decisions locked in for Phase 0a

These were resolved before building the classifier; recorded here so future
readers don't relitigate them:

1. **Tier-C threshold = 0.85** to start. Re-evaluate from the histogram
   the first run produces; cheap to re-run with a different value.
2. **Staging table name = `hmrc_company_mapping_audit_phase0a`** (real
   table in main DB, not temp — so it's queryable interactively from
   `psql` after the script exits).
3. **`requires_human_review` rows live in the same staging table**,
   filtered by `verdict`. No separate review table.
4. **Public-body regex = the 8 patterns listed in Step 1** of the
   pipeline. Schools and universities are deliberately *not* in the list
   for v1 — many are CH-registered Limited-by-guarantee bodies and we'd
   lose real mappings. Extend later based on what shows up in
   `requires_human_review`.
5. **Tokenisation rules for Tier C** — lowercase; split on `\s+|[,&\-./()]`;
   drop pure-punctuation; drop stopwords (`the`, `and`, `of`, `for`, `at`,
   `in`, `on`); drop suffix tokens (`limited`, `ltd`, `llp`, `plc`, `uk`).
   See "Tokenisation rules" subsection in Phase 0a for the rationale.

## Open questions (defer until after Phase 0a output)

1. **Schema decision for the live table** — nullable `company_number` +
   `match_method` on the existing table, vs. a fresh `_v2` table. First is
   simpler, second makes rollback a one-liner. I lean towards the first
   because we have an audit table anyway. Decide after Phase 0a tells us
   how big the change set is.
2. **Public-body regex coverage** — the 8 starting patterns are the
   obvious ones. Phase 0a's `requires_human_review` and
   `suspect_no_local_alternative` buckets will surface the next layer of
   public bodies we missed (e.g. specific NHS body types, devolved-nation
   councils). Tune iteratively.
3. **What the UI does for `is_public_body=true` rows.** Suggest: show
   sponsor name, route, rating, location, but no "Companies House" panel
   at all (or a small note explaining why). Needs a design call.
4. **Address tiebreaker quality.** HMRC `town_city` is free-text and noisy;
   CH `locality` is also free-text. Exact equality will be too strict. We
   probably want either a postcode-prefix comparison (if we have postcodes
   in HMRC, which I haven't checked) or a soft string-similarity check. May
   not be worth the complexity unless tied results are common in practice.

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
