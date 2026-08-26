// The only path in this tool that can deny live traffic with nobody watching, so these are mostly
// about what must NOT happen. Calibration figures are in the ops-repo runbook.

import { describe, expect, test } from 'bun:test';

import { AUTO_BAN_MAX_MS, AUTO_BAN_TTL_MS, type Strike } from './auto-ban';
import { autoBanDecision, revocationPlan, ttlLabel } from './auto-ban-apply';

const D = 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb';
const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const ON = { FW_AUTO_BAN: '1' };

const decide = (over: Partial<Parameters<typeof autoBanDecision>[0]> = {}) =>
  autoBanDecision({
    digest: D,
    agentVerdict: 'ban',
    refusal: null,
    env: ON,
    strikes: [],
    now: NOW,
    ...over,
  });

describe('autoBanDecision', () => {
  test('applies only when BOTH gates agree', () => {
    const d = decide();
    expect(d.apply).toBe(true);
    expect(d.apply === true && d.ttlMs).toBe(AUTO_BAN_TTL_MS);
  });

  test('off unless the operator explicitly opted in', () => {
    // Anything but exactly "1". A flag that is truthy-ish arms the one thing that must not be
    // armed by accident.
    for (const env of [
      {},
      { FW_AUTO_BAN: '0' },
      { FW_AUTO_BAN: 'true' },
      { FW_AUTO_BAN: 'yes' },
    ])
      expect(decide({ env }).apply).toBe(false);
  });

  test('the ADVISORY alone is not enough', () => {
    // The agent re-queries live and sees evidence the advisory cannot. Requiring both means one
    // wrong answer denies nothing.
    for (const v of ['challenge', 'leave', 'unclear', ''])
      expect(decide({ agentVerdict: v }).apply).toBe(false);
  });

  test('the AGENT alone is not enough', () => {
    // A confident agent must not be able to talk past the advisory's ceilings.
    const d = decide({
      refusal: 'spans 224 IPs — too broad to deny unattended',
    });
    expect(d.apply).toBe(false);
    expect(d.apply === false && d.reason).toContain('224 IPs');
  });

  test('every refusal says WHY, so a decline can be audited', () => {
    // A gate that declines silently is indistinguishable from one that never ran.
    for (const d of [
      decide({ env: {} }),
      decide({ agentVerdict: 'unclear' }),
      decide({ refusal: 'advisory blocked it: verified bot' }),
    ])
      expect(d.apply === false && d.reason.length).toBeGreaterThan(0);
  });

  test('a repeat offender is banned for longer, and it is capped', () => {
    // Coming back is itself evidence, and the escalation is capped.
    const strikes = (n: number): Strike[] => [{ digest: D, count: n, at: NOW }];
    expect(decide({ strikes: strikes(1) }).apply === true).toBe(true);
    const second = decide({ strikes: strikes(1) });
    const tenth = decide({ strikes: strikes(10) });
    expect(second.apply === true && second.ttlMs).toBe(AUTO_BAN_TTL_MS * 2);
    expect(tenth.apply === true && tenth.ttlMs).toBe(AUTO_BAN_MAX_MS);
  });

  test('it always sets an expiry — an auto-ban is never permanent', () => {
    // The property the whole mechanism rests on.
    const d = decide({ strikes: [{ digest: D, count: 40, at: NOW }] });
    expect(d.apply === true && d.until).toBeGreaterThan(NOW);
    expect(d.apply === true && d.until - NOW).toBeLessThanOrEqual(
      AUTO_BAN_MAX_MS,
    );
  });
});

describe('revocationPlan', () => {
  test('lifts what is due and keeps what is running', () => {
    const plan = revocationPlan(
      [
        { digest: 'a', until: NOW - 1 },
        { digest: 'b', until: NOW + 60_000 },
      ],
      NOW,
    );
    expect(plan.lift).toEqual(['a']);
    expect(plan.keep.map((k) => k.digest)).toEqual(['b']);
  });

  test('a ban expiring exactly now is lifted, not held another tick', () => {
    expect(revocationPlan([{ digest: 'a', until: NOW }], NOW).lift).toEqual([
      'a',
    ]);
  });

  test('nothing recorded lifts nothing', () => {
    expect(revocationPlan([], NOW).lift).toEqual([]);
  });
});

describe('ttlLabel', () => {
  test('reads correctly to someone half awake', () => {
    // Against the constants, not their values — the durations live in the runbook.
    expect(ttlLabel(AUTO_BAN_TTL_MS)).toMatch(/^\d+[hd]$/);
    expect(ttlLabel(AUTO_BAN_MAX_MS)).toMatch(/^\d+[hd]$/);
  });
});
