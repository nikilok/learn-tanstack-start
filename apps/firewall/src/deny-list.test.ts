// Every fixture here is SYNTHETIC. Never paste a real FW_BLOCKED_JA4 / FW_BLOCKED_ASN value in.

import { afterEach, describe, expect, test } from 'bun:test';

import {
  ASN_DENY,
  denyDescription,
  denyListRule,
  envMatching,
  JA4_DENY,
  enforcedNow,
  pendingEdits,
  valuesOf,
  withValue,
  withoutValue,
} from './deny-list';

const VAR = 'FW_TEST_DENYLIST';
afterEach(() => {
  delete process.env[VAR];
});

// Synthetic, shape-valid, and deliberately not equal to any placeholder.
const JA4_A = 't13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb';
const JA4_B = 't13d1517h2_cccccccccccc_dddddddddddd';

describe('envMatching — absent vs revoked vs malformed', () => {
  test('an ABSENT var throws when required', () => {
    delete process.env[VAR];
    expect(() => envMatching(VAR, JA4_DENY, true)).toThrow(VAR);
  });

  test('an ABSENT var is empty (not a throw) when not required, e.g. dry-run', () => {
    delete process.env[VAR];
    expect(envMatching(VAR, JA4_DENY, false)).toEqual([]);
  });

  test('a var set to EMPTY is a deliberate revocation', () => {
    process.env[VAR] = '';
    expect(envMatching(VAR, JA4_DENY, true)).toEqual([]);
    process.env[VAR] = '   ';
    expect(envMatching(VAR, JA4_DENY, true)).toEqual([]);
  });

  test('a separator-only var THROWS rather than reading as a revocation', () => {
    // A stray comma is a typo; reading it as a revocation is a silent un-ban.
    for (const raw of [',', ',,', ' , ']) {
      process.env[VAR] = raw;
      expect(() => envMatching(VAR, JA4_DENY, true)).toThrow('blank');
    }
  });

  test('parses and trims a comma-separated list', () => {
    process.env[VAR] = ` ${JA4_A} , ${JA4_B} `;
    expect(envMatching(VAR, JA4_DENY, true)).toEqual([JA4_A, JA4_B]);
  });

  test('a malformed entry throws', () => {
    process.env[VAR] = 'not-a-digest';
    expect(() => envMatching(VAR, JA4_DENY, true)).toThrow('malformed');
  });

  test('errors name the POSITION, never the value', () => {
    // This message reaches public CI logs on the --apply path.
    const secretish = 't13d311200_ffffffffffff_eeeeeeeeeeee'.slice(0, 30);
    process.env[VAR] = `${JA4_A},${secretish}`;
    expect(() => envMatching(VAR, JA4_DENY, true)).toThrow('entry #2');
    try {
      envMatching(VAR, JA4_DENY, true);
    } catch (e) {
      expect((e as Error).message).not.toContain(secretish);
    }
  });

  test('normalises JA4 case instead of throwing on upper-case hex', () => {
    // Throwing here would abort module init and take the whole TUI down.
    process.env[VAR] = JA4_A.toUpperCase();
    expect(envMatching(VAR, JA4_DENY, true)).toEqual([JA4_A]);
  });
});

describe('shapes reject the typos that would silently match nothing', () => {
  test('JA4 accepts a well-formed digest', () => {
    expect(JA4_DENY.valid(JA4_A)).toBe(true);
  });

  test('JA4 rejects truncated and extra-segment forms', () => {
    expect(JA4_DENY.valid('t13d1516h2_aaaaaaaaaaaa')).toBe(false);
    expect(JA4_DENY.valid(`${JA4_A}_x`)).toBe(false);
    expect(JA4_DENY.valid('')).toBe(false);
  });

  test('ASN accepts a plain number and rejects AS0 / leading zeros', () => {
    expect(ASN_DENY.valid('64512')).toBe(true);
    // AS0 is reserved (RFC 7607); a padded value is a different string to Vercel.
    expect(ASN_DENY.valid('0')).toBe(false);
    expect(ASN_DENY.valid('064512')).toBe(false);
    expect(ASN_DENY.valid('')).toBe(false);
    expect(ASN_DENY.valid('AS64512')).toBe(false);
  });

  test('ASN rejects values past the 32-bit maximum', () => {
    expect(ASN_DENY.valid('4294967295')).toBe(true);
    expect(ASN_DENY.valid('4294967296')).toBe(false);
    expect(ASN_DENY.valid('9999999999')).toBe(false);
  });

  test('each spec placeholder satisfies its own shape', () => {
    expect(JA4_DENY.valid(JA4_DENY.placeholder)).toBe(true);
    expect(ASN_DENY.valid(ASN_DENY.placeholder)).toBe(true);
  });

  test('the error example is NOT a paste-able value', () => {
    expect(JA4_DENY.valid(JA4_DENY.example)).toBe(false);
    expect(ASN_DENY.valid(ASN_DENY.example)).toBe(false);
  });
});

describe('denyListRule', () => {
  const build = (values: string[]) =>
    denyListRule({
      name: 'deny-test',
      description: 'd',
      spec: JA4_DENY,
      values,
    });

  test('every supplied value reaches its own condition group', () => {
    const r = build([JA4_A, JA4_B]);
    expect(r.conditionGroup).toHaveLength(2);
    expect(r.conditionGroup.map((g) => g.conditions[0]?.value)).toEqual([
      JA4_A,
      JA4_B,
    ]);
    expect(r.conditionGroup[0]?.conditions).toHaveLength(1);
    expect(r.conditionGroup[0]?.conditions[0]).toMatchObject({
      type: 'ja4_digest',
      op: 'eq',
      value: JA4_A,
    });
  });

  test('an empty list still yields an ACTIVE rule, carrying the placeholder', () => {
    const r = build([]);
    expect(r.active).toBe(true);
    expect(r.conditionGroup).toHaveLength(1);
    expect(r.conditionGroup[0]?.conditions[0]?.value).toBe(
      JA4_DENY.placeholder,
    );
  });

  test('revocation goes through the conditions, never active:false', () => {
    // seedItems prefers the LIVE flag, so active:false would be ignored.
    expect(build([]).active).toBe(true);
  });

  test('uses the spec type, so an ASN rule emits geo_as_number', () => {
    const r = denyListRule({
      name: 'deny-asn-test',
      description: 'd',
      spec: ASN_DENY,
      values: ['64512'],
    });
    expect(r.conditionGroup[0]?.conditions[0]).toMatchObject({
      type: 'geo_as_number',
      op: 'eq',
      value: '64512',
    });
  });

  test('throws if a placeholder ever drifts out of its own shape', () => {
    expect(() =>
      denyListRule({
        name: 'deny-broken',
        description: 'd',
        spec: { ...JA4_DENY, placeholder: 'nope' },
        values: [],
      }),
    ).toThrow('placeholder');
  });

  test('always denies', () => {
    expect(build([]).action.mitigate.action).toBe('deny');
    expect(build([JA4_A]).action.mitigate.action).toBe('deny');
  });
});

describe('valuesOf / withValue', () => {
  test('the revocation placeholder is not reported as a real entry', () => {
    const rule = denyListRule({
      name: 'r',
      description: 'd',
      spec: JA4_DENY,
      values: [],
    });
    expect(valuesOf(rule, JA4_DENY)).toEqual([]);
  });

  test('adding to an empty (revoked) rule replaces the placeholder', () => {
    const rule = denyListRule({
      name: 'r',
      description: 'd',
      spec: JA4_DENY,
      values: [],
    });
    const { values } = withValue(rule, JA4_DENY, JA4_A);
    expect(values).toEqual([JA4_A]);
  });

  test('adding keeps what was already there', () => {
    const rule = denyListRule({
      name: 'r',
      description: 'd',
      spec: JA4_DENY,
      values: [JA4_A],
    });
    expect(withValue(rule, JA4_DENY, JA4_B).values).toEqual([JA4_A, JA4_B]);
  });

  test('staging the same digest twice is a no-op', () => {
    const rule = denyListRule({
      name: 'r',
      description: 'd',
      spec: JA4_DENY,
      values: [JA4_A],
    });
    expect(withValue(rule, JA4_DENY, JA4_A).values).toEqual([JA4_A]);
  });

  test('case is normalised, so a dashboard-cased digest cannot double up', () => {
    const rule = denyListRule({
      name: 'r',
      description: 'd',
      spec: JA4_DENY,
      values: [JA4_A],
    });
    expect(withValue(rule, JA4_DENY, JA4_A.toUpperCase()).values).toEqual([
      JA4_A,
    ]);
  });

  test('a malformed digest is refused rather than added as a match-nothing condition', () => {
    const rule = denyListRule({
      name: 'r',
      description: 'd',
      spec: JA4_DENY,
      values: [JA4_A],
    });
    expect(() => withValue(rule, JA4_DENY, 'nonsense')).toThrow(
      /refusing to add/,
    );
  });

  test('every staged value reaches the rebuilt conditions', () => {
    const rule = denyListRule({
      name: 'r',
      description: 'd',
      spec: JA4_DENY,
      values: [JA4_A],
    });
    const out = withValue(rule, JA4_DENY, JA4_B).rule;
    const vals = out.conditionGroup.flatMap((g) =>
      g.conditions.map((c) => c.value),
    );
    expect(vals).toEqual([JA4_A, JA4_B]);
  });
});

describe('denyDescription', () => {
  test('states the count, so the dashboard list is readable without opening the rule', () => {
    expect(denyDescription('Deny X.', 2)).toBe('Deny X. 2 denied.');
    expect(denyDescription('Deny X.', 1)).toBe('Deny X. 1 denied.');
  });

  test('a revoked rule says so — it stays active and matches a placeholder', () => {
    // Without this the dashboard shows an active DENY rule that denies nothing.
    expect(denyDescription('Deny X.', 0)).toContain('REVOKED');
    expect(denyDescription('Deny X.', 0)).not.toContain('1 denied');
  });

  test('the built rule carries the count, not the bare base text', () => {
    const r = denyListRule({
      name: 'r',
      description: 'Deny X.',
      spec: JA4_DENY,
      values: [JA4_A, JA4_B],
    });
    expect(r.description).toBe('Deny X. 2 denied.');
  });

  test('the placeholder is never counted as a denied entry', () => {
    const r = denyListRule({
      name: 'r',
      description: 'Deny X.',
      spec: JA4_DENY,
      values: [],
    });
    expect(r.description).toContain('REVOKED');
    expect(r.conditionGroup).toHaveLength(1); // the placeholder is still there
  });

  test('staging a value updates the count in the description', () => {
    const base = denyListRule({
      name: 'r',
      description: 'Deny X.',
      spec: JA4_DENY,
      values: [JA4_A],
    });
    expect(withValue(base, JA4_DENY, JA4_B).rule.description).toBe(
      'Deny X. 2 denied.',
    );
  });

  test('descriptions stay inside the 256-char cap Vercel enforces', () => {
    expect(denyDescription('x'.repeat(200), 99).length).toBeLessThanOrEqual(
      256,
    );
  });
});

describe('denyDescription — idempotence', () => {
  test('re-decorating a decorated description replaces the count, never appends', () => {
    expect(denyDescription('Deny X. 1 denied.', 2)).toBe('Deny X. 2 denied.');
    expect(denyDescription('Deny X. REVOKED — nothing is denied.', 3)).toBe(
      'Deny X. 3 denied.',
    );
    expect(denyDescription('Deny X. 5 denied.', 0)).toBe(
      'Deny X. REVOKED — nothing is denied.',
    );
  });

  test('repeated staging never compounds the suffix', () => {
    let r = denyListRule({
      name: 'r',
      description: 'Deny X.',
      spec: JA4_DENY,
      values: [JA4_A],
    });
    r = withValue(r, JA4_DENY, JA4_B).rule;
    r = withoutValue(r, JA4_DENY, JA4_A).rule;
    expect(r.description).toBe('Deny X. 1 denied.');
    expect(r.description.match(/denied/g)).toHaveLength(1);
  });
});

// Regression: `dropped` counted every removedDenies entry absent from the rule under examination.
// removedDenies is ONE flat list across both denylists, so lifting an ASN ban rendered a yellow
// "−1" on deny-scraper-ja4 — a rule nothing had been removed from — and the footer claimed two
// rules were unapplied.
describe('pendingEdits', () => {
  const DIGEST = 't13d311200_1d947a95fc68_7e1102d2036b';
  const OTHER = 't13d1516h2_aaaaaaaaaaaa_bbbbbbbbbbbb';

  test('a removed ASN does not mark the JA4 rule', () => {
    const e = pendingEdits([DIGEST], [], ['29066'], JA4_DENY);
    expect(e.dropped).toBe(0);
    expect(e.added).toBe(0);
  });

  test('a removed digest does not mark the ASN rule', () => {
    expect(pendingEdits(['29066'], [], [DIGEST], ASN_DENY).dropped).toBe(0);
  });

  test('each rule still counts its own removal', () => {
    expect(pendingEdits([], [], ['29066'], ASN_DENY).dropped).toBe(1);
    expect(pendingEdits([], [], [DIGEST], JA4_DENY).dropped).toBe(1);
  });

  test('a staged addition counts only once it is in the rule', () => {
    expect(pendingEdits([DIGEST], [DIGEST], [], JA4_DENY).added).toBe(1);
    expect(pendingEdits([], [DIGEST], [], JA4_DENY).added).toBe(0);
  });

  test('a digest pasted upper-case from the dashboard still counts', () => {
    // The TUI stages the value as typed; the rule stores it normalized. Comparing raw made an
    // upper-case entry count as neither added nor dropped, so the rule showed no pending change.
    expect(
      pendingEdits([DIGEST], [DIGEST.toUpperCase()], [], JA4_DENY).added,
    ).toBe(1);
    expect(pendingEdits([], [], [DIGEST.toUpperCase()], JA4_DENY).dropped).toBe(
      1,
    );
  });

  test('a value still live is not counted as dropped', () => {
    expect(pendingEdits([DIGEST], [], [DIGEST], JA4_DENY).dropped).toBe(0);
  });

  test('both kinds staged and removed at once stay on their own rules', () => {
    const staged = [DIGEST, '29066'];
    const removed = [OTHER, '64500'];
    expect(pendingEdits([DIGEST], staged, removed, JA4_DENY)).toEqual({
      added: 1,
      dropped: 1,
    });
    expect(pendingEdits(['29066'], staged, removed, ASN_DENY)).toEqual({
      added: 1,
      dropped: 1,
    });
  });
});

// The two staging directions pull opposite ways, and both were reported backwards at some point.
describe('enforcedNow', () => {
  const DIGEST = 't13d311200_1d947a95fc68_7e1102d2036b';

  test('a live digest with no pending edit is denied', () => {
    expect(enforcedNow([DIGEST], [], [], DIGEST, JA4_DENY)).toBe(true);
  });

  test('a STAGED addition is not denied yet — it has not been written', () => {
    expect(enforcedNow([DIGEST], [DIGEST], [], DIGEST, JA4_DENY)).toBe(false);
  });

  test('a STAGED removal is still denied — the WAF keeps denying until the apply lands', () => {
    // unstageDeny edits the local rule immediately, so `live` no longer carries it.
    expect(enforcedNow([], [], [DIGEST], DIGEST, JA4_DENY)).toBe(true);
  });

  test('an unknown digest is not denied', () => {
    expect(enforcedNow([DIGEST], [], [], 'tttttttttt_a_b', JA4_DENY)).toBe(
      false,
    );
  });

  test('an empty subject never reads as denied', () => {
    expect(enforcedNow([DIGEST], [], [], '', JA4_DENY)).toBe(false);
  });

  test('case does not change the answer', () => {
    expect(enforcedNow([DIGEST], [], [], DIGEST.toUpperCase(), JA4_DENY)).toBe(
      true,
    );
  });
});
