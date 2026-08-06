// Whether a live rule still demands everything the rule we wrote demands.
//
// The advisory treats a hit on a header-gated allow rule as proof of a first-party caller. That
// only holds while the live rule still requires every header the built rule does — a rule edited
// in the dashboard, or applied from a checkout that predates a condition, becomes satisfiable by
// anyone and the proof quietly stops being one. Nothing about the hit itself changes, which is
// why this has to be checked rather than assumed.

/** Header keys a rule requires, lower-cased since HTTP field names are case-insensitive. */
export function headerKeysOf(rule: {
  conditionGroup: {
    conditions: { type: string; op: string; key?: string; neg?: boolean }[];
  }[];
}): Set<string> {
  const keys = new Set<string>();
  for (const g of rule.conditionGroup ?? [])
    for (const c of g.conditions ?? [])
      // `neg` inverts the condition, so a negated `ex` means the header must be ABSENT — satisfied
      // by every caller that does not send it. Read as a requirement it certifies a rule that
      // means the opposite of how it reads, which is the one failure this module exists to catch.
      if (c.type === 'header' && c.op === 'ex' && !c.neg && c.key)
        keys.add(c.key.toLowerCase());
  return keys;
}

/**
 * Names whose LIVE definition still requires every header key the built rule does.
 *
 * Superset, not equality: a live rule demanding more than we wrote is stricter, and stricter is
 * safe. A rule absent from the live config is absent from the result — unknown does not pass.
 */
export function trustedRules(
  live: ReadonlyMap<string, ReadonlySet<string>>,
  expected: {
    name: string;
    conditionGroup: {
      conditions: { type: string; op: string; key?: string }[];
    }[];
  }[],
): string[] {
  return expected
    .filter(({ name, conditionGroup }) => {
      const liveKeys = live.get(name);
      if (!liveKeys) return false;
      const want = headerKeysOf({ conditionGroup });
      return [...want].every((k) => liveKeys.has(k));
    })
    .map((r) => r.name);
}
