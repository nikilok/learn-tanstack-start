// Pure helpers for a rule's switchable action (log / challenge / deny / bypass). No Vercel/Ink deps.

import { retitledForAction } from './deny-list';
import { isRecoverableRule } from './rule-names';
import type { ActionChoice, RateLimitAction, Rule } from './rules';

const ACTIONS: ActionChoice[] = ['log', 'challenge', 'deny', 'bypass'];

/** Coerce an arbitrary action string to one of the four switchable choices, else undefined. */
export function asChoice(
  a: string | null | undefined,
): ActionChoice | undefined {
  return ACTIONS.includes(a as ActionChoice) ? (a as ActionChoice) : undefined;
}

/** The action that actually governs a rule: a rate-limit rule's exceeded-action, else the mitigate action. Works on both our rules and the SDK's live shape. */
export function effectiveAction(m: {
  action: string;
  rateLimit?: { action?: string | null } | null;
}): string | undefined {
  return m.action === 'rate_limit'
    ? (m.rateLimit?.action ?? undefined)
    : m.action;
}

/** JA4-keyed rules must never enforce — a browser TLS fingerprint is shared by millions of real users, so blocking on it is a self-inflicted outage. Locked to log in the UI and on apply. */
export function isLogOnly(rule: Rule): boolean {
  return rule.action.mitigate.rateLimit?.keys.includes('ja4_digest') ?? false;
}

/**
 * A bypass whose conditions name nothing but paths, so cycling it to `deny` would refuse those
 * paths for EVERYONE rather than for a caller who failed a credential check.
 *
 * The other bypasses are safe to cycle because they also require a bespoke secret header: turned
 * into a deny they refuse only callers holding our credential, which is recoverable and visible.
 * `allow-policy-docs` has no such condition — one LEFT press would 403 /robots.txt for the whole
 * internet, Google would read that as disallow-all, and `seedItems` prefers the live action so it
 * would survive every later apply. Nothing else in the tool inspects it: `enforcementIssues`
 * looks only at the deny rules.
 */
export function isBypassOnly(rule: Rule): boolean {
  if (rule.action.mitigate.action !== 'bypass') return false;
  return rule.conditionGroup.every((g) =>
    g.conditions.every((c) => c.type === 'path'),
  );
}

/**
 * A rule authored as `challenge` — the tier an automated writer is allowed to reach.
 *
 * Its whole purpose is that being wrong is survivable, so it must not be cyclable to `deny`: one
 * LEFT press would convert a machine-written list of unproven digests into silent outages for
 * everyone sharing those TLS stacks, and `seedItems` prefers the live action so it would survive
 * every later apply. `log` stays available — disabling the tier without an env edit is a real
 * operational need, and it errs toward serving traffic.
 *
 * Keyed on the rule's NAME, never on its current action. Deriving it from the action made the
 * guarantee self-defeating: switching the tier off removed the very thing marking it as needing
 * protection, so challenge -> log -> deny took two presses.
 */
export function isChallengeOnly(rule: Rule): boolean {
  return isRecoverableRule(rule.name);
}

/**
 * Switchable actions valid for a rule. JA4-keyed rate-limit rules are locked to log; `bypass` is
 * offered only to rules authored as one, since cycling a deny past `deny` would invert it into an
 * exemption — and seedItems prefers the live action, so that would survive every later apply.
 */
export function actionOptions(rule: Rule): ActionChoice[] {
  if (isLogOnly(rule)) return ['log'];
  if (isBypassOnly(rule)) return ['bypass'];
  if (isChallengeOnly(rule)) return ['log', 'challenge'];
  return rule.action.mitigate.action === 'bypass'
    ? ['log', 'challenge', 'deny', 'bypass']
    : ['log', 'challenge', 'deny'];
}

/** Copy of the rule with its governing action set: rate-limit rules update rateLimit.action, others mitigate.action. */
export function withAction(rule: Rule, action: ActionChoice): Rule {
  const m = rule.action.mitigate;
  if (m.action === 'rate_limit' && m.rateLimit) {
    // actionOptions() never offers bypass for rate-limit rules, so action is log/challenge/deny here.
    return {
      ...rule,
      action: {
        mitigate: {
          ...m,
          rateLimit: { ...m.rateLimit, action: action as RateLimitAction },
        },
      },
    };
  }
  // Enforced here, not just offered by actionOptions: seedItems reads the LIVE action and hands it
  // straight to this function, so a rule escalated in the dashboard would otherwise be re-applied
  // as a deny forever. Coercing back is the fail-safe direction and makes the escalation heal on
  // the next apply; notEnforcing still reports that it happened, so it is corrected, not hidden.
  const safe: ActionChoice =
    action === 'deny' && isRecoverableRule(rule.name) ? 'challenge' : action;
  return {
    ...rule,
    description: retitledForAction(rule.description, safe),
    action: { mitigate: { ...m, action: safe } },
  };
}

/** Next/previous valid action for a rule, wrapping around its option list. */
export function cycleAction(
  rule: Rule,
  current: ActionChoice,
  dir: 1 | -1,
): ActionChoice {
  const opts = actionOptions(rule);
  const i = opts.indexOf(current);
  const base = i < 0 ? 0 : i;
  return opts[(base + dir + opts.length) % opts.length];
}

/** Ink colour for an action tag — red deny, yellow challenge, cyan bypass, dim log. */
export function actionColor(a: ActionChoice): string {
  return a === 'deny'
    ? 'red'
    : a === 'challenge'
      ? 'yellow'
      : a === 'bypass'
        ? 'cyan'
        : 'gray';
}
