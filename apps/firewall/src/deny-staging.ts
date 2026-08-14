// The local deny edit buffer: what this session staged or lifted, and what the panes read back.

import {
  ASN_DENY,
  type DenySpec,
  JA4_DENY,
  pendingEdits,
  valuesOf,
  withValue,
  withoutValue,
} from './deny-list';
import type { Activity } from './denylist-data';
import type { DenyEntry } from './denylist-view';
import { CHALLENGE_SCRAPER_JA4 } from './rule-names';
import type { Item } from './seed-items';

export const JA4_RULE = 'deny-scraper-ja4';
export const ASN_RULE = 'deny-scraper-asn';

export type DenyKind = 'ja4' | 'asn';

/** The rule a kind edits and the shape its values must take. */
export function targetOf(kind: DenyKind): { rule: string; spec: DenySpec } {
  return kind === 'ja4'
    ? { rule: JA4_RULE, spec: JA4_DENY }
    : { rule: ASN_RULE, spec: ASN_DENY };
}

// A rule can sit in the WAF with active:false, or cycled to log/challenge — both states leave the
// traffic served normally. Reporting ALREADY DENIED for either tells the operator a scraper is
// handled while it is not, which is the most costly kind of wrong.
/** Whether a deny rule is actually denying. */
export function enforcing(it: Item | undefined): boolean {
  return Boolean(it?.active && it.action === 'deny');
}

/** Whether a rule is doing the thing its identity says it does — deny for a deny rule, challenge for the recoverable tier. */
function isEnforcingAs(it: Item | undefined): boolean {
  if (!it) return false;
  return it.rule.name === CHALLENGE_SCRAPER_JA4
    ? Boolean(it.active && it.action === 'challenge')
    : enforcing(it);
}

export type LiveDenies = {
  ja4: string[];
  asn: string[];
  /** Digests the challenge tier is actually challenging. */
  challenged: string[];
  /** Everything on the challenge rule whatever its action — what a promotion is decided from. */
  challengeValues: string[];
  /** Deny rules holding values but not enforcing them, and why. */
  notEnforcing: { rule: string; why: string }[];
};

/** What the WAF is enforcing right now, per rule, from the local item list. */
export function liveDenies(items: Item[]): LiveDenies {
  const of = (name: string) => items.find((it) => it.rule.name === name);
  const ja4Item = of(JA4_RULE);
  const asnItem = of(ASN_RULE);
  const challengeItem = of(CHALLENGE_SCRAPER_JA4);
  // Only worth saying for a rule that actually carries denies — a revoked one denying nothing is
  // the intended resting state, not a fault.
  const notEnforcing = (
    [
      [ja4Item, JA4_DENY],
      [asnItem, ASN_DENY],
      // The challenge tier too: holding digests while deactivated or cycled off `challenge` is
      // protection that is not there, and it reads as protection that is.
      [challengeItem, JA4_DENY],
    ] as const
  )
    .filter(
      ([it, spec]) =>
        it && !isEnforcingAs(it) && valuesOf(it.rule, spec).length > 0,
    )
    .map(([it]) => ({
      rule: it!.rule.name,
      why: !it!.active
        ? 'the rule is DEACTIVATED'
        : `its action is ${it!.action}, not ${
            it!.rule.name === CHALLENGE_SCRAPER_JA4 ? 'challenge' : 'deny'
          } — matching traffic is still served`,
    }));
  return {
    ja4: ja4Item && enforcing(ja4Item) ? valuesOf(ja4Item.rule, JA4_DENY) : [],
    asn: asnItem && enforcing(asnItem) ? valuesOf(asnItem.rule, ASN_DENY) : [],
    // The recoverable tier needs its own liveness test: `enforcing` requires action `deny`, which
    // a challenge rule is never allowed to be, so reusing it would read every live challenge as
    // inert — and the advisory would then treat our own suppressed rendering as a measured zero.
    challenged:
      challengeItem && isEnforcingAs(challengeItem)
        ? valuesOf(challengeItem.rule, JA4_DENY)
        : [],
    challengeValues: challengeItem
      ? valuesOf(challengeItem.rule, JA4_DENY)
      : [],
    notEnforcing,
  };
}

// The rule's VALUES, not its liveness: `stage` removes the entry whatever the rule's action is,
// so reading liveness here would let the dialog say "Deny" while the edit also promotes.
/** Whether denying `target` also promotes it off the challenge tier. */
export function promotes(challengeValues: string[], target: string): boolean {
  const n = JA4_DENY.normalize(target.trim());
  return Boolean(n) && challengeValues.some((v) => JA4_DENY.normalize(v) === n);
}

/** The edited rule, with the apply state it invalidates cleared. */
function edited(it: Item, rule: Item['rule']): Item {
  return { ...it, rule, status: 'idle', detail: undefined };
}

/**
 * Stage a value into its deny rule. Nothing reaches the WAF until the apply.
 *
 * A JA4 deny also PROMOTES: the digest is dropped from the challenge tier in the same edit.
 * The two lists are alternatives, not layers — `rules.ts` gives the deny live priority, so a
 * digest on both is denied while `challenge-scraper-ja4` goes on advertising "1 challenged",
 * which is a rule describing something it is not doing. Doing it here rather than leaving it to
 * the operator is the point: promoting by hand is two files and an apply, and the half anyone
 * forgets is the removal, because nothing breaks when they do.
 *
 * Returns the error rather than throwing: a throw inside a setItems updater escapes the keypress
 * handler with no error boundary and every deny staged this session dies with the process.
 */
export function stage(
  items: Item[],
  kind: DenyKind,
  value: string,
): { items: Item[]; error?: string; promoted?: string } {
  const { rule: ruleName, spec } = targetOf(kind);
  if (!spec.valid(spec.normalize(value.trim())))
    return { items, error: `refused — not ${spec.example}` };
  // Reported, because it cannot be recovered afterwards: once the value is off the challenge
  // rule, nothing distinguishes "promoted off it" from "was never on it", and the rules list
  // then shows the challenge row as inert while it carries an unapplied removal.
  const challenge = items.find((it) => it.rule.name === CHALLENGE_SCRAPER_JA4);
  const promoted =
    kind === 'ja4' &&
    challenge &&
    promotes(valuesOf(challenge.rule, JA4_DENY), value)
      ? normalizeStaged(value)
      : undefined;
  return {
    promoted,
    items: items.map((it) =>
      // Unconditional, not gated on the digest being on the list: withoutValue on an absent
      // value is a no-op, and a gate here would need the LIVE list, which is exactly the state
      // a stale read gets wrong.
      kind === 'ja4' && it.rule.name === CHALLENGE_SCRAPER_JA4
        ? edited(it, withoutValue(it.rule, JA4_DENY, value).rule)
        : it.rule.name === ruleName
          ? edited(it, withValue(it.rule, spec, value).rule)
          : it,
    ),
  };
}

/**
 * Lift a deny. Same staging discipline: visible as pending until applied.
 *
 * `restore` puts the digest BACK on the challenge tier, and is what a lifted promotion needs.
 * Without it, promoting a challenged digest and then changing your mind left it on NEITHER list:
 * the deny went, and the challenge it was promoted off never came back. The operator ends up with
 * less protection than before they touched it, and nothing on screen says so.
 */
export function unstage(
  items: Item[],
  kind: DenyKind,
  value: string,
  restore = false,
): Item[] {
  const { rule: ruleName, spec } = targetOf(kind);
  return items.map((it) => {
    if (it.rule.name === ruleName)
      return edited(it, withoutValue(it.rule, spec, value).rule);
    if (restore && kind === 'ja4' && it.rule.name === CHALLENGE_SCRAPER_JA4)
      return edited(it, withValue(it.rule, JA4_DENY, value).rule);
    return it;
  });
}

// One form for both lists. They are flat and hold JA4 digests and AS numbers together, so the
// normalization has to be the one that is safe for either: lowercasing a digest is what its spec
// does, and an AS number is digits, which it cannot affect. Stored normalized rather than compared
// that way at each site, because the comparisons are spread across the pane, the advisory and the
// pending-edit count, and one of them was always going to be missed.
/** How a staged or lifted value is held, whatever case it was typed in. */
export function normalizeStaged(value: string): string {
  return value.trim().toLowerCase();
}

/** Whether `value` is staged this session. Normalizes the lookup, because the list is normalized. */
export function isStaged(staged: string[], value: string): boolean {
  return staged.includes(normalizeStaged(value));
}

/** The staged list after adding `value`, and the removed list it must leave. Each output depends only on the input list of the same name, so a caller may apply them as two independent state updates. */
export function afterStage(
  staged: string[],
  removed: string[],
  value: string,
): { staged: string[]; removed: string[] } {
  const v = normalizeStaged(value);
  return {
    staged: [...new Set([...staged.map(normalizeStaged), v])],
    removed: removed.filter((x) => normalizeStaged(x) !== v),
  };
}

// Only a value that actually reached the WAF can be unbanned. Undoing a staged addition is just
// dropping the stage; recording it as a removal invents an unban of something that was never
// denied, and pendingEdits then counts it against the rule.
/** The staged and removed lists after lifting `entry`. Each output depends only on the input list of the same name, so a caller may apply them as two independent state updates. */
export function afterUnstage(
  staged: string[],
  removed: string[],
  entry: { value: string; staged: boolean },
): { staged: string[]; removed: string[] } {
  const v = normalizeStaged(entry.value);
  return {
    staged: staged.filter((x) => normalizeStaged(x) !== v),
    removed: entry.staged
      ? removed
      : [...new Set([...removed.map(normalizeStaged), v])],
  };
}

/** Rows for the bans pane: what is live, what is staged, what is lifted, and what each has caught. */
export function denyEntries(opts: {
  liveJa4: string[];
  liveAsn: string[];
  staged: string[];
  removed: string[];
  activity: Map<string, Activity> | null;
}): DenyEntry[] {
  const { liveJa4, liveAsn, staged, removed, activity } = opts;
  // Staged values whose rule is not enforcing are absent from the live lists, so without this a
  // deny staged onto a deactivated rule showed NOTHING — the edit existed and the pane denied it.
  const live = new Set([...liveJa4, ...liveAsn].map((v) => normalizeStaged(v)));
  const orphanStaged = staged.filter((v) => !live.has(normalizeStaged(v)));
  // Normalized both sides: the rule stores the digest normalized while staging keeps what was
  // typed, so a raw `includes` rendered a staged deny as `live` and hid the "press a" banner.
  const stagedIn = (spec: DenySpec) =>
    new Set(staged.map((v) => spec.normalize(v.trim())));
  const stagedJa4 = stagedIn(JA4_DENY);
  const stagedAsn = stagedIn(ASN_DENY);
  // Normalized, because fetchDenyActivity stores its keys that way. A removal entry keeps the
  // value as it was typed, so a raw lookup missed it and reported a live ban as seeing nothing.
  const seen = (value: string) => {
    const hit = activity?.get(normalizeStaged(value));
    return { requests: hit?.requests, denied: hit?.denied };
  };
  return [
    ...liveJa4.map((value) => ({
      kind: 'ja4' as const,
      value,
      staged: stagedJa4.has(JA4_DENY.normalize(value)),
      removed: false,
      ...seen(value),
    })),
    ...liveAsn.map((value) => ({
      kind: 'asn' as const,
      value,
      staged: stagedAsn.has(ASN_DENY.normalize(value)),
      removed: false,
      ...seen(value),
    })),
    ...orphanStaged.map((value) => ({
      // Shape, not the rule it came from: the two lists share one flat staged list.
      kind: (JA4_DENY.valid(normalizeStaged(value))
        ? 'ja4'
        : 'asn') as DenyKind,
      value,
      staged: true,
      removed: false,
      ...seen(value),
    })),
    ...removed.map((value) => ({
      // By shape, not by a substring guess: the two denylists share one flat removal list.
      kind: (JA4_DENY.valid(value) ? 'ja4' : 'asn') as DenyKind,
      value,
      staged: false,
      removed: true,
      ...seen(value),
    })),
  ];
}

/** Per-rule marker for unapplied denylist edits, so the rules list says so rather than looking inert. */
export function pendingByRule(
  items: Item[],
  staged: string[],
  removed: string[],
  /** Digests taken off the challenge tier by a promotion this session. */
  promoted: string[] = [],
): Map<string, string> {
  const out = new Map<string, string>();
  // Not derivable from staged/removed: a promotion removes the digest from the challenge rule
  // without ever appearing in `removed`, so pendingEdits sees nothing on either side.
  if (promoted.length) out.set(CHALLENGE_SCRAPER_JA4, `−${promoted.length}`);
  for (const [ruleName, spec] of [
    [JA4_RULE, JA4_DENY],
    [ASN_RULE, ASN_DENY],
  ] as const) {
    const item = items.find((it) => it.rule.name === ruleName);
    if (!item) continue;
    const { added, dropped } = pendingEdits(
      valuesOf(item.rule, spec),
      staged,
      removed,
      spec,
    );
    // Kept terse so it survives a narrow rules column; the footer and denylist pane carry detail.
    const parts = [
      added ? `+${added}` : '',
      dropped ? `−${dropped}` : '',
    ].filter(Boolean);
    if (parts.length) out.set(ruleName, parts.join(' '));
  }
  return out;
}
