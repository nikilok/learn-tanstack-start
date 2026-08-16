// Whether a client is worth denying, and on WHICH lever.
//
// Vercel's managed rules judge a request in isolation. This layer judges an identity across the
// whole window, which is what application knowledge buys: we know what our own callers look like,
// what a real session of ours looks like, and which identities are shared.
//
// Two levers, and the choice is not stylistic: a fingerprint survives IP rotation, but it can be
// SHARED, and then the network is the tighter handle. Each passes the same safety test before it
// is offered — nothing legitimate may be riding it.

import {
  UNNAMED_VERIFIED,
  alpnOf,
  dutyCycleOf,
  renderingRequests,
  rendersIndicateBrowser,
} from './ip-signals';
import type { Mix, Shape } from './ip-signals';
import { HEADER_GATED_RULES } from './rule-names';

// Worth-a-rule is a question about sustained volume, so the bar scales with the window: 200
// requests in 24h is quiet, the same 200 in 20 minutes is a scrape. The floor stops a handful of
// requests in a narrow window ever reading as enough to judge.
const MIN_VOLUME_PER_DAY = 200;
const MIN_VOLUME_FLOOR = 50;

/** Requests needed before a window says anything about sustained volume. */
export function volumeFloor(windowMinutes: number): number {
  return Math.max(
    MIN_VOLUME_FLOOR,
    Math.round((MIN_VOLUME_PER_DAY * windowMinutes) / 1440),
  );
}

/**
 * Label of the query these names are matched against. Named rather than inlined because the
 * blocker below has to know when that lookup FAILED — an unrun query returns no rules, which is
 * indistinguishable from a caller holding no credential.
 */
export const WAF_RULE_QUERY = 'waf rule';

// Re-exported so callers reading the advisory do not need to know where the names live.
export { HEADER_GATED_RULES };
// A fingerprint spread wider than this is a proxy pool or a shared client library, not one host.
const WIDE_SPREAD = 8;
// Below this, `duty` degenerates from "runs level" into "was present in both halves".
const MIN_PACING_BUCKETS = 12;
// The top digest must own this share of the subject's traffic before its evidence is attributable.
const DOMINANT_SHARE = 0.9;
// An ASN deny takes a whole network offline, so it must answer most of the identity, not a sliver.
const MIN_ASN_COVERAGE = 0.5;

/**
 * Share of the subject's traffic a named network actually carries.
 *
 * `null` when it cannot be computed, which callers must treat as a refusal: an unknown share is
 * the same kind of thing as an unread reach, and both directions of "assume it is fine" end with
 * a network denied on evidence nobody has.
 */
export function leverCoverage(
  label: string | undefined,
  breakdown: readonly [string, number][],
  total: number,
): number | null {
  if (!label || !Number.isFinite(total) || total <= 0) return null;
  const count = breakdown.find(([name]) => name === label)?.[1];
  // An impossible pair refuses rather than resolves, and the pair CAN be impossible: `total` and
  // this breakdown come from different queries, and `total` falls back to a route-derived figure
  // when the status query degrades to []. Routes exclude denied requests while an ASN grouping
  // counts them, so a heavily-denied identity yields a count far larger than its total. That
  // produced a ratio above 1, which cleared the coverage bar exactly as a strong majority does
  // and offered the network for denial — silently, because the note only prints on refusal.
  if (
    count === undefined ||
    !Number.isFinite(count) ||
    count < 0 ||
    count > total
  )
    return null;
  return count / total;
}

/**
 * Whether traffic is sustained by DURATION rather than by rate.
 *
 * `volumeFloor` asks whether there is enough traffic to say anything about sustained volume, and a
 * request count is only one way to answer that. A client present across most of the window is
 * sustained however slowly it goes — and without this it is unjudgeable at every window the API
 * will serve, because the floor rises at a fixed rate per day while a self-paced client's traffic
 * does not. Widening the window RAISES the bar faster than the evidence grows to meet it, so the
 * advisory's old remedy for a thin identity could never actually be followed.
 *
 * Three guards, all required:
 * - enough buckets for "most of them" to mean anything — the same MIN_PACING_BUCKETS guard the
 *   pacing axis uses, for the same reason: on a short window a duty cycle degenerates into "was
 *   present at all", which is what an ordinary visit looks like;
 * - presence across at least `duty` of them;
 * - MIN_VOLUME_FLOOR requests, this file's existing bar for "enough to measure anything at all".
 *   It is what keeps a client sending one request an hour from becoming judgeable on 24 of them.
 *
 * `duty` comes from the caller, out of `tuning.ts`, rather than living here. It is the cheapest
 * threshold in the tool to evade: staying under a volume floor costs a scraper years of crawling,
 * while bursting into fewer hours costs it nothing, so a published duty share is a free bypass in
 * a way a published volume floor is not. Undefined refuses everything, which widens nothing.
 *
 * This only removes an objection. It adds no tell and no axis, so an identity cleared here still
 * needs two independent axes and a reach carrying no browser evidence before a lever is offered.
 *
 * Callers deriving `activeBuckets` from an observability series: that API ZERO-FILLS every bucket
 * of every group, so counting returned rows marks every identity permanently sustained. Count only
 * the buckets carrying a non-zero measure.
 */
export function sustainedByDuration(
  activeBuckets: number,
  bucketMinutes: number,
  windowMinutes: number,
  total: number,
  duty: number | undefined,
): boolean {
  if (
    duty === undefined ||
    !Number.isFinite(duty) ||
    !Number.isFinite(activeBuckets) ||
    !Number.isFinite(bucketMinutes) ||
    !Number.isFinite(windowMinutes) ||
    !Number.isFinite(total)
  )
    return false;
  if (duty <= 0 || bucketMinutes <= 0 || total < MIN_VOLUME_FLOOR) return false;
  const buckets = windowMinutes / bucketMinutes;
  if (buckets < MIN_PACING_BUCKETS) return false;
  return activeBuckets / buckets >= duty;
}

/**
 * Which of `sustainedByDuration`'s guards refused, phrased to follow "under <floor>, ".
 *
 * Named separately because the guards want different next steps and only one of them is about
 * the client. Reporting a client present in every bucket as "present in only 144 of 144" is the
 * kind of line that makes an operator stop believing the pane.
 */
function notSustainedBecause(
  input: Pick<
    AdviceInput,
    'total' | 'shape' | 'windowMinutes' | 'sustainedDuty'
  >,
): string {
  const buckets = Math.round(
    input.windowMinutes / Math.max(1, input.shape.bucketMinutes),
  );
  if (input.sustainedDuty === undefined)
    return `and the duty threshold could not be read, so duration cannot stand in for volume`;
  if (input.total < MIN_VOLUME_FLOOR)
    return `and under ${MIN_VOLUME_FLOOR} in total, too few for how long it was present to mean anything`;
  if (buckets < MIN_PACING_BUCKETS)
    return `and this window holds only ${buckets} buckets, too few for presence to stand in for volume`;
  return `and present in only ${input.shape.active} of its ${buckets} buckets, so it is neither busy enough nor sustained enough to judge`;
}

/** What an identity does across ALL of its traffic, not just the IP being profiled. */
export type Reach = {
  label: string;
  ips: number;
  countries: number;
  total: number;
  // Every kind only a rendering client produces. Assets and beacons are NOT enough on their own:
  // hashed bundles are cached for a year so a returning browser re-fetches none, and beacons are
  // blocked by uBlock/Brave/ITP for a large share of real users. Map tiles and server-fn RPCs are
  // the same proof and are far harder to suppress.
  subResources: number;
  beacons: number;
  tiles: number;
  rpcs: number;
  /**
   * False when ANY sub-query failed or the path sample was truncated by the 500-group cap.
   * Without it, absent evidence reads as measured zero and clears a blanket deny.
   */
  complete: boolean;
  verifiedNames: string[];
};

/** Evidence that a real browser has rendered from an identity. */
export function browserEvidence(r: Reach): number {
  return r.subResources + r.beacons + r.tiles + r.rpcs;
}

/**
 * Whether a verdict names a lever and therefore wants a human.
 *
 * Single-sourced because `verdict === 'ban'` was written out separately in the exit code, the
 * actionable test, the notification key and the watch display — and the way a second tier goes
 * silent is being added to three of the four.
 *
 * Distinct from `worthInvestigating`, which reads AXES: this asks "is there a live recommendation
 * a human should see", that asks "is this shaped enough to pay an agent to adjudicate". The only
 * gate on APPLYING without a human is `autoBanRefusal`, which compares against `'ban'` exactly —
 * neither of these can widen it.
 */
export function recommendsAction(verdict: string): boolean {
  return verdict === 'ban' || verdict === 'challenge';
}

export type Lever = {
  kind: 'ja4' | 'asn';
  value: string;
  why: string;
  /**
   * Which list the value belongs on. REQUIRED, and deliberately not defaulted: an optional field
   * meaning "deny unless stated" turns any code path that drops it into a silent escalation from
   * interstitial to outage. Every construction site has to say which tier it means.
   */
  tier: 'deny' | 'challenge';
  /** ASN rules key on AS NUMBER, which observability does not expose — the operator supplies it. */
  needsAsNumber?: boolean;
};

export type Advice = {
  // Five distinct states that a coarser verdict kept confusing: act on the hard lever, act on the
  // recoverable one, staged-but-not-live, live-and-done, and legitimate. 'staged' must never read
  // as 'already' — the WAF has not been written yet.
  verdict: 'ban' | 'challenge' | 'watch' | 'staged' | 'already' | 'leave';
  lever?: Lever;
  digest?: string;
  reasons: string[];
  /**
   * The INDEPENDENT axes the evidence fired on, deduplicated by tag.
   *
   * Surfaced because `reasons.length` is the wrong measure and always was: "zero sub-resources"
   * and "pages but no RPCs" are both entailed by not running the app, so counting reasons makes
   * the two-independent-axes rule meaningless. Anything deciding how scraper-shaped an identity
   * is — including whether to spend a paid investigation on it — has to read this, not the prose.
   */
  axes: string[];
  /**
   * True when FW_CHALLENGE_JA4 carries this digest RIGHT NOW, whatever the verdict.
   *
   * A statement about live WAF state, not about the evidence, so it survives every verdict. The
   * `already` path conveyed it through `lever.tier`, which only exists when the challenge tier
   * qualifies — so a challenged digest whose challenge failed to qualify fell through to `watch`
   * and rendered as INCONCLUSIVE while the WAF was interstitialing every one of its requests.
   * An operator reading "no safe lever" concludes nothing is in place and may drop the entry as
   * inert, or fail to connect a user complaint to a mitigation they do not know is running.
   *
   * Output-only and set on every return by `adviseBan`, so no caller can forget it.
   */
  challengeLive?: boolean;
  blockers: string[];
  /** Why a lever was ruled out — the useful half when the answer is "nothing safe applies". */
  leverNotes: string[];
};

/**
 * Whether an identity is shaped enough like a scraper to spend a paid investigation on.
 *
 * The SAME bar a ban needs — two independent axes — and deliberately NOT the verdict, because the
 * verdict also encodes whether a safe lever happened to exist. An identity can be scraper-shaped
 * on two axes and still return `watch` because every handle it has is shared, which is exactly
 * the case that took a human hours on 2026-08-12 and is the one worth automating.
 *
 * It does NOT double as a volume gate, and must not be made into one: the axes fire regardless of
 * volume, and in the watch loop `worthProfiling` has already applied `screenFloor` — never below
 * this module's own floor — so nothing too thin to judge ever becomes a finding. Where evidence is
 * unmeasurable rather than thin (a failed query, a truncated sample) an agent is the right spend
 * precisely because it re-queries live and can get what the screen could not.
 *
 * Widens what gets INVESTIGATED, never what gets applied. `autoBanRefusal` still compares against
 * `'ban'` exactly, and an investigation is read-only by protocol.
 */
export function worthInvestigating(
  advice: Pick<Advice, 'axes' | 'verdict'>,
): boolean {
  // Axes are filled on EVERY path, including the ones where the advisory already concluded — a
  // verified crawler or a first-party service still scores `rendering` and `spread` before
  // `blockersFor` returns `leave`. Reading axes alone therefore wakes a paid agent on Googlebot,
  // which is both a cost and an insult to the blocker that just cleared it. `already` and
  // `staged` are the same shape: the question has an answer, so there is nothing to adjudicate.
  if (advice.verdict === 'leave') return false;
  if (advice.verdict === 'already' || advice.verdict === 'staged') return false;
  return advice.axes.length >= 2;
}

export type AdviceInput = {
  total: number;
  mix: Mix;
  shape: Shape;
  ja4: [string, number][];
  asns: [string, number][];
  botVerified: [string, number][];
  wafActions: [string, number][];
  wafRules: [string, number][];
  statuses: [string, number][];
  digestReach?: Reach;
  asnReach?: Reach;
  alreadyDeniedJa4: boolean; // present in the LIVE rule and applied
  /**
   * Present in FW_CHALLENGE_JA4 — we are ALREADY interstitialing this fingerprint.
   *
   * Required, not optional, and it is not cosmetic: it taints the reach. See `qualifyLever`'s
   * caller below. A default of `false` would mean "not challenged" on any path that forgot to
   * pass it, which is the direction that clears a deny.
   */
  challengedJa4: boolean;
  stagedJa4: boolean; // staged this session, not yet written to the WAF
  alreadyDeniedAsn: boolean;
  windowMinutes: number;
  /** Queries that degraded to [] rather than returning nothing. A failed lookup deletes the
   * blocker it feeds, so the advisory must treat it as unmeasured, not as an absence. */
  failedQueries?: string[];
  /**
   * Header-gated rules whose LIVE definition still demands every credential the built rule does.
   * Undefined means the live config was not read — which is not the same as "none qualify", and
   * must not be collapsed into it.
   */
  trustedAllowRules?: string[];
  /** True when byPath hit the group cap, so every count in `mix` is a floor and a zero
   * rendering count is a truncation artefact rather than a measurement. */
  mixPartial?: boolean;
  rpcsPartial?: boolean;
  /** Verified crawler names on this subject with their counts, from the profile's bot join. */
  verifiedBots?: [string, number][];
  /**
   * Verified crawlers we want, lower-cased (FW_ALLOWED_BOTS). Verification proves identity, not
   * welcome: an SEO or AI harvester passes it exactly as a search engine does.
   *
   * Undefined means the list was not read, and that is NOT "allow none" — it falls back to
   * exempting every verified bot, the behaviour before this list existed. The safe direction
   * here is the permissive one: failing to read a config file must never turn Googlebot into a
   * ban candidate.
   */
  allowedBots?: string[];
  /**
   * Share of the window a slow client must be present across before duration substitutes for
   * volume (FW_SUSTAINED_DUTY_PCT, via `tuning.ts`).
   *
   * Undefined means unread, and unlike `allowedBots` the safe direction here is the RESTRICTIVE
   * one: the persistence gate simply does not fire and the volume floor governs alone, which is
   * how this advisory behaved before the gate existed. A default would both widen what gets
   * judged on a number nobody chose and put the number back in a public repo.
   */
  sustainedDuty?: number;
};

/**
 * Verified crawler names on this identity that we actually want, lower-cased.
 *
 * An unread allowlist returns every verified name, not none: the fallback has to be the
 * permissive one, because the failure it guards against is a config read turning Googlebot into
 * a ban candidate. Names absent from a list that WAS read are deliberately omitted — that is the
 * narrowing.
 */
export function welcomeBots(
  verified: readonly [string, number][],
  allowed: readonly string[] | undefined,
): [string, number][] {
  const names = verified.filter(([n]) => n);
  if (!allowed) return [...names];
  const want = new Set(allowed.map((n) => n.toLowerCase()));
  // UNNAMED_VERIFIED is a placeholder for "verified, name not reported" — never a name an
  // operator lists, so matching it against the allowlist always removed it and stripped the
  // protection it was added to preserve.
  return names.filter(
    ([n]) => n === UNNAMED_VERIFIED || want.has(n.toLowerCase()),
  );
}

/** The name-only form, for reach, which carries names without counts. */
export function welcomeNames(
  names: readonly string[] | undefined,
  allowed: readonly string[] | undefined,
): string[] {
  if (!names?.length) return [];
  if (!allowed) return [...names];
  const want = new Set(allowed.map((n) => n.toLowerCase()));
  return names.filter(
    (n) => n === UNNAMED_VERIFIED || want.has(n.toLowerCase()),
  );
}

/** Reasons this client is LEGITIMATE — statements about the client itself, which outrank everything. */
function blockersFor(input: AdviceInput): string[] {
  const out: string[] = [];
  // Names, not the bare `pass` flag. Verification says a crawler is who it claims; it says
  // nothing about whether we want it reading the corpus, and an SEO or AI harvester passes it
  // exactly as a search engine does. Only the names on FW_ALLOWED_BOTS earn the exemption.
  const verified = input.verifiedBots?.length
    ? welcomeBots(input.verifiedBots, input.allowedBots)
    : // No names available (an older caller, or the bot join failed) — fall back to the flag, so
      // a missing name can never strip a real crawler's protection.
      input.botVerified.filter(([v]) => v === 'pass');
  if (verified.length)
    out.push(
      `verified bot (${verified.map(([v, c]) => `${v}:${c}`).join(', ')}) — denying it is a self-inflicted outage`,
    );
  // An authentication fact, not a heuristic: our allow rules match on PRESENCE of a bespoke
  // secret header, so a hit means the caller held our credential.
  // Only rules that authenticate with a bespoke secret header prove a first-party caller. A
  // name prefix is not enough: an allow-* rule that matches on anything the caller controls (a
  // User-Agent, say) would certify every spoofer as first-party AND make them unbannable, so
  // membership of this list is explicit and a new allow-* rule cannot join it by accident.
  const allowRule = input.wafRules.find(([name]) =>
    HEADER_GATED_RULES.includes(name),
  );
  // A hit only means what the LIVE rule makes it mean. `trustedAllowRules` names the rules whose
  // live definition still demands every credential the built rule demands; a rule that has lost
  // one is satisfiable by anyone, and a hit on it proves nothing while looking identical.
  // Checked rather than assumed, because that difference is invisible in the hit itself.
  const trusted = input.trustedAllowRules;
  if (allowRule && trusted?.includes(allowRule[0]))
    out.push(
      `matched ${allowRule[0]} (${allowRule[1]}x), a rule only our own callers can satisfy — this is a first-party caller`,
    );
  // Everything else about this blocker fails closed, because it is the one protecting our own
  // services and they resemble the thing being hunted on every other axis. Cannot-tell is not
  // did-not-happen.
  else if (allowRule && trusted && !trusted.includes(allowRule[0]))
    out.push(
      `matched ${allowRule[0]} (${allowRule[1]}x), but that rule no longer requires everything it should — it can be satisfied by anyone, so this proves nothing either way. Re-apply the firewall rules.`,
    );
  else if (allowRule && !trusted)
    out.push(
      `matched ${allowRule[0]} (${allowRule[1]}x), but the live rule was not read, so whether it still means anything is UNKNOWN`,
    );
  else if (input.failedQueries?.includes(WAF_RULE_QUERY))
    out.push(
      'the WAF-rule lookup failed, so whether this caller matched one of our own rules is UNKNOWN — a first-party service is indistinguishable from a harvester without it',
    );
  // A hard blocker, not merely a lever disqualifier: the agent could egress from the same
  // network too, so an ASN deny would catch it just as surely as a fingerprint deny.
  // Same narrowing as above: a fingerprint shared with a crawler we WANT is a shared identity
  // worth protecting. Shared with a harvester we do not want, it is just the harvester.
  const sharedWith = welcomeNames(
    input.digestReach?.verifiedNames,
    input.allowedBots,
  );
  if (sharedWith.length)
    out.push(
      `the fingerprint also carries verified ${sharedWith.join(', ')} — a SHARED identity, not one actor; no lever is safe`,
    );
  // Share-based and POOLED, never absolute. One deliberate /favicon.svg per 10,000 page fetches
  // would otherwise immunise a scraper forever — and so would one /_serverFn ping, one map tile
  // or one forged POST to /_vercel/insights, which the three separate `> 0` tests all allowed.
  // Pooling also means a light-but-real session still clears the floor on the sum.
  const renders = renderingRequests(input.mix);
  // `mix.page` is only a usable denominator while RPC attribution is trustworthy. Unattributed
  // /_serverFn requests stay in `page`, so a short fn list shrinks `renders` and grows `pages` by
  // the SAME residual — a double-sided error that turns a real SPA session into a headless
  // enumerator. Passing 0 skips the proportionality test and keeps the pooled share test, which
  // is the fail-safe direction: the blocker still fires, it just stops being strictened by a
  // number we cannot stand behind.
  const pages = input.rpcsPartial ? 0 : input.mix.page;
  if (rendersIndicateBrowser(renders, input.total, pages)) {
    const share = ((renders / Math.max(1, input.total)) * 100).toFixed(1);
    out.push(
      `${renders} rendering requests (${share}%: ${input.mix.asset} sub-resources, ${input.mix.rpc} server-fn RPCs, ${input.mix.tile} map tiles, ${input.mix.beacon} analytics beacons) — it is running the app, which is what a real session looks like here`,
    );
  }
  // Gated on the mix having been MEASURED. A failed paths/routes query degrades to [], so every
  // count reads 0 and this blocker fires purely because nothing was fetched — returning a green
  // DO NOT DENY on a 9,000-request scraper, and short-circuiting before unjudgeableFor could
  // ever mention that the measurement failed.
  const mixMeasured = !input.mixPartial && !input.failedQueries?.length;
  if (mixMeasured && input.mix.page === 0)
    out.push(
      `fetches no content pages (${input.mix.api} API, ${input.mix.rpc} RPC) — there is nothing here to enumerate`,
    );
  return out;
}

/**
 * Reasons the EVIDENCE cannot support a decision. Deliberately separate from legitimacy: "too
 * few requests to tell" is a fact about the window, not a finding that the client is innocent,
 * and rendering it as a green DO NOT DENY told the operator the opposite of the truth.
 */
function unjudgeableFor(input: AdviceInput): string[] {
  const out: string[] = [];
  // Before anything measured: a blocker fed by a failed query is silently absent, and absence is
  // what this advisory reads as innocence. qualifyLever already refuses on incomplete reach; the
  // legitimacy blockers had no equivalent, so a timed-out rule-name lookup deleted the
  // first-party blocker while the pane still rendered DENY RECOMMENDED.
  if (input.failedQueries?.length)
    out.push(
      `${input.failedQueries.join(', ')} could not be measured — a blocker that depends on them would be silently absent, so this is unjudged, not cleared`,
    );
  if (input.mixPartial)
    out.push(
      'the path sample hit the API group cap, so the rendering counts are floors — a zero here may be a dropped tail rather than a raw-HTML fetcher',
    );
  const floor = volumeFloor(input.windowMinutes);
  // The same NaN hole as the qualifiers, one layer earlier and pointing the other way: an
  // unreadable total does not fall UNDER the floor, so it silently clears the volume gate and the
  // identity proceeds to be judged on a number nobody has.
  const unusable = unusableMetric([['request total', input.total]]);
  if (unusable)
    out.push(
      `${unusable} — the window's own volume could not be read, so nothing here is judgeable`,
    );
  // Volume OR duration. A client pacing itself under the floor used to be told to widen the
  // window, which is advice it is impossible to take: the floor scales at a fixed rate per day,
  // so every wider window raised the bar faster than the client's traffic rose to meet it, and
  // the API caps the window at a week regardless. Presence across most of the window answers the
  // same question — is this sustained — without asking it to go faster first.
  else if (
    input.total < floor &&
    !sustainedByDuration(
      input.shape.active,
      input.shape.bucketMinutes,
      input.windowMinutes,
      input.total,
      input.sustainedDuty,
    )
  )
    out.push(
      `only ${input.total} requests in this window — under ${floor}, ${notSustainedBecause(input)}`,
    );
  if (!input.ja4.length)
    out.push('no TLS fingerprint recorded — nothing to identify it by');
  return out;
}

/**
 * The first metric that is not a usable number, described, or null when all of them are.
 *
 * NaN defeats every comparison SILENTLY and in both directions: `NaN < floor` is false, so it
 * walks past a lower bound, and `NaN > 0` is false, so it walks past an upper bound too. An
 * unmeasured value therefore arrives looking like a measured clean one — which is this codebase's
 * defining defect, an error path producing something shaped like an answer.
 *
 * `autoBanRefusal` has guarded exactly this since it shipped, for exactly this reason. The
 * qualifiers below did not, and they are the more dangerous place for it: a refused auto-ban costs
 * another look, while a wrongly CLEARED lever is what puts a digest in front of an operator with
 * "no browser has ever rendered from it" attached to it.
 *
 * Negatives are refused alongside NaN: a count below zero is not a measurement either.
 */
function unusableMetric(
  metrics: readonly (readonly [string, number])[],
): string | null {
  for (const [what, v] of metrics)
    if (!Number.isFinite(v) || v < 0)
      return `${what} is not a usable number (${v})`;
  return null;
}

/** Whether an identity is safe to deny wholesale, and why not when it is not. */
export function qualifyLever(
  reach: Reach | undefined,
  kind: 'fingerprint' | 'network',
  /** Verified crawlers we want. Undefined means unread — every verified name still disqualifies. */
  allowed?: readonly string[],
): { ok: boolean; note: string } {
  if (!reach)
    return {
      ok: false,
      note: `${kind} reach unknown — cannot clear it for a deny`,
    };
  const shared = welcomeNames(reach.verifiedNames, allowed);
  if (shared.length)
    return {
      ok: false,
      note: `${kind} ${reach.label} carries verified ${shared.join(', ')} — shared, not one actor`,
    };
  // The decisive guard. "No browser has ever rendered from it" is an affirmative claim, and a
  // failed query or a truncated sample produces the same zeros as a genuine absence. Clearing a
  // blanket deny on evidence that was never fetched is how real networks get denied.
  if (!reach.complete)
    return {
      ok: false,
      note: `${kind} ${reach.label} could not be fully measured (a query failed or the path sample hit the API's 500-group cap) — absence of evidence is not evidence, so it is not cleared`,
    };
  // A VACUOUS PASS is the failure this guards, and it was live: `Byteplus Pte. Ltd.` surfaced as
  // an offered ASN lever on 2 requests site-wide over 6 days. It cleared because zero of 2 render,
  // which is true and says nothing — "no browser has ever rendered from this network" is an
  // affirmative claim, and two requests cannot support it. The operator would then have looked up
  // a cloud provider's AS number and denied the range to stop 0.3% of one scraper.
  //
  // The subject's volume has been floored since the beginning; the REACH never was.
  //
  // MIN_VOLUME_FLOOR, deliberately, NOT the window-scaled `volumeFloor`. This is the "cannot say
  // anything at all" line, not the "sustained volume" one — a browser renders many requests per
  // page, so a few dozen requests with zero sub-resources genuinely is browser-free, while two
  // requests is not evidence of anything. Scaling it to the reach span instead put the bar an
  // order of magnitude higher and refused a legitimate low-volume backdoor scanner, which is the
  // opposite error: a floor that stops the tool acting on real findings is not a safety property.
  //
  // Window-independent on purpose: reach is pinned to >= 6 days whatever is on screen, so a
  // 20-minute view must not buy a cheaper reach test than a six-day one.
  // BEFORE the comparisons, never after: each one below is a `<` or a `>`, and NaN slips past
  // both. `browserEvidence` sums four fields, so a single unreadable one poisons the whole total
  // and turns "shows N rendering requests" into a silent pass.
  const browsery = browserEvidence(reach);
  const unusable = unusableMetric([
    ['request total', reach.total],
    ['IP count', reach.ips],
    ['rendering requests', browsery],
  ]);
  if (unusable)
    return {
      ok: false,
      note: `${kind} ${reach.label}: ${unusable} — unmeasured is not measured-clean, so it is not cleared`,
    };
  if (reach.total < MIN_VOLUME_FLOOR)
    return {
      ok: false,
      note: `${kind} ${reach.label} has only ${reach.total} requests across the whole reach — under ${MIN_VOLUME_FLOOR}, too little for "nothing here renders" to mean anything. Not cleared, and not condemned either.`,
    };
  if (browsery > 0)
    return {
      ok: false,
      note: `${kind} ${reach.label} shows ${browsery} rendering requests (assets/beacons/tiles/RPCs) — real browsers render from it, so a blanket deny would hit users`,
    };
  return {
    ok: true,
    note: `${kind} ${reach.label} has ZERO rendering requests across ${reach.total} requests from ${reach.ips} IPs — no browser has ever rendered from it`,
  };
}

/**
 * Whether the RECOVERABLE tier applies: the identity is scraper-shaped, but its fingerprint is
 * shared with real browsers, so a deny would hit them.
 *
 * This is the case a deny-only tool has no answer for, and it is the common one — a JA4 is a
 * client BUILD, so the popular ones carry a browser population permanently. Measured 2026-08-12
 * on `t13d1516h2_cccccccccccc_111111111111`: over six days it carried 73 IPs of real sessions
 * (map tiles, fonts, `/sw.js`, beacons), and in the last day 416 IPs fetching one page each and
 * rendering nothing at all. One digest, two populations, split by TIME rather than by address.
 * `mix` is the window the operator is looking at and `digestReach` is the >= 6 day history, so
 * that split is already measured — it just had nowhere to go.
 *
 * The premise is that a challenge separates them: a browser solves it, a client that never
 * fetches a sub-resource is not running JavaScript and cannot. So the test is on the SUBJECT
 * window's rendering being an actual measured zero, not merely low. A client that renders at all
 * might solve the challenge, and then the interstitial is a tax on users for nothing.
 *
 * A verified crawler we want disqualifies this exactly as hard as it disqualifies a deny, and the
 * "recoverable" framing must not be allowed to soften it: Googlebot cannot solve a challenge
 * either, so challenging it deindexes the site just as surely as denying it would.
 */
export function qualifyChallenge(
  input: AdviceInput,
  reach: Reach | undefined,
  /** Verified crawlers we want. Undefined means unread — every verified name still disqualifies. */
  allowed?: readonly string[],
): { ok: boolean; note: string } {
  if (!reach)
    return {
      ok: false,
      note: 'fingerprint reach unknown — a challenge is recoverable, but it is still an action, and this one is unmeasured',
    };
  const shared = welcomeNames(reach.verifiedNames, allowed);
  if (shared.length)
    return {
      ok: false,
      note: `fingerprint ${reach.label} carries verified ${shared.join(', ')} — a crawler cannot answer a challenge any more than it can survive a deny, so this tier is no softer for it`,
    };
  if (!reach.complete)
    return {
      ok: false,
      note: `fingerprint ${reach.label} could not be fully measured — unknown escalates to a human, it does not decay into the cheaper action`,
    };
  // No re-test of mixPartial/failedQueries here: unjudgeableFor returns `watch` for both before
  // any lever is consulted, so a branch for them could never execute. Reachability is checked
  // rather than assumed — two guards have shipped in this file that read perfectly and were dead.
  // THE SAME FLOOR AS `qualifyLever`, and it belongs here for a reason specific to this tier.
  // Adding it there and not here was the twin-miss this codebase warns about above all others:
  // one instance fixed, its sibling left, and the sibling is reachable — a thin reach is refused
  // for the deny and then falls straight through to the challenge.
  //
  // "Recoverable, so a lower bar is fine" does not survive contact with the note below, which
  // claims the fingerprint is SHARED. That claim is the entire justification for choosing this
  // tier over a deny, and a reach of a handful of requests cannot support it.
  // Same NaN guard as the deny qualifier, and it covers the SUBJECT side too: `renders` and
  // `input.total` are both compared below and both come from a mix that a failed query degrades.
  const renders = renderingRequests(input.mix);
  const unusable = unusableMetric([
    ['reach request total', reach.total],
    ['reach rendering requests', browserEvidence(reach)],
    ['window request total', input.total],
    ['window rendering requests', renders],
  ]);
  if (unusable)
    return {
      ok: false,
      note: `fingerprint ${reach.label}: ${unusable} — a challenge is the cheaper action but it is still an action, and this one is unmeasured`,
    };
  if (reach.total < MIN_VOLUME_FLOOR)
    return {
      ok: false,
      note: `fingerprint ${reach.label} has only ${reach.total} requests across the whole reach — under ${MIN_VOLUME_FLOOR}, too little to call it shared, which is the only reason to prefer a challenge over a deny`,
    };
  if (renders > 0)
    return {
      ok: false,
      note: `${renders} rendering requests in this window — a challenge only stops a client that cannot run JavaScript, so this would tax real users and catch nothing`,
    };
  return {
    ok: true,
    note: `zero rendering requests across ${input.total} in this window, while the ${reach.label} reach shows ${browserEvidence(reach)} across ${reach.ips} IPs — the fingerprint is SHARED, so a deny would hit browsers and a challenge separates them`,
  };
}

/**
 * Recommend a control. `ban` needs zero blockers, a scraper shape on at least two axes, AND a
 * lever that passes its own safety test — one tell is coincidence, and a lever that cannot be
 * cleared is worse than no action at all.
 */
export function adviseBan(input: AdviceInput): Advice {
  // Kept apart from the real blockers: being already denied is not a reason the client is
  // legitimate, it is a reason there is nothing further to do.
  const blockers = blockersFor(input);
  const denied = input.alreadyDeniedJa4
    ? ['fingerprint is already in FW_BLOCKED_JA4 — nothing to add']
    : [];
  // Axis-tagged: "zero sub-resources" and "pages but no RPCs" are both entailed by the single
  // fact that a client does not run the app, so counting them as two tells made the threshold
  // "one tell is coincidence" meaningless. Two tells must now come from two INDEPENDENT axes.
  const reasons: string[] = [];
  const axes = new Set<string>();
  const tell = (axis: string, text: string) => {
    axes.add(axis);
    reasons.push(text);
  };
  const { mix, shape } = input;

  // The same share-gated predicate blockersFor uses, not an absolute zero on each kind: one
  // stray RPC used to delete this axis entirely while the blocker two functions up correctly
  // held that one request proves nothing. The advisory cannot have it both ways.
  const renders = renderingRequests(mix);
  if (!rendersIndicateBrowser(renders, input.total, input.mix.page))
    tell(
      'rendering',
      renders === 0
        ? `zero rendering requests across ${input.total} requests — a raw-HTML fetcher`
        : `only ${renders} rendering requests across ${input.total} — too few to be running the app`,
    );
  if (input.ja4.some(([d]) => alpnOf(d) === '00'))
    tell('tls', 'offers no ALPN — no mainstream browser does that');
  // Tagged 'rendering', NOT its own axis: this test forces mix.page > 0, and nothing that walks
  // a sitemap also drives RPCs, so it is entailed by the rendering axis above. Counting it
  // separately let the single fact "a crawler that does not run JavaScript" satisfy the
  // two-independent-axes rule on its own and ban a polite unverified search engine.
  if (mix.crawl > 0 && mix.page > mix.crawl * 10)
    tell(
      'rendering',
      `read the sitemap then fetched ${mix.page} pages — the enumeration pattern`,
    );
  // dutyCycleOf is shared with tellsFor so the two panes measure pacing the same way. The
  // THRESHOLDS stay separate on purpose: this one gates a ban, and widening it is a change to
  // who gets denied, not a display fix.
  //
  // The old second clause was `concentration < 0.5`, which made this axis DEAD rather than
  // strict: sessions split on >=2 idle buckets, so level traffic is ONE unbroken session whose
  // concentration is 1.0 — "level AND unconcentrated" could never both hold, for anyone.
  //
  // The threshold is calibrated, not chosen — measured against the population that can ACTUALLY
  // be denied, with verified bots and first-party services excluded because a blocker stops
  // those before axes are consulted. Calibrating on the whole population instead lets them bury
  // the signal; that mistake killed two earlier attempts at this. Re-measure before changing it,
  // and exclude the same two classes when you do. The figures are deliberately not recorded
  // here: this repo is public, and a distribution is a map of where to sit to stay under it.
  //
  // Gated on a NARROW reach because a rhythm only means "one actor" for a non-aggregate
  // identity: a shared fingerprint runs flat because many people use it, not because it is a
  // machine. Unknown reach does not fire either — that is the safe direction. A wide-spread
  // actor loses nothing, since `spread` is already its own axis.
  const duty = dutyCycleOf(shape, input.windowMinutes);
  // "Level" is only distinguishable from "present at all" when the window holds enough buckets.
  // On the shortest presets a duty cycle degenerates into "was present throughout", which is
  // what an ordinary visit looks like, so the threshold cannot transfer down to them. Twelve
  // buckets is two hours at 10-minute granularity and twelve at 60-minute — the shortest span
  // where the measure means what its name says. See the tests for the degenerate cases.
  const bucketCount = input.windowMinutes / Math.max(1, shape.bucketMinutes);
  if (
    bucketCount >= MIN_PACING_BUCKETS &&
    duty > 0.5 &&
    input.digestReach &&
    input.digestReach.ips <= WIDE_SPREAD
  )
    tell(
      'pacing',
      `busy in ${(duty * 100).toFixed(0)}% of all ${shape.bucketMinutes}-minute buckets, from an identity on only ${input.digestReach.ips} IP${input.digestReach.ips === 1 ? '' : 's'} — machines run flat, people burst and idle`,
    );
  if (input.digestReach && input.digestReach.ips > WIDE_SPREAD)
    tell(
      'spread',
      `the fingerprint spans ${input.digestReach.ips} IPs across ${input.digestReach.countries} countries — per-IP limits cannot see it`,
    );

  // Context on whether acting is worth it, separate from whether it is safe. A client already
  // challenged on every request, or one that only ever gets 404s, is not reading anything.
  const acted = input.wafActions
    .filter(([a]) => a === 'challenge' || a === 'deny')
    .reduce((n, [, c]) => n + c, 0);
  // 4xx is TWO different findings and they were counted as one.
  //
  // A 404 is the SITE's answer: the client asked for something that does not exist, which is
  // probing. A 403 or 429 is OUR answer: the paths may be perfectly real and we are simply turning
  // it away. Lumped together, a fully-mitigated crawler read as a scanner — the opposite
  // diagnosis, and it would have argued against a lever that was working. Measured on a real
  // Googlebot impersonator: 502 of 502 responses were 429s, against 497 valid company pages.
  const statusesMatching = (match: (code: string) => boolean): number =>
    input.statuses
      .filter(([code]) => match(code))
      .reduce((n, [, c]) => n + c, 0);
  const notFound = statusesMatching((c) => c === '404' || c === '410');
  const context: string[] = [];
  // Mitigation is reported from wafActions, NOT from status codes. A 403 or 429 says the client
  // was turned away but not BY WHOM — the origin can answer either — whereas wafAction is
  // attributed by construction. A second note keyed on 4xx said the same thing as this one on
  // every real case, and said it without knowing whether we were the ones who did it.
  if (acted >= input.total * 0.9)
    context.push(
      `managed rules already challenge or deny ${acted} of ${input.total} — an explicit deny mainly saves the challenge round-trip`,
    );
  if (notFound >= input.total * 0.9)
    context.push(
      `${notFound} of ${input.total} responses say the page is not there (404/410) — it is finding nothing, so this is probing rather than harvesting`,
    );

  const digest = input.ja4[0]?.[0];
  const leverNotes: string[] = [...context];
  // Legitimacy first: it is the only class that means "this client is fine".
  if (blockers.length)
    return {
      verdict: 'leave',
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers: [...blockers, ...denied],
      leverNotes,
    };
  // Already handled outranks "cannot tell" — a denied scraper seen through a narrow window is
  // still denied, and showing it as DO NOT DENY invited the operator to undo the ban.
  if (input.alreadyDeniedJa4)
    return {
      verdict: 'already',
      digest,
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers: denied,
      leverNotes,
    };
  // Staged outranks "cannot tell" for the same reason 'already' does: the operator has decided,
  // and flipping their screen back to INCONCLUSIVE because one of ~21 queries failed reads as
  // "your keypress was rejected" — so they never press `a` and the deny is never written.
  if (input.stagedJa4)
    return {
      verdict: 'staged',
      digest,
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers: [],
      leverNotes,
    };
  const unjudgeable = unjudgeableFor(input);
  if (unjudgeable.length)
    return {
      verdict: 'watch',
      digest,
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers: [],
      leverNotes: [...leverNotes, ...unjudgeable],
    };
  if (axes.size < 2)
    return {
      verdict: 'watch',
      digest,
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers,
      leverNotes,
    };

  // Reasons are computed over the subject's WHOLE traffic, but the ja4 lever denies one digest.
  // If the subject carries several, the evidence cannot be attributed to the one being denied —
  // a co-resident scraper's no-ALPN tell would otherwise ban a browser-negotiating fingerprint.
  const ja4Total = input.ja4.reduce((n, [, c]) => n + c, 0);
  const topShare = ja4Total ? (input.ja4[0]?.[1] ?? 0) / ja4Total : 0;
  if (input.ja4.length > 1 && topShare < DOMINANT_SHARE) {
    leverNotes.push(
      `evidence spans ${input.ja4.length} fingerprints (top one is only ${(topShare * 100).toFixed(0)}% of traffic) — it cannot be attributed to the digest a deny would target`,
    );
    return {
      verdict: 'watch',
      digest,
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers,
      leverNotes,
    };
  }

  // Fingerprint first: it survives IP rotation, which is why it beat the per-IP rules.
  const ja4Ok = qualifyLever(
    input.digestReach,
    'fingerprint',
    input.allowedBots,
  );
  // OUR OWN CHALLENGE CENSORS THE EVIDENCE THAT WOULD CLEAR THIS DENY.
  //
  // A browser that meets the interstitial and does not solve it never goes on to fetch a single
  // sub-resource, so it contributes ZERO rendering requests. Over a >= 6 day reach the pre-challenge
  // rendering ages out, `qualifyLever` reads a clean zero, and its note says "no browser has ever
  // rendered from it" — which by then is a statement this tool manufactured rather than measured.
  // The verdict would flip from `challenge` to `ban` on the strength of it.
  //
  // The coupling is what makes it dangerous rather than merely wrong: the zero only appears if the
  // challenge is FAILING for real browsers, so the tool would recommend the harsher control in
  // exactly the case where the softer one is already hurting people. It is this codebase's
  // recurring defect — an absence read as a measurement — with our own hand on the cause.
  //
  // So a challenged digest can never clear the fingerprint deny automatically. Lift the challenge,
  // let a full reach window pass, and measure again; or override it deliberately with `b`.
  if (input.challengedJa4 && ja4Ok.ok) {
    ja4Ok.ok = false;
    ja4Ok.note = `fingerprint ${input.digestReach?.label ?? digest} reads as having zero rendering requests, but it is ALREADY on FW_CHALLENGE_JA4 — a challenged browser never fetches sub-resources, so that zero is one this tool caused and cannot be used to clear a deny. Lift the challenge and re-measure over a full reach window.`;
  }
  leverNotes.push(ja4Ok.note);
  if (ja4Ok.ok && digest)
    return {
      verdict: 'ban',
      digest,
      lever: { kind: 'ja4', value: digest, why: ja4Ok.note, tier: 'deny' },
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers,
      leverNotes,
    };

  // The network, when the fingerprint is shared. This is the velia.net test: an ASN that has
  // never served a sub-resource has never served a real browser.
  const asnOk = qualifyLever(input.asnReach, 'network', input.allowedBots);
  const asn = input.asnReach?.label ?? input.asns[0]?.[0];
  // Coverage, not just cleanliness. `qualifyLever` asks whether the NETWORK is browser-free and
  // cannot ask whether denying it would achieve anything, because it never sees the subject. A
  // client spread across a proxy pool has an arbitrary top ASN — hundreds of them, flat, in a
  // long tail — so the biggest sliver clears the reach test honestly and is still the wrong
  // thing to deny. That is the vacuous pass one layer above the volume floor: true, measured,
  // and about nothing. It surfaced the moment a self-paced identity became judgeable at all,
  // which is what made it worth closing here rather than parking.
  const asnShare = leverCoverage(asn, input.asns, input.total);
  const asnCovers = asnShare !== null && asnShare >= MIN_ASN_COVERAGE;
  leverNotes.push(
    input.alreadyDeniedAsn
      ? 'network is already in FW_BLOCKED_ASN'
      : asnOk.ok && !asnCovers
        ? `network ${asn} carries ${asnShare === null ? 'an unknown share' : `only ${(asnShare * 100).toFixed(0)}%`} of this identity's requests — denying a whole network to stop a fraction of one client is the wrong trade, and the rest of it would keep running`
        : asnOk.note,
  );
  if (asnOk.ok && asnCovers && !input.alreadyDeniedAsn && asn)
    return {
      verdict: 'ban',
      digest,
      lever: {
        kind: 'asn',
        value: asn,
        why: asnOk.note,
        tier: 'deny',
        // Observability reports asnName; FW_BLOCKED_ASN keys on the AS number, and no dimension
        // bridges them, so the number has to be supplied when staging.
        needsAsNumber: true,
      },
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers,
      leverNotes,
    };

  // Scraper-shaped, but every handle it has is shared with something legitimate. That is not a
  // dead end any more: it is the definition of the recoverable tier's case. Reached only after
  // both denies were refused, so a challenge is never recommended where a deny was already clean.
  const challengeOk = qualifyChallenge(
    input,
    input.digestReach,
    input.allowedBots,
  );
  leverNotes.push(challengeOk.note);
  // Already interstitialed: recommending the action that is live invites applying it twice, which
  // is the same reason `already` exists for the deny tier. The lever is still attached, and its
  // tier is what tells the view to say ALREADY CHALLENGED rather than ALREADY DENIED — those are
  // different facts and an operator acts differently on them.
  if (challengeOk.ok && digest && input.challengedJa4)
    return {
      verdict: 'already',
      digest,
      lever: {
        kind: 'ja4',
        value: digest,
        why: challengeOk.note,
        tier: 'challenge',
      },
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers: [
        'fingerprint is already in FW_CHALLENGE_JA4 — challenged, not denied',
      ],
      leverNotes,
    };
  if (challengeOk.ok && digest)
    return {
      verdict: 'challenge',
      digest,
      lever: {
        kind: 'ja4',
        value: digest,
        why: challengeOk.note,
        tier: 'challenge',
      },
      reasons,
      axes: [...axes],
      challengeLive: input.challengedJa4,
      blockers,
      leverNotes,
    };

  // Scraper-shaped, and not even the recoverable lever is clear.
  return {
    verdict: 'watch',
    digest,
    reasons,
    axes: [...axes],
    challengeLive: input.challengedJa4,
    blockers,
    leverNotes,
  };
}
