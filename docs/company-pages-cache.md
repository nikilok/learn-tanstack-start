# Cache freshness for company pages

Status: DECIDED, 2026-08-02 — **the simple design shipped**; the queue below is
preserved as the escalation path, not the plan.

## What shipped: one population tag, purged after every sweep

Every long-cached company-scoped response — the SSR document (population tag
alone when the sponsor has no CH mapping) and the company RPCs
(companiesHouse, companyWebsite, companyTimeline, hmrcCompanyBySlug,
slugForHash) — carries the edge-cache tag `company-pages`, alongside its own
`company-{number}` where the number is known. One header write via
`setCompanyCacheTag` in `src/api/cache-headers.ts` (the pure
`src/api/cache-tags.ts` owns both tag spellings), because
`setResponseHeader` overwrites and two calls would drop a tag. After each
sweep run, its workflow makes one call:
`POST /api/revalidate?purge=company-pages` (fixed whitelist, same secret) —
awaited, 200 on success, 500 on API failure so the workflow step goes red —
which is a single `invalidateByTags` call regardless of population size.

Two facts collapsed the case for anything fancier:

- **Every production deploy already purges the entire edge cache, and this
  repo deploys most days.** The site has always lived with resets harder than
  this one; the sweep's invalidation is gentler still (see below).
- **Promotions arrive in batches, on the sweep's schedule** (05:43, 13:43 and
  21:43 since the search discoverer went to four runs a day and the sweep to
  three). Sub-batch purge latency — the queue's main virtue — still has no
  consumer: the sweep is the only writer of what a company page renders, so
  there is no promotion that lands between its runs and waits.

What the purge actually does: `invalidateByTags` marks entries STALE, it does
not delete them. The next request per page serves the stale copy instantly and
revalidates in the background — so there is no cold-cache cost at all, and in
exchange each page shows a promotion one visit late (a page crawled once a day
sees yesterday's state on today's crawl and freshens behind it). Deploys
remain the true full resets, with fresh-on-first-visit semantics. If
first-visit freshness after the sweep ever matters — crawler-facing during the
SEO recovery, say — the escalation is the SDK's `dangerouslyDeleteByTags`
(true MISS, origin-stampede risk). The queue below is the escalation for a
different cost — per-company precision at sub-day latency — and it still
invalidates, so these stale-while-revalidate semantics remain.

Operational note: the endpoint answers a neutral 202 on AUTH failure by
design (no signal to probes), but the workflow step requires
`200 {purged:true}` — so a wrong secret (202), an unset one (pre-curl
assert), invalidation switched off (`purged:false`), and an API failure
(500) all turn the step red. Genuinely stale pages under green crons →
check the Vercel function logs first.

---

# APPENDIX: why the obvious alternatives were rejected

Kept because the analysis is the expensive part — each of these was proposed
seriously, and the reasons matter more than the verdicts.

## The problem

Company pages render from database state but are edge-cached for 30 days under
a `company-{number}` tag. Nothing purges a page when its state changes, so
freshness today comes from two accidents: production deploys (which purge the
whole edge cache) and 30-day expiry.

This became visible the night search discovery went live: the first
search-discovered websites appeared on their pages only because nobody had
visited those pages since the evening's deploy — every validation fetch was a
cache MISS that SSR'd fresh. The unfavourable case is silent: a page visited
and cached *before* its row passed the render gate serves the stale copy for up
to 30 days. The same applies in reverse when a website is withdrawn.

Two producers of staleness exist today, and more are plausible:

| producer | event | today |
|---|---|---|
| ch-stream (Railway) | CH profile changed | drained via trails table + cursor |
| website sweep (3x daily) | render outcome flipped | **nothing — the gap** |
| future: manual edits, name backfills, … | page-affecting write | nothing |

## The existing mechanism, precisely

`POST /api/revalidate` (Nitro, secret-authed, neutral 202 to unauthenticated
callers) is already a queue drain with the right operational properties:

- `invalidateTags` batches **16 tags per Vercel API call** (hard limit)
- caps itself at **5 batches per invocation** (Vercel allows 5 calls/min),
  so one invocation purges ≤ 80 companies
- on purge failure the cursor does not advance → automatic retry
- overflow "rolls to the next call"

But its *source* is `companies_house_profile_trails` — which is not a purge
queue. It is the timeline feature's source-of-record (`companyTimeline.ts` and
`search/sql.ts` read it), and the drain reads it as a side effect, tracking its
position with a cursor row in a third table. The semantics are muddled: one
table, two meanings.

## Designs considered and rejected

Recorded because each was proposed seriously, and the reasons matter more than
the verdicts.

**1. `companies: []` request body on the endpoint** (the original phase-4 plan).
The sweep would accumulate promoted numbers and POST batches. Rejected: the
purge list lives in process memory between flushes, so a sweep timeout loses
it; the producer must reimplement pacing; every producer needs the secret; and
two producers POSTing concurrently share the 5/min budget with no coordination.

**2. Insert sweep events into the trails table.** Zero new schema, the drain
already reads it. Rejected outright: a trail row *means* "this company's CH
profile changed", and the timeline renders from that meaning. Website
promotions inserted there would fabricate profile-change events on public
company timelines.

**3. Dirty-flag column on `company_websites`** (`purge_pending_at`, partial
index, watermark-cleared by the drain). Elegant for exactly one producer — the
state lives on the row it describes, dedupe is free. Rejected on the scaling
question: every future producer grows another flag column on another domain
table and another bespoke drain phase in the endpoint. Three producers in, the
endpoint is a coordinator of heterogeneous queues. The per-domain flag
optimises "no new table" at the cost of "new drain source per domain", which is
the wrong trade.

**4. A real broker (Kafka or similar).** The pattern *is* pub/sub — multiple
producers, at-least-once delivery, rate-limited consumer — but the numbers are
off by orders of magnitude in every dimension that justifies a broker:

| brokers are priced for | this workload |
|---|---|
| events/sec | events/**day** (a few hundred) |
| many consumer groups | exactly one consumer, forever |
| replay, ordered history | worthless — purge is idempotent "refresh" |
| horizontal consumer scaling | forbidden — Vercel caps the drain at 80/min |
| dedupe via log compaction | needed instantly, via PRIMARY KEY — this is a SET, not a log |

The bottleneck is the consumer's legal ceiling, not queue throughput. And a
broker inherits the dual-write problem (DB commits, publish fails, or vice
versa) whose textbook fix is… an outbox table in Postgres relaying to the
broker. Adding Kafka means building this design *plus* a broker on top.

## If the daily purge ever proves too blunt

The escalation is a `cdn_purge_queue` table as a transactional outbox — one
narrow waist that N producers INSERT into and the revalidate endpoint drains
under its existing 16-tag/5-per-min budget. The shape, so it need not be
re-derived: `cdn_purge_queue(company_number varchar PRIMARY KEY, enqueued_seq
bigint NOT NULL)` — one row per company (a SET, not a log), written in the
same transaction as the row change (no dual-write) via `INSERT … ON CONFLICT
(company_number) DO UPDATE SET enqueued_seq = nextval('cdn_purge_seq')`, with
sweep enqueues gated on render-outcome *transitions* rather than stamps. The
drain SELECTs a batch, invalidates, then deletes each row guarded on the seq
it read (`DELETE … WHERE company_number = $n AND enqueued_seq = $s`) — a
same-company change landing mid-drain bumps the seq, fails the guarded
delete, and survives to the next call. The guard is an integer sequence, NOT
`enqueued_at`: timestamp-equality locks already bit this repo once (Neon
truncates microseconds — the phase-5 sweep freeze). Migrating the trails
drain onto the same waist ends with the trails cursor row deleted. Build it
only when a measured cost — function bill, crawler TTFB — says the blunt
purge hurts.
