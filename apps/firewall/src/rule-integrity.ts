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
