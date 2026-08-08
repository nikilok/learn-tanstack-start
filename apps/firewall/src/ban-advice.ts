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

export type Lever = {
  kind: 'ja4' | 'asn';
  value: string;
  why: string;
  /** ASN rules key on AS NUMBER, which observability does not expose — the operator supplies it. */
  needsAsNumber?: boolean;
};

export type Advice = {
  // Four distinct states that a coarser verdict kept confusing: act, staged-but-not-live,
  // live-and-done, and legitimate. 'staged' must never read as 'already' — the WAF has not
  // been written yet.
  verdict: 'ban' | 'watch' | 'staged' | 'already' | 'leave';
  lever?: Lever;
  digest?: string;
  reasons: string[];
  blockers: string[];
  /** Why a lever was ruled out — the useful half when the answer is "nothing safe applies". */
  leverNotes: string[];
};

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
  return names.filter(([n]) => want.has(n.toLowerCase()));
}

/** The name-only form, for reach, which carries names without counts. */
export function welcomeNames(
  names: readonly string[] | undefined,
  allowed: readonly string[] | undefined,
): string[] {
  if (!names?.length) return [];
  if (!allowed) return [...names];
  const want = new Set(allowed.map((n) => n.toLowerCase()));
  return names.filter((n) => want.has(n.toLowerCase()));
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
  if (rendersIndicateBrowser(renders, input.total, input.mix.page)) {
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
  if (input.total < floor)
    out.push(
      `only ${input.total} requests in this window — under ${floor}, too little to judge sustained volume. Widen the window.`,
    );
  if (!input.ja4.length)
    out.push('no TLS fingerprint recorded — nothing to identify it by');
  return out;
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
  const browsery = browserEvidence(reach);
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
  const missed = input.statuses
    .filter(([code]) => code.startsWith('4'))
    .reduce((n, [, c]) => n + c, 0);
  const context: string[] = [];
  if (acted >= input.total * 0.9)
    context.push(
      `managed rules already challenge or deny ${acted} of ${input.total} — an explicit deny mainly saves the challenge round-trip`,
    );
  if (missed >= input.total * 0.9)
    context.push(
      `${missed} of ${input.total} responses are 4xx — it is finding nothing, so this is probing rather than harvesting`,
    );

  const digest = input.ja4[0]?.[0];
  const leverNotes: string[] = [...context];
  // Legitimacy first: it is the only class that means "this client is fine".
  if (blockers.length)
    return {
      verdict: 'leave',
      reasons,
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
      blockers: denied,
      leverNotes,
    };
  // Staged outranks "cannot tell" for the same reason 'already' does: the operator has decided,
  // and flipping their screen back to INCONCLUSIVE because one of ~21 queries failed reads as
  // "your keypress was rejected" — so they never press `a` and the deny is never written.
  if (input.stagedJa4)
    return { verdict: 'staged', digest, reasons, blockers: [], leverNotes };
  const unjudgeable = unjudgeableFor(input);
  if (unjudgeable.length)
    return {
      verdict: 'watch',
      digest,
      reasons,
      blockers: [],
      leverNotes: [...leverNotes, ...unjudgeable],
    };
  if (axes.size < 2)
    return { verdict: 'watch', digest, reasons, blockers, leverNotes };

  // Reasons are computed over the subject's WHOLE traffic, but the ja4 lever denies one digest.
  // If the subject carries several, the evidence cannot be attributed to the one being denied —
  // a co-resident scraper's no-ALPN tell would otherwise ban a browser-negotiating fingerprint.
  const ja4Total = input.ja4.reduce((n, [, c]) => n + c, 0);
  const topShare = ja4Total ? (input.ja4[0]?.[1] ?? 0) / ja4Total : 0;
  if (input.ja4.length > 1 && topShare < DOMINANT_SHARE) {
    leverNotes.push(
      `evidence spans ${input.ja4.length} fingerprints (top one is only ${(topShare * 100).toFixed(0)}% of traffic) — it cannot be attributed to the digest a deny would target`,
    );
    return { verdict: 'watch', digest, reasons, blockers, leverNotes };
  }

  // Fingerprint first: it survives IP rotation, which is why it beat the per-IP rules.
  const ja4Ok = qualifyLever(
    input.digestReach,
    'fingerprint',
    input.allowedBots,
  );
  leverNotes.push(ja4Ok.note);
  if (ja4Ok.ok && digest)
    return {
      verdict: 'ban',
      digest,
      lever: { kind: 'ja4', value: digest, why: ja4Ok.note },
      reasons,
      blockers,
      leverNotes,
    };

  // The network, when the fingerprint is shared. This is the velia.net test: an ASN that has
  // never served a sub-resource has never served a real browser.
  const asnOk = qualifyLever(input.asnReach, 'network', input.allowedBots);
  leverNotes.push(
    input.alreadyDeniedAsn
      ? 'network is already in FW_BLOCKED_ASN'
      : asnOk.note,
  );
  const asn = input.asnReach?.label ?? input.asns[0]?.[0];
  if (asnOk.ok && !input.alreadyDeniedAsn && asn)
    return {
      verdict: 'ban',
      digest,
      lever: {
        kind: 'asn',
        value: asn,
        why: asnOk.note,
        // Observability reports asnName; FW_BLOCKED_ASN keys on the AS number, and no dimension
        // bridges them, so the number has to be supplied when staging.
        needsAsNumber: true,
      },
      reasons,
      blockers,
      leverNotes,
    };

  // Scraper-shaped, but every handle it has is shared with something legitimate.
  return { verdict: 'watch', digest, reasons, blockers, leverNotes };
}
