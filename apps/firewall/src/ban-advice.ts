// Whether a client is worth denying, and on what.
//
// The lever is the JA4 digest, not the IP: a residential-proxy scraper spends one IP per request,
// so an IP deny is a no-op against it, while its TLS fingerprint is stable. That cuts the other
// way too — a digest can be SHARED by verified AI agents, so denying one on shape alone takes
// them out with it. Blockers are checked before any signal and are absolute. This recommends; the
// operator stages, reviews, and applies.

import { alpnOf } from './ip-signals';
import type { Mix, Shape } from './ip-signals';

// Below this an IP is not worth a rule — rules are evaluated on every request forever.
const MIN_VOLUME = 200;

/** What a digest does across ALL of its traffic, not just the IP being profiled. */
export type DigestReach = {
  ja4: string;
  ips: number; // distinct IPs carrying it
  countries: number;
  verifiedNames: string[]; // verified bots riding it — the reason not to deny
  total: number;
};

export type Advice = {
  verdict: 'ban' | 'watch' | 'leave';
  digest?: string; // what would join FW_BLOCKED_JA4
  reasons: string[];
  blockers: string[];
};

export type AdviceInput = {
  total: number;
  mix: Mix;
  shape: Shape;
  ja4: [string, number][];
  asns: [string, number][];
  botVerified: [string, number][];
  wafActions: [string, number][];
  wafRules: [string, number][]; // custom rules that acted, by name
  reach?: DigestReach;
  alreadyDenied: boolean; // digest is already in FW_BLOCKED_JA4
  windowMinutes: number;
};

/** Reasons this digest must not be denied, whatever the shape looks like. */
function blockersFor(input: AdviceInput): string[] {
  const out: string[] = [];
  const verified = input.botVerified.filter(([v]) => v === 'pass');
  if (verified.length)
    out.push(
      `verified bot (${verified.map(([v, c]) => `${v}:${c}`).join(', ')}) — denying it is a self-inflicted outage`,
    );
  // The trap this whole tool exists to avoid: scraper-shaped, but other traffic on the same
  // fingerprint is a verified agent. Checked across the digest, not just the profiled IP.
  if (input.reach?.verifiedNames.length)
    out.push(
      `the digest also carries verified ${input.reach.verifiedNames.join(', ')} — a SHARED client fingerprint, not one actor`,
    );
  if (input.mix.beacon > 0)
    out.push(
      `${input.mix.beacon} analytics beacons — JavaScript executed, so a real rendering client`,
    );
  if (input.mix.asset > 0)
    out.push(
      `${input.mix.asset} sub-resource fetches — browsers pull these, raw fetchers never do`,
    );
  if (input.total < MIN_VOLUME)
    out.push(
      `only ${input.total} requests — below ${MIN_VOLUME}, not worth a rule evaluated on every request`,
    );
  // Conclusive, and it is an authentication fact rather than a heuristic: our allow rules match
  // on PRESENCE of a bespoke secret header, so a bypass means the caller held our credential.
  const allowRule = input.wafRules.find(([name]) => name.startsWith('allow-'));
  if (allowRule)
    out.push(
      `matched ${allowRule[0]} (${allowRule[1]}x) — that rule only fires for a caller presenting our own secret header, so this is a first-party service`,
    );
  const bypassed = input.wafActions.find(([a]) => a === 'bypass');
  if (!allowRule && bypassed && bypassed[1] > 0)
    out.push(
      `${bypassed[1]} requests bypassed by one of our own allow rules — a first-party caller, not a scraper`,
    );
  // Nothing to scrape. A client that never fetches content cannot be enumerating it, whatever
  // its TLS or session shape looks like.
  if (input.mix.page === 0)
    out.push(
      `fetches no content pages (${input.mix.api} API, ${input.mix.rpc} RPC) — there is nothing here to enumerate`,
    );
  if (input.alreadyDenied) out.push('already in FW_BLOCKED_JA4 — nothing to add');
  if (!input.ja4.length) out.push('no TLS fingerprint recorded — nothing to deny on');
  return out;
}

/**
 * Recommend a denial for the client's dominant digest. `ban` needs zero blockers AND a scraper
 * shape on at least two axes — one tell is coincidence, since every one of them has a legitimate
 * client somewhere on the wrong side of it.
 */
export function adviseBan(input: AdviceInput): Advice {
  const blockers = blockersFor(input);
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
  if (input.reach && input.reach.ips > 8)
    reasons.push(
      `the digest spans ${input.reach.ips} IPs across ${input.reach.countries} countries — per-IP limits cannot see it, which is exactly what the digest deny is for`,
    );

  const digest = input.ja4[0]?.[0];
  if (blockers.length) return { verdict: 'leave', reasons, blockers };
  if (reasons.length < 2) return { verdict: 'watch', digest, reasons, blockers };
  return { verdict: 'ban', digest, reasons, blockers };
}
