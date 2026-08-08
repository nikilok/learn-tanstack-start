// Whether a live rule still demands everything the rule we wrote demands.
//
// The advisory treats a hit on a header-gated allow rule as proof of a first-party caller. That
// only holds while the live rule still requires every header the built rule does — a rule edited
// in the dashboard, or applied from a checkout that predates a condition, becomes satisfiable by
// anyone and the proof quietly stops being one. Nothing about the hit itself changes, which is
// why this has to be checked rather than assumed.

type Cond = { type: string; op: string; key?: string; neg?: boolean };
type Grouped = { conditionGroup: { conditions: Cond[] }[] };

/**
 * Header keys each condition group requires, one set per group, lower-cased since HTTP field
 * names are case-insensitive.
 *
 * Per group rather than pooled: groups are OR'd, so a caller satisfies the rule by matching any
 * ONE of them. Pooled, a group demanding nothing hides behind a sibling demanding everything,
 * and the rule reads as strict while the weakest group is the one that governs.
 */
export function headerKeysByGroup(rule: Grouped): Set<string>[] {
  return (rule.conditionGroup ?? []).map((g) => {
    const keys = new Set<string>();
    for (const c of g.conditions ?? [])
      // `neg` inverts the condition, so a negated `ex` means the header must be ABSENT — satisfied
      // by every caller that does not send it. Read as a requirement it certifies a rule that
      // means the opposite of how it reads, which is the one failure this module exists to catch.
      if (c.type === 'header' && c.op === 'ex' && !c.neg && c.key)
        keys.add(c.key.toLowerCase());
    return keys;
  });
}

/** Every header key a rule requires anywhere. The built rules have one group, so that is it. */
export function headerKeysOf(rule: Grouped): Set<string> {
  return new Set(headerKeysByGroup(rule).flatMap((g) => [...g]));
}

/**
 * Names whose LIVE definition still requires every header key the built rule does.
 *
 * Superset, not equality: a live rule demanding more than we wrote is stricter, and stricter is
 * safe. A rule absent from the live config is absent from the result — unknown does not pass.
 */
export function trustedRules(
  live: ReadonlyMap<string, readonly ReadonlySet<string>[]>,
  expected: (Grouped & { name: string })[],
): string[] {
  return expected
    .filter(({ name, conditionGroup }) => {
      const liveGroups = live.get(name);
      // Absent is not trusted, and neither is a rule carrying no groups at all: `[].every` is
      // true, so an empty list would certify a rule that demands nothing of anyone.
      if (!liveGroups?.length) return false;
      const want = [...headerKeysOf({ conditionGroup })];
      // EVERY live group must carry the requirement. One is enough for a caller to match, so a
      // single group that omits a header is the rule that actually governs.
      return liveGroups.every((g) => want.every((k) => g.has(k)));
    })
    .map((r) => r.name);
}

/**
 * Denied user-agent tokens that robots.txt does NOT also disallow.
 *
 * Two statements of one policy: the firewall enforces it, robots.txt requests it. They live in
 * different files, one secret and one public, so nothing stops them drifting — and a crawler
 * denied at the edge but permitted in robots.txt was never asked to stop, which is the version
 * that reads badly if anyone ever asks why they were blocked.
 *
 * Token-based rather than exact: robots.txt names a product token (`ShapBot`), the WAF matches a
 * substring of the full user agent, and they are the same string by construction here.
 * Case-insensitive because robots.txt user-agent matching is.
 */
export function unstatedInRobots(
  deniedUa: readonly string[],
  robotsTxt: string,
): string[] {
  const disallowed = new Set<string>();
  // Consecutive User-agent lines are ONE group and share the directives beneath them. Tracking a
  // single agent kept only the last, so every earlier name in a group read as unstated.
  let pending: string[] = [];
  let sawDirective = false;
  // Every line ending, not just LF. A CR-only file collapses to one line, and the parser then
  // reports every crawler as unstated — safe direction, but wrong.
  for (const raw of robotsTxt.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    // RFC 9309 allows whitespace before the colon.
    const ua = /^user-agent\s*:\s*(.+)$/i.exec(line);
    if (ua?.[1]) {
      // A User-agent AFTER a directive opens a new group rather than joining the last one.
      if (sawDirective) {
        pending = [];
        sawDirective = false;
      }
      pending.push(ua[1].trim().toLowerCase());
      continue;
    }
    // Only GROUP-member records close a group. `Sitemap` and unknown fields are non-group
    // records (RFC 9309): treating one as a directive split a group in two and orphaned every
    // agent named above it.
    if (/^(allow|disallow|crawl-delay)\s*:/i.test(line)) sawDirective = true;
    // Only a bare `Disallow: /` counts. A narrower path is not a refusal of the whole site, and
    // treating it as one would report agreement this function exists to disprove.
    if (/^disallow\s*:\s*\/\s*$/i.test(line))
      for (const a of pending) disallowed.add(a);
  }
  return deniedUa.filter((t) => t && !disallowed.has(t.trim().toLowerCase()));
}
