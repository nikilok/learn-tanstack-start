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

import { alpnOf } from './ip-signals';
import type { Mix, Shape } from './ip-signals';

// Below this an IP is not worth a rule — rules are evaluated on every request forever.
const MIN_VOLUME = 200;
// A fingerprint spread wider than this is a proxy pool or a shared client library, not one host.
const WIDE_SPREAD = 8;

/** What an identity does across ALL of its traffic, not just the IP being profiled. */
export type Reach = {
  label: string;
  ips: number;
  countries: number;
  total: number;
  /** The safety test. Non-zero means a real browser has rendered from this identity. */
  subResources: number;
  beacons: number;
  verifiedNames: string[];
};

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
  const allowRule = input.wafRules.find(([name]) => name.startsWith('allow-'));
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
  if (input.mix.asset > 0)
    out.push(
      `${input.mix.asset} sub-resource fetches — browsers pull these, raw fetchers never do`,
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
  const browsery = reach.subResources + reach.beacons;
  if (browsery > 0)
    return {
      ok: false,
      note: `${kind} ${reach.label} shows ${browsery} sub-resource/beacon fetches — real browsers render from it, so a blanket deny would hit users`,
    };
  return {
    ok: true,
    note: `${kind} ${reach.label} has ZERO sub-resources across ${reach.total} requests from ${reach.ips} IPs — no browser has ever rendered from it`,
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
  const reasons: string[] = [];
  const { mix, shape } = input;

  if (mix.asset === 0 && mix.beacon === 0)
    reasons.push(
      `zero sub-resources across ${input.total} requests — a raw-HTML fetcher`,
    );
  if (input.ja4.some(([d]) => alpnOf(d) === '00'))
    reasons.push('offers no ALPN — no mainstream browser does that');
  if (mix.page > 0 && mix.rpc === 0)
    reasons.push(
      `${mix.page} page fetches and no RPCs — reading HTML directly, not running the app`,
    );
  if (mix.crawl > 0 && mix.page > mix.crawl * 10)
    reasons.push(
      `read the sitemap then fetched ${mix.page} pages — the enumeration pattern`,
    );
  const duty = shape.spanMinutes / Math.max(1, input.windowMinutes);
  if (duty > 0.5 && shape.concentration < 0.5)
    reasons.push(
      `level across ${(duty * 100).toFixed(0)}% of the window — machines run flat, people burst and idle`,
    );
  if (input.digestReach && input.digestReach.ips > WIDE_SPREAD)
    reasons.push(
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
  if (reasons.length < 2)
    return { verdict: 'watch', digest, reasons, blockers, leverNotes };

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
