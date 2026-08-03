// Every fixture here is SYNTHETIC. Never paste a real FW_BLOCKED_JA4 / FW_BLOCKED_ASN value in.

import { afterEach, describe, expect, test } from 'bun:test';

import { ASN_DENY, denyListRule, envMatching, JA4_DENY } from './deny-list';

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
