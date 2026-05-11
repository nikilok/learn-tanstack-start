# Review queue resolver — ML re-ranker approach

Status: **proposed (2026-05-11).** No code yet. Companion to
[hmrc-ch-mapping-fix.md](hmrc-ch-mapping-fix.md) and
[phase5-sweep-algorithm.md](phase5-sweep-algorithm.md).

This doc was originally drafted (2026-05-09) as an agentic LLM-based
resolver — a script that called the Claude API to verify proposed
mappings. That approach is parked. The new direction is to learn ML
from first principles by training a search re-ranker on the data this
codebase has accumulated, and then apply that model to drain the
review queue.

The filename stays for continuity. The scope is bigger than the queue
now — the re-ranker is also the right fix for the original `items[0]`
bug in `seed-companies-house.ts` (and the on-demand resolver in
`getCompanyProfile`). The review queue is just the most immediate place
to apply it.

---

## The one-paragraph summary

Companies House's `/search/companies?q=<name>` endpoint returns a list
of candidates ranked by a fuzzy relevance score. That score is wrong
~5-15% of the time for our queries — it weights typo-similar dissolved
shells and trading-name fragments more than it should. We're going to
train a machine-learning model that takes the top-20 candidates CH
returns plus a set of additional signals (registered addresses,
previous names, status, dates, locality from HMRC) and re-ranks them.
The output replaces `items[0]` everywhere we currently trust CH's first
result. The 140 rows in `hmrc_company_mapping_review_queue` become
test cases for the trained model: cases the deterministic ladder
couldn't decide, where the re-ranker either agrees with the proposed
swap (resolve), disagrees (close as rejected), or doesn't know (leave
for manual review).

---

## Why this approach (the learning rationale)

The site itself runs at negative financial ROI. Its purpose is
capability-building. So the question isn't "what's the cheapest way to
drain 140 queue rows" — it's "what's the highest-learning path that
also produces something useful". Three properties make this a good
learning project:

1. **Real dataset, already on disk.** ~400k labelled `(query,
   candidate, label)` rows can be assembled from the existing phase0b
   cache without a single new API call (see "Data we have" below).
   Most ML tutorials use synthetic or toy data; this is real
   production data with real noise.
2. **Classical, well-trodden problem.** Learning-to-rank (LTR) is one
   of the most-studied problems in ML. Every search engine
   (Google, Bing, Elasticsearch's `learning-to-rank` plugin,
   recommendation systems) uses some version of it. The skills
   transfer everywhere.
3. **Concrete production destination.** The re-ranker drops into
   `seed-companies-house.ts` at the `items[0]` site. You'll see it
   take effect on real user-facing data, not stay as a notebook
   experiment.

The trade is time. A LightGBM-class model takes a few weeks to do
properly (data → baseline → model → evaluation → deployment). A
Claude API call takes an afternoon. We're choosing the weeks.

---

## ML vocabulary primer (skim if familiar)

A few terms that show up everywhere in this doc and in any ML
documentation you'll read. Bookmark this section — you'll come back
to it.

- **Sample (or row, or example).** One labelled data point. For us:
  one `(query, candidate, label)` triple. "Did this CH candidate match
  the HMRC org name?"
- **Feature.** A number derived from the input that the model uses.
  Examples: "edit distance between query and candidate name",
  "candidate is active (1) or dissolved (0)", "candidate's
  previous_company_names contains the query name (1/0)".
- **Label (or target).** The thing the model tries to predict. For us:
  1 if the candidate is the correct match, 0 if not.
- **Training set / validation set / test set.** You split your data
  three ways:
    - **Train** (~70%): the model learns from this.
    - **Validation** (~15%): used during training to tune
      hyperparameters and decide when to stop training. Touch it
      often.
    - **Test** (~15%): the model never sees this until the very end.
      Used once, to report final numbers. If you "tune on the test
      set", your numbers are lies.
- **Hyperparameter.** A knob on the model you set before training.
  Learning rate, tree depth, number of trees. Tune by trying values
  and measuring validation performance.
- **Loss function (or objective).** The math the model tries to
  minimise. Ranking problems have three loss families:
    - **Pointwise**: predict a score for each candidate independently.
      Simplest.
    - **Pairwise**: predict which of two candidates is better. Better
      for ranking.
    - **Listwise**: optimise the order of the full candidate list at
      once. Best, what LightGBM's `lambdarank` does.
- **Overfitting.** Model memorises training data including its noise
  and performs poorly on data it hasn't seen. Detected by
  train-accuracy ≫ validation-accuracy.
- **Baseline.** The simplest possible model or rule. Anything more
  sophisticated must beat this. For us: the current `items[0]`
  behaviour *is* the baseline.
- **NDCG, MRR, Precision@1.** Standard ranking metrics:
    - **Precision@1**: did we put the right answer first? Our primary
      metric.
    - **MRR (mean reciprocal rank)**: how high up is the right answer
      on average? Reciprocal of the rank (1/1, 1/2, 1/3, …) averaged
      over queries.
    - **NDCG (normalised discounted cumulative gain)**: weighted
      score where higher positions matter more. Standard in IR.
- **Feature importance.** A number per feature telling you how much
  the model relied on it. Tree-based models give this for free.

---

## Data we have

### What's on disk

The `phase0b` resolver run cached every CH API call it made:

- **20,017 search responses** in
  `apps/web/.cache/phase0b/search-*.json`, one per HMRC org, each
  with up to 20 candidates plus full metadata per candidate
  (status, addresses, dates, name, type).
- **41,534 profile fetches** in
  `apps/web/.cache/phase0b/profile-*.json`, one per top candidate
  the resolver evaluated, with the full CH profile (including
  `previous_company_names`).
- **409 MB total** — fits comfortably on a laptop, in memory if
  loaded as parquet.

### Anatomy of one search file

Filename: `search-<hash>-<slugified-query>.json`. Body:

```json
{
  "query": "Joceyln Cares Domiciliary Limited",
  "fetched_at": "2026-04-27T01:07:18.705Z",
  "response": {
    "items": [
      {
        "company_number": "15682337",
        "title": "CARESPRING SUPPORTED LIVING LTD",
        "company_status": "active",
        "date_of_creation": "2024-04-26",
        "address": { "address_line_1": "...", "postal_code": "..." },
        "snippet": "CARESPRING DOMICILIARY LTD",
        ...
      },
      { "company_number": "12061363", "title": "JOCELYN CARES DOMICILIARY LIMITED", ... },
      ...up to 20 items
    ],
    "total_results": 1757
  }
}
```

Note the bug at position 0 here: CH ranked "Carespring Supported
Living" above the literal-match "Jocelyn Cares Domiciliary Limited",
because the snippet contained the search query in a different company's
*previous name* listing. This is exactly the items[0] failure mode we
want the re-ranker to fix.

### Where labels come from

Each cached search file's `query` field is an HMRC organisation name.
That same name is the primary key in `hmrc_company_mapping`. So the
join is trivial:

```python
query = file["query"]                              # "Joceyln Cares Domiciliary Limited"
correct = hmrc_company_mapping[query].company_number    # "12061363"

for candidate in file["response"]["items"]:
    label = 1 if candidate["company_number"] == correct else 0
```

Each search file with 20 candidates produces 20 labelled rows. Most
files have one positive (label=1) and 19 negatives (label=0). Some
have zero positives (the correct answer wasn't in the top 20) —
those are *real* `no_match` cases.

### What you'll end up with

A single `training.parquet` file with ~400k rows, one row per `(query,
candidate, label)` tuple. Columns will include:

```
query, query_slug, query_normalised,
candidate_position, candidate_company_number, candidate_title,
candidate_status, candidate_creation_date, candidate_dissolution_date,
candidate_address_line_1, candidate_postcode, candidate_locality,
candidate_country, candidate_type, candidate_previous_names_json,
hmrc_town_city, hmrc_county,
label
```

You can join `candidate_previous_names_json` from the profile cache
keyed on `candidate_company_number`. That join is the difference
between a model that knows about renames and one that doesn't.

### Two caveats worth knowing before you train

**1. The 20k is not a uniform random sample.** Phase 0b targeted
*suspect* mappings — the ones most likely to be wrong. So the slice
is enriched for hard cases. That's actually *good* for training a
re-ranker focused on the hard cases (which is where the deterministic
ladder fails today), but it means your model's reported accuracy will
overstate the gain on randomly-sampled future queries. When you
evaluate, do it on multiple slices: phase0b suspects, and a freshly
sampled random slice from the broader 125k mappings.

**2. Some labels are wrong.** Phase 0a estimated 5-15k out of 125k
mappings were incorrect. The phase0b slice overlaps that population
by design. Mitigations:

- Filter training labels to `match_method IN ('exact', 'previous_name')`
  only — those are the high-confidence labels.
- Use `token_sim` and `no_match` rows for evaluation, not training.
- Or train with a noise-tolerant ranking loss (LightGBM's `rank_xendcg`
  handles label noise reasonably well).

---

## The plan, in phases

Each phase is a self-contained chunk. If you're new to ML, expect to
spend at least a week per phase. The goal is not to rush to a deployed
model — it's to actually understand each step. Skipping ahead breaks
the learning.

### Phase A — Build the dataset

**What you do:** Write a Python script (in `ml/build-dataset.py` or
similar) that walks `apps/web/.cache/phase0b/`, joins the search
responses + profile responses + `hmrc_company_mapping` rows from the
DB, and writes a single `training.parquet`. No models, no training, no
predictions — just data assembly.

**What you'll learn:**

- Setting up a Python ML environment (`uv` is the modern choice; `venv`
  + `pip` works fine).
- Working with `polars` or `pandas` for tabular data.
- Parquet as the standard ML data interchange format (columnar,
  compressed, fast to read).
- Joining heterogeneous data sources (JSON files + Postgres) into a
  single flat table.
- The iron law of ML: garbage in, garbage out. Most of your time on a
  real project goes here, not on the model.

**Definition of done:** `training.parquet` exists, ~400k rows, you've
inspected it with `polars.read_parquet(...).describe()` and the
distributions look sane (most queries have exactly one positive,
status field has expected enum values, etc.).

### Phase B — Measure the baseline

**What you do:** Before training anything, measure how well the
current `items[0]` approach performs. For each query in your dataset,
take the candidate at position 0 and check if its `company_number`
matches the correct one. Report:

- Overall precision@1 across all queries.
- Precision@1 broken down by `match_method` (the rows we marked
  `exact` should already be near-perfect; the interesting splits are
  `token_sim` and `previous_name`).
- Precision@1 on a uniform-random slice of the broader 125k, not just
  phase0b.

**What you'll learn:**

- Why "I built a model and it got 87% accuracy" is meaningless without
  a baseline. The baseline might already be 87%.
- How to read a confusion matrix.
- Slicing your data — overall metrics hide subgroup performance.
- The phrase you'll repeat for the rest of your ML career: *first,
  measure.*

**Expected result:** Items[0] accuracy is probably ~75-85% on the
phase0b slice (this is the suspect slice, so lower) and ~95%+ on
uniform-random mappings (since most queries have a clear winner).

### Phase C — A trivial learned re-ranker (logistic regression)

**What you do:** Train the simplest possible learned model — logistic
regression — on hand-engineered features. The features should be
boring on purpose: you want to internalise feature engineering before
adding model complexity.

Starting feature set:

- `name_token_jaccard`: Jaccard similarity between query tokens and
  candidate title tokens.
- `name_edit_ratio`: normalised Levenshtein ratio.
- `name_in_previous_names`: 1 if the candidate's
  `previous_company_names` contains the query (normalised), 0
  otherwise.
- `address_postcode_match`: 1 if HMRC's `town_city`/`county` overlap
  the candidate's `registered_office_address`, 0 otherwise.
- `is_active`: 1 if candidate `company_status == 'active'`.
- `is_dissolved`: 1 if candidate is `dissolved` or `liquidation`.
- `position_inverse`: `1 / (1 + position)` — CH's prior, encoded as a
  feature instead of a hard rule.

Train with scikit-learn's `LogisticRegression`. Inspect the learned
coefficients — they tell you which features the model relied on. If
`name_in_previous_names` has a high positive coefficient (it should),
you've confirmed what you suspected. If `is_dissolved` has a high
positive coefficient, you have a bug.

**What you'll learn:**

- Feature engineering — most of what makes ML work, especially on
  tabular data.
- Train/validation/test split discipline (do this even with a tiny
  model so it becomes muscle memory).
- Scikit-learn API conventions (`fit`, `predict`, `predict_proba`).
- Coefficient interpretation: linear models are interpretable in a
  way deep models aren't. Treasure this — it teaches you what your
  data actually contains.

**Definition of done:** Logistic regression on validation set beats
the baseline (Phase B) by at least 3-5 percentage points on
precision@1.

### Phase D — LightGBM, the real LTR model

**What you do:** Same features as Phase C, but a proper gradient-boosted
ranking model. LightGBM is the industry standard for tabular LTR. Use
`LGBMRanker` with the `lambdarank` objective.

```python
import lightgbm as lgb

model = lgb.LGBMRanker(
    objective="lambdarank",
    metric="ndcg",
    n_estimators=500,
    learning_rate=0.05,
    num_leaves=63,
)
# Group by query — ranking treats candidates as siblings under a query
model.fit(X_train, y_train, group=query_group_sizes,
          eval_set=[(X_val, y_val)], eval_group=[val_query_group_sizes],
          callbacks=[lgb.early_stopping(50)])
```

The key conceptual leap from Phase C: LightGBM doesn't predict
"probability this candidate is correct" in isolation. It predicts a
*relative score* such that the correct candidate within each query
outranks the others. This is what `group=` parameter encodes — it tells
LightGBM which rows belong to the same query and should be ranked
together.

After training, look at `model.feature_importances_`. The split between
"split count" and "gain" importance is worth understanding. Plot
distributions of predicted scores for label=1 vs label=0 rows; you
want them well-separated.

**What you'll learn:**

- Gradient-boosted decision trees — the most-used family of models in
  industry on tabular data.
- Ranking objectives (`lambdarank` specifically — it directly
  optimises NDCG).
- Early stopping — letting the model decide when to stop training
  based on validation performance.
- Feature importance plots and what they hide (a feature can be
  important on average but useless for specific queries).
- Hyperparameter tuning with Optuna (later — start with reasonable
  defaults).

**Definition of done:** LightGBM on validation beats logistic
regression by another 3-5 percentage points, and beats baseline by
8-15 percentage points on the phase0b suspect slice.

### Phase E — Evaluation on a real test set

**What you do:** The 400k training rows are auto-labelled (with some
noise). For a final, honest evaluation, you need hand-labelled cases
that look like production hard cases.

Take the 140 unresolved `hmrc_company_mapping_review_queue` rows. For
each:

1. Look at the `proposed_company_number`, the `existing_company_number`,
   and the cached `ch_search_results_top5`.
2. Open both CH profiles in a browser. Decide yourself which is the
   right answer (or "none of the above").
3. Record your decision in a small JSON or CSV file: `(organisation_name,
   correct_company_number_or_null, your_reasoning)`.

This is *tedious* and that's the point — manual labelling is where
real ML practitioners spend a surprising amount of time. You can't
shortcut this; the LLM doing it for you would defeat the learning
goal, and worse, you'd be evaluating the model against another model's
opinions.

Once labelled, run your Phase D model over these 140 cases. Report
precision@1 and where the model disagrees with you.

**What you'll learn:**

- Why hand-labelled evaluation sets are the gold standard.
- The difference between "model accuracy on auto-labelled data" and
  "model accuracy on data you trust" — these can be very different
  numbers.
- Spotting your own model's failure modes. When you disagree with the
  model, *why* did it pick the wrong answer? Is there a missing
  feature?

**Definition of done:** You have a 140-row hand-labelled test file,
the model has been evaluated against it, and you can articulate
specifically where the model struggles.

### Phase F — Deployment

**What you do:** Ship the trained model into the actual codebase.
Two practical options:

**Option 1 — Python sidecar service.** Run a tiny FastAPI process that
loads the model and exposes `POST /rerank`. TS code calls it over
HTTP. Pros: clean separation, model can be retrained without touching
TS. Cons: a new process to deploy/monitor.

**Option 2 — ONNX export.** Convert the LightGBM model to ONNX format
and run inference in TypeScript using `onnxruntime-node`. Pros: no
new service, everything stays in the existing TS deploy. Cons: ONNX
export of GBM models has sharp edges; you'll spend time on conversion.

Recommend Option 1 for the learning path — it's the standard
production pattern and you'll learn FastAPI as a bonus.

Wire it into `seed-companies-house.ts` at the `items[0]` site:

```ts
const candidates = await searchCH(orgName);
const reranked = await fetch('/rerank', { ... }).then(r => r.json());
const top = reranked[0];   // was: candidates[0]
```

**What you'll learn:**

- ML deployment patterns (model serialisation, service boundaries).
- The cost of "the model works on my laptop" — different Python
  versions, missing libraries, version mismatches on the model file.
- Why ML monitoring matters — once deployed, you'll want to know if
  the model's behaviour drifts.

**Definition of done:** The re-ranker is wired into one production
code path (start with `seed-companies-house.ts` since it's offline
and lower-risk than `getCompanyProfile`).

### Phase G — Apply to the review queue

**What you do:** Now that the model exists, use it to drain the
queue. Write a Python script that:

1. Reads each unresolved row from `hmrc_company_mapping_review_queue`.
2. Reconstructs the (query, candidates) pair from the cached
   `ch_search_results_top5`.
3. Runs the re-ranker.
4. If top-1 is the `proposed_company_number` AND the score margin
   over top-2 is above some threshold → call `applyPromotion` with
   `changed_by = 'reranker_v1'`, then close the queue row.
5. Otherwise → leave open for manual review.

The "score margin" threshold is a tunable. Start strict (high margin
required → fewer auto-resolutions but high confidence) and relax it
as you build trust.

**What you'll learn:**

- Calibration — how do you turn a model score into a decision
  threshold?
- The cost of false positives vs false negatives in a production
  setting. Wrong auto-resolution costs more than leaving a row open.
- Working with `applyPromotion` from Python (call the same Nitro
  endpoint via HTTP, rather than reimplementing the CTE).

**Definition of done:** Some non-zero portion of the 140 queue rows
gets resolved automatically, with the rest left for manual review.

---

## Phases that come later (optional, in order)

### Phase H — Embedding-based name similarity

The most obvious gap in Phases A-G is that the name-matching features
are all classical (Jaccard, Levenshtein). Modern name matching uses
learned embeddings. Train a `sentence-transformers` model on pairs
of (HMRC name, correct CH canonical name) with contrastive loss, then
add a `name_embedding_cosine_similarity` feature to the LightGBM
model. Often adds another 2-5 percentage points.

What you'll learn: modern retrieval stack (HuggingFace, contrastive
learning, hard-negative mining, ANN indexes like FAISS or pgvector).

### Phase I — Fine-tune a small LLM as a verdict-maker

Take the 140 hard cases + synthetic training data from Phase A.
Fine-tune a Llama-3.2-3B or Qwen-2.5-3B with LoRA to output `{verdict:
'verified' | 'rejected' | 'low_confidence', reasoning: string}`. Run
it locally (Ollama or vLLM). Use as the final-pass verdict-maker on
residual queue rows that the re-ranker is uncertain about.

What you'll learn: PEFT, LoRA, the modern fine-tuning workflow, when
fine-tuning is the wrong answer (most of the time — for ranking, the
LightGBM model will almost certainly be better).

---

## Where this leaves the queue

Phase G drains *some* of the 140 queue rows. The rest will be cases
where the model is genuinely uncertain — that's the right outcome
for an ML system that knows its own limits.

The residual rows have three reasonable destinations:

1. **Manual resolution.** A small admin UI to triage the leftovers by
   hand. Eventually worth building.
2. **A re-trained model.** As you label more cases yourself (Phase E
   pattern), the model has more hard examples to learn from. Periodic
   retraining (quarterly?) keeps it sharp.
3. **A fine-tuned LLM as last-line judge** (Phase I).

The queue stops being a backlog problem and becomes a calibration
signal: an *informative* set of cases the deterministic + learned
pipeline can't handle.

---

## What this doc deliberately doesn't cover

- **The LLM agentic resolver.** Parked. The previous version of this
  doc described that path; it stays available in git history. If
  someone needs the queue drained in a week, that path is still
  valid.
- **Production ML infrastructure** (model versioning, monitoring,
  retraining cadence, A/B testing). All real concerns, none of them
  the right thing to learn first. Worry about them when the model is
  in production for real.
- **`applyPromotion` changes.** No changes needed. It stays the
  single-responsibility atomic write. The Python script in Phase G
  calls it (via the Nitro server route, not directly) when the model
  is confident enough to act.
- **Phase 5 sweep changes.** No changes needed initially. Eventually
  the re-ranker could replace the deterministic search-result-picking
  in `resolveOneSponsor`, but that's a Phase F+ migration, not a Day 1
  goal.

---

## Reading list

In rough order of difficulty:

- **scikit-learn user guide** — the canonical Python ML library.
  Read the intro chapters even if you don't use sklearn long-term;
  the API conventions are everywhere.
- **LightGBM ranking docs** — `LGBMRanker` API, `lambdarank`
  objective, the `group` parameter for ranking.
- **Eugene Yan's blog** (eugeneyan.com) — practical ML writeups from
  industry. His "Real-world Recommendation System" series and his
  posts on search/ranking are gold.
- **"Learning to Rank for Information Retrieval"** (Liu, 2009) — the
  original survey paper. Foundational, technical, but readable.
- **HuggingFace sentence-transformers tutorials** — when you get to
  Phase H.
- **The XGBoost paper** (Chen & Guestrin, 2016) — gradient-boosted
  trees explained by their inventor. Less essential than the above,
  but worth reading once you've used the library a bit.

---

## Where the code lives

A new app at `apps/ml-reranker/`, alongside `apps/web/` and
`apps/ch-stream/`. The monorepo already mixes deploy targets (Vercel
for `web`, Railway for `ch-stream`); adding a Python app for ML
training and a model-serving container fits the pattern.

```
apps/ml-reranker/
  pyproject.toml          # uv-managed Python project
  uv.lock
  .python-version
  README.md
  .gitignore              # data/, models/*.tmp, .venv, __pycache__
  src/
    build_dataset.py      # Phase A
    baseline.py           # Phase B
    train_logistic.py     # Phase C
    train_lightgbm.py     # Phase D
    evaluate.py           # Phase E (uses hand_labels.json)
    serve.py              # Phase F (FastAPI inference sidecar)
    resolve_queue.py      # Phase G
  data/                   # gitignored — regenerable from phase0b cache
    training.parquet
    hand_labels.json
  models/                 # checked in once a version is stable
    lightgbm-v1.txt
```

### Why a separate app, not a folder inside `apps/web`

- **Different toolchain.** uv/pip and Bun should never share a tree.
  `apps/web` has Bun/TS/Vite tooling that gets confused by Python
  artefacts; Python tooling expects a clean `pyproject.toml` root.
- **Different runtime.** CPython vs Bun. The model-serving sidecar
  runs as its own process, deployed separately.
- **Different deploy target.** `apps/web` deploys to Vercel.
  `apps/ml-reranker`'s serving component deploys to Railway (or Fly,
  or any container host) as a long-running inference service — same
  shape as `apps/ch-stream`, different process.
- **Different CI lanes.** Lint, type-check, test commands diverge.
  Keeping them in separate `apps/*` lets each have its own
  `package.json`-equivalent + Turbo task graph.

### What about database access?

`@ss/db` is a TS package — Python can't import it directly. Two
options, in order of preference:

1. **Direct SQL via `psycopg` (or `asyncpg`).** Python connects to the
   same Neon database using the same connection string from env.
   Read raw rows from `hmrc_company_mapping`, `hmrc_skilled_workers`,
   `hmrc_company_mapping_audit`. The schema is stable enough that
   hand-written SQL in Python is fine — these are batch read-only
   queries on a few tables, not application code.
2. **Drizzle's introspection / schema export.** Drizzle can dump the
   schema to SQL; Python could read it. More machinery than this
   problem deserves at the learning stage.

The first option is what you want. The Python script needs only read
access; writes happen via the TS `applyPromotion` Nitro endpoint
(Phase G).

### Sharing secrets

The Python app reads the same `DATABASE_URL` env var as
`apps/ch-stream` and `apps/web`. Local development: a `.env.local` in
`apps/ml-reranker/` that's gitignored. Production (when the inference
service deploys to Railway): set the env var on the Railway project,
same pattern as ch-stream.

---

## First concrete step

Set up `apps/ml-reranker/` and write the Phase A script. Don't think
about models yet. Get `training.parquet` on disk, read it back, print
the column distributions, scroll through 50 random rows by hand. The
feature ideas for Phase C will surface from doing that — staring at the
data is where intuition forms, not in any textbook.

Bootstrap sequence:

```sh
mkdir -p apps/ml-reranker/{src,data,models}
cd apps/ml-reranker
uv init --python 3.12
uv add polars psycopg pyarrow tqdm
# Phase A starts here — write src/build_dataset.py
```

Add `apps/ml-reranker/data/` and `apps/ml-reranker/.venv/` to the
repo-root `.gitignore` before you commit. The parquet file alone will
be hundreds of MB once built — you don't want it tracked.
