// Every test here guards a rule that must NOT be switchable to something worse. The TUI cycles
// actions on a single keypress and `seedItems` prefers the live action, so an accidental escalation
// survives every later apply — there is no drift back to the safe value.

import { describe, expect, test } from 'bun:test';

import {
  actionOptions,
  cycleAction,
  effectiveAction,
  isBypassOnly,
  isChallengeOnly,
  isLogOnly,
  withAction,
} from './actions';
import type { ActionChoice, Condition, Rule } from './rules';

function rule(
  action: Rule['action']['mitigate']['action'],
  conditions: Condition[],
  rateLimit?: Rule['action']['mitigate']['rateLimit'],
): Rule {
  return {
    name: 'r',
    description: 'd',
    active: true,
    conditionGroup: [{ conditions }],
    action: { mitigate: { action, ...(rateLimit ? { rateLimit } : {}) } },
  };
}

const JA4: Condition = { type: 'ja4_digest', op: 'eq', value: 'x' };
const PATH: Condition = { type: 'path', op: 'eq', value: '/robots.txt' };
const HEADER: Condition = { type: 'header', op: 'ex', key: 'x-secret' };

/** Every action the cycler can reach from any starting point, in both directions. */
function reachable(r: Rule): Set<ActionChoice> {
  const seen = new Set<ActionChoice>();
  for (const dir of [1, -1] as const)
    for (const start of ['log', 'challenge', 'deny', 'bypass'] as const) {
      let a: ActionChoice = start;
      for (let i = 0; i < 8; i++) {
        a = cycleAction(r, a, dir);
        seen.add(a);
      }
    }
  return seen;
}

describe('the challenge tier cannot be escalated to deny', () => {
  // The tier's whole justification is that being WRONG is survivable: a wrong deny takes a real
  // person offline silently, a wrong challenge costs them an interstitial their browser solves. An
  // unattended writer is only allowed to touch it BECAUSE of that, so if it can become a deny the
  // safety argument for automating writes disappears entirely.
  const challenge = rule('challenge', [JA4]);

  test('offers log and challenge only', () => {
    expect(isChallengeOnly(challenge)).toBe(true);
    expect(actionOptions(challenge)).toEqual(['log', 'challenge']);
  });

  test('no amount of cycling in either direction reaches deny', () => {
    expect([...reachable(challenge)].sort()).toEqual(['challenge', 'log']);
  });

  // `log` stays reachable on purpose: disabling the tier without an env edit is a real operational
  // need, and it errs toward serving traffic.
  test('can still be turned off', () => {
    expect(reachable(challenge).has('log')).toBe(true);
  });
});

describe('a path-only bypass cannot become a deny', () => {
  // allow-policy-docs matches nothing but /robots.txt and /llms.txt. Cycled to deny it would 403
  // those for the whole internet, and Google reads a 403 on robots.txt as disallow-all.
  const policyDocs = rule('bypass', [PATH]);

  test('offers bypass only', () => {
    expect(isBypassOnly(policyDocs)).toBe(true);
    expect(actionOptions(policyDocs)).toEqual(['bypass']);
    expect([...reachable(policyDocs)]).toEqual(['bypass']);
  });

  // A bypass gated on a bespoke secret header IS safe to cycle: turned into a deny it refuses only
  // callers holding our own credential, which is recoverable and visible.
  test('a header-gated bypass stays fully switchable', () => {
    const headerGated = rule('bypass', [PATH, HEADER]);
    expect(isBypassOnly(headerGated)).toBe(false);
    expect(actionOptions(headerGated)).toEqual([
      'log',
      'challenge',
      'deny',
      'bypass',
    ]);
  });
});

describe('JA4-keyed rate limits stay locked to log', () => {
  // A browser TLS fingerprint is shared by millions of real users, so rate-limiting keyed on one
  // and then enforcing is a self-inflicted outage.
  const observeJa4 = rule('rate_limit', [], {
    algo: 'fixed_window',
    window: 60,
    limit: 600,
    keys: ['ja4_digest'],
    action: 'log',
  });

  test('offers log only', () => {
    expect(isLogOnly(observeJa4)).toBe(true);
    expect(actionOptions(observeJa4)).toEqual(['log']);
    expect([...reachable(observeJa4)]).toEqual(['log']);
  });

  test('an IP-keyed rate limit is switchable, and writes through to rateLimit.action', () => {
    const ipKeyed = rule('rate_limit', [], {
      algo: 'fixed_window',
      window: 60,
      limit: 120,
      keys: ['ip'],
      action: 'log',
    });
    expect(actionOptions(ipKeyed)).toEqual(['log', 'challenge', 'deny']);
    const denied = withAction(ipKeyed, 'deny');
    // The governing action for a rate-limit rule is the exceeded-action, NOT mitigate.action —
    // writing the outer one would leave the ceiling logging while the UI claimed it denied.
    expect(denied.action.mitigate.rateLimit?.action).toBe('deny');
    expect(denied.action.mitigate.action).toBe('rate_limit');
    expect(effectiveAction(denied.action.mitigate)).toBe('deny');
  });
});

describe('ordinary deny rules are unaffected', () => {
  const deny = rule('deny', [JA4]);

  test('stay switchable across log, challenge and deny', () => {
    expect(isChallengeOnly(deny)).toBe(false);
    expect(isBypassOnly(deny)).toBe(false);
    expect(actionOptions(deny)).toEqual(['log', 'challenge', 'deny']);
  });

  // Cycling a deny must never reach `bypass`: that would invert the rule into an exemption for the
  // exact identity it was written to refuse.
  test('cycling never reaches bypass', () => {
    expect(reachable(deny).has('bypass')).toBe(false);
  });
});
