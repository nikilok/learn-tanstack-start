/**
 * Whether our own exempted paths are still answering.
 *
 * The mirror of the enforcement check: that one catches a deny rule that stopped denying,
 * this catches an allow rule that stopped allowing. The failure is silent by construction —
 * a path carries a bypass precisely because its caller cannot answer a challenge, so when one
 * arrives there is no browser to solve it and no human to see it. The traffic just stops.
 *
 * Measured: the desktop updater feed sat at 57 checks, 57 challenged, 0 served for seven days
 * with nothing reporting it, and surfaced only because a release happened to be cut.
 */
import type { Rule } from './rules';

/** Requests below this on a prefix are too few to call an outage. */
export const MIN_REQUESTS = 5;

/** WAF actions that let the request through to the app. */
const SERVED = new Set(['allow', 'bypass', 'log']);

export type PathRow = { path: string; action: string; count: number };
export type Reach = { prefix: string; served: number; mitigated: number };
export type ClientRow = PathRow & { agent: string };

/**
 * User-agent tokens belonging to clients we ship.
 *
 * `electron-builder` is electron-updater's own, and `SponsorSearchDesktop` is appended by the
 * app (see apps/desktop/src/main/site.ts). Substring, because the app's carries a version.
 *
 * A user-agent is a string the caller picks, which is why nothing is AUTHORISED on this list.
 * It is only read to decide whether to raise an alarm, so the worst a spoofer achieves is a
 * false one — the reverse trade to using it as a bypass condition, where they would gain entry.
 */
export const FIRST_PARTY_AGENTS = ['electron-builder', 'SponsorSearchDesktop'];

/**
 * The paths our own bypass rules exempt.
 *
 * Read from the rules rather than listed again here: a second list would agree on the day it
 * was written and silently stop agreeing the first time a rule moved.
 */
export function bypassPaths(rules: readonly Rule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    if (r.action.mitigate?.action !== 'bypass') continue;
    for (const g of r.conditionGroup)
      for (const c of g.conditions)
        if (c.type === 'path' && typeof c.value === 'string') out.add(c.value);
  }
  return [...out];
}

/** Roll per-path traffic up to the prefixes we exempt, ignoring everything else. */
export function rollUp(
  rows: readonly PathRow[],
  prefixes: readonly string[],
): Reach[] {
  return prefixes.map((prefix) => {
    let served = 0;
    let mitigated = 0;
    for (const r of rows) {
      if (!r.path.startsWith(prefix)) continue;
      if (SERVED.has(r.action)) served += r.count;
      else mitigated += r.count;
    }
    return { prefix, served, mitigated };
  });
}

/**
 * Exempted paths where real traffic arrived and none of it got through.
 *
 * Quiet is not evidence: a prefix nobody asked for is skipped rather than reported, which is
 * why this returns the decided cases only and never a bare boolean.
 */
export function unreachable(
  reach: readonly Reach[],
  minRequests: number = MIN_REQUESTS,
): string[] {
  return reach
    .filter((r) => r.served === 0 && r.mitigated >= Math.max(1, minRequests))
    .map(
      (r) =>
        `${r.prefix} — ${r.mitigated} requests, none served. A bypassed path answering only mitigations means its caller cannot get through, and it cannot tell you so.`,
    );
}

/**
 * Requests from a client we ship that were mitigated on a path we exempt.
 *
 * The gap this closes: `unreachable` above is binary, and any traffic getting through silences
 * it. That is right for a public path — a refused scraper on /robots.txt is the system working
 * — and wrong here, where a rule denying one fingerprint, network or country stops those users
 * updating while everyone else keeps the served count above zero.
 *
 * No path can distinguish the two, so this asks about the CLIENT instead: our own updater
 * cannot answer a challenge, so any mitigation of it is a user who silently stopped receiving
 * releases, whatever else on that path succeeded.
 */
export function blockedFirstParty(
  rows: readonly ClientRow[],
  prefixes: readonly string[],
  opts: { agents?: readonly string[]; min?: number } = {},
): string[] {
  const agents = opts.agents ?? FIRST_PARTY_AGENTS;
  const min = Math.max(1, opts.min ?? 1);
  const hit = new Map<string, number>();
  for (const r of rows) {
    if (SERVED.has(r.action)) continue;
    const prefix = prefixes.find((p) => r.path.startsWith(p));
    if (!prefix) continue;
    const agent = agents.find((a) => r.agent.includes(a));
    if (!agent) continue;
    const key = `${prefix}\u0000${agent}\u0000${r.action}`;
    hit.set(key, (hit.get(key) ?? 0) + r.count);
  }
  return [...hit]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const [prefix, agent, action] = key.split('\u0000');
      return `${prefix} — ${n} request(s) from ${agent} were ${action}d. A client we ship cannot answer one, so those users stop updating and nothing tells them.`;
    });
}
