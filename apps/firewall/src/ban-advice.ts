// Whether a client is worth denying, and on WHICH lever.
//
// Vercel's managed rules judge a request in isolation. This layer judges an identity across the
// whole window, which is what application knowledge buys: we know what our own callers look like,
// what a real session of ours looks like, and which identities are shared.
//
// Two levers, and the choice is not stylistic. A residential-proxy scraper spends one IP per
// request, so its TLS fingerprint is the only stable handle. But a fingerprint can be SHARED — by
// verified agents, by our own services, or by every Chromium on earth — and then the network is
// the tighter handle instead. Each lever passes the same test before it is offered: no verified
// bot, and NO SUB-RESOURCES ANYWHERE ON IT. Anything that ever rendered a page pulled CSS, fonts
// and analytics; an identity showing none of that has never served a real user.

import { alpnOf, assetsIndicateBrowser } from './ip-signals';
import type { Mix, Shape } from './ip-signals';

// Below this an IP is not worth a rule — rules are evaluated on every request forever.
const MIN_VOLUME = 200;
// Names of rules gated on a bespoke secret header — the only ones that prove a first-party
// caller. Kept here rather than matched by prefix so a future allow-* rule cannot join by accident.
export const HEADER_GATED_RULES = [
  'allow-ch-stream-revalidate',
  'allow-desktop-release-record',
];
// A fingerprint spread wider than this is a proxy pool or a shared client library, not one host.
const WIDE_SPREAD = 8;
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
};

/** Reasons nothing at all should be denied, whatever the shape looks like. */
function blockersFor(input: AdviceInput): string[] {
  const out: string[] = [];
  const verified = input.botVerified.filter(([v]) => v === 'pass');
  if (verified.length)
    out.push(
      `verified bot (${verified.map(([v, c]) => `${v}:${c}`).join(', ')}) — denying it is a self-inflicted outage`,
    );
  // An authentication fact, not a heuristic: our allow rules match on PRESENCE of a bespoke
  // secret header, so a hit means the caller held our credential.
  // Only rules that authenticate with a bespoke secret header prove a first-party caller. A
  // name prefix is not enough: allow-social-preview matches a caller-controlled User-Agent, so
  // trusting it would certify any UA-spoofing scraper as first-party AND make it unbannable.
  const allowRule = input.wafRules.find(([name]) =>
    HEADER_GATED_RULES.includes(name),
  );
  if (allowRule)
    out.push(
      `matched ${allowRule[0]} (${allowRule[1]}x) — that rule only fires for a caller presenting our own secret header, so this is a first-party service`,
    );
  // A hard blocker, not merely a lever disqualifier: the agent could egress from the same
  // network too, so an ASN deny would catch it just as surely as a fingerprint deny.
  if (input.digestReach?.verifiedNames.length)
    out.push(
      `the fingerprint also carries verified ${input.digestReach.verifiedNames.join(', ')} — a SHARED identity, not one actor; no lever is safe`,
    );
  if (input.mix.beacon > 0)
    out.push(
      `${input.mix.beacon} analytics beacons — JavaScript executed, so a real rendering client`,
    );
  // Share-based, not absolute: one deliberate /favicon.svg per 10,000 page fetches would
  // otherwise immunise a scraper against the whole advisory forever.
  const assetShare = input.mix.asset / Math.max(1, input.total);
  if (assetsIndicateBrowser(input.mix.asset, input.total))
    out.push(
      `${input.mix.asset} sub-resource fetches (${(assetShare * 100).toFixed(1)}%) — browsers pull these, raw fetchers never do`,
    );
  // Tiles and RPCs are rendering proof too, and far harder to suppress than assets or beacons.
  if (input.mix.tile > 0 || input.mix.rpc > 0)
    out.push(
      `${input.mix.rpc} server-fn RPCs and ${input.mix.tile} map tiles — it is running the app, which is what a real session looks like here`,
    );
  if (input.mix.page === 0)
    out.push(
      `fetches no content pages (${input.mix.api} API, ${input.mix.rpc} RPC) — there is nothing here to enumerate`,
    );
  if (input.total < MIN_VOLUME)
    out.push(
      `only ${input.total} requests — below ${MIN_VOLUME}, not worth a rule evaluated on every request`,
    );
  if (!input.ja4.length)
    out.push('no TLS fingerprint recorded — nothing to identify it by');
  return out;
}

/** Whether an identity is safe to deny wholesale, and why not when it is not. */
export function qualifyLever(
  reach: Reach | undefined,
  kind: 'fingerprint' | 'network',
): { ok: boolean; note: string } {
  if (!reach)
    return {
      ok: false,
      note: `${kind} reach unknown — cannot clear it for a deny`,
    };
  if (reach.verifiedNames.length)
    return {
      ok: false,
      note: `${kind} ${reach.label} carries verified ${reach.verifiedNames.join(', ')} — shared, not one actor`,
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

  if (mix.asset === 0 && mix.beacon === 0 && mix.tile === 0 && mix.rpc === 0)
    tell(
      'rendering',
      `zero rendering requests across ${input.total} requests — a raw-HTML fetcher`,
    );
  if (mix.page > 0 && mix.rpc === 0)
    tell(
      'rendering',
      `${mix.page} page fetches and no RPCs — reading HTML directly, not running the app`,
    );
  if (input.ja4.some(([d]) => alpnOf(d) === '00'))
    tell('tls', 'offers no ALPN — no mainstream browser does that');
  if (mix.crawl > 0 && mix.page > mix.crawl * 10)
    tell(
      'crawl',
      `read the sitemap then fetched ${mix.page} pages — the enumeration pattern`,
    );
  // Active minutes, NOT first-to-last span. Span measures how long a client was AROUND, so any
  // repeat visitor with traffic in both halves of the window scored as automated — and the wider
  // the operator's chosen range, the more often that fired.
  const activeMinutes = shape.active * shape.bucketMinutes;
  const duty = activeMinutes / Math.max(1, input.windowMinutes);
  if (duty > 0.5 && shape.concentration < 0.5)
    tell(
      'pacing',
      `busy in ${(duty * 100).toFixed(0)}% of all ${shape.bucketMinutes}-minute buckets in the window — machines run flat, people burst and idle`,
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
  if (blockers.length)
    return {
      verdict: 'leave',
      reasons,
      blockers: [...blockers, ...denied],
      leverNotes,
    };
  if (input.stagedJa4)
    return {
      verdict: 'staged',
      digest,
      reasons,
      blockers: [],
      leverNotes,
    };
  if (input.alreadyDeniedJa4)
    return { verdict: 'already', digest, reasons, blockers: denied, leverNotes };
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
  const ja4Ok = qualifyLever(input.digestReach, 'fingerprint');
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
  const asnOk = qualifyLever(input.asnReach, 'network');
  leverNotes.push(
    input.alreadyDeniedAsn ? 'network is already in FW_BLOCKED_ASN' : asnOk.note,
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
