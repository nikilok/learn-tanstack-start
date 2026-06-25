// Pure helpers for a rule's switchable action (log / challenge / deny / bypass). No Vercel/Ink deps.

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

/** Switchable actions valid for a rule: JA4 rules are locked to log; other rate-limit rules can't bypass (the exceeded-action enum excludes it); plain rules get all four. */
export function actionOptions(rule: Rule): ActionChoice[] {
  if (isLogOnly(rule)) return ['log'];
  return rule.action.mitigate.action === 'rate_limit'
    ? ['log', 'challenge', 'deny']
    : ['log', 'challenge', 'deny', 'bypass'];
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
  return { ...rule, action: { mitigate: { ...m, action } } };
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
