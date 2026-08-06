// A hit on an allow rule is only evidence while the live rule still demands what the built rule
// demands. Nothing about the hit changes when a condition goes missing, so the difference has to
// be found here or not at all.

import { describe, expect, test } from 'bun:test';

import { headerKeysOf, trustedRules } from './rule-integrity';

const rule = (name: string, keys: string[]) => ({
  name,
  conditionGroup: [
    {
      conditions: [
        { type: 'path', op: 'eq', value: '/api/x' },
        ...keys.map((key) => ({ type: 'header', op: 'ex', key })),
      ],
    },
  ],
});

describe('headerKeysOf', () => {
  test('collects the header keys a rule requires', () => {
    expect([...headerKeysOf(rule('r', ['a-one', 'b-two']))]).toEqual([
      'a-one',
      'b-two',
    ]);
  });

  test('lower-cases them, since HTTP field names are case-insensitive', () => {
    // The live config echoes whatever casing was written; comparing raw would report a rule as
    // weakened purely because it was typed differently.
    expect([...headerKeysOf(rule('r', ['X-Foo']))]).toEqual(['x-foo']);
  });

  test('ignores conditions that are not header-existence', () => {
    const r = {
      conditionGroup: [
        {
          conditions: [
            { type: 'path', op: 'eq', value: '/api/x' },
            { type: 'header', op: 're', key: 'referer', value: '^x' },
            { type: 'query', op: 'ex', key: 'search' },
          ],
        },
      ],
    };
    expect([...headerKeysOf(r)]).toEqual([]);
  });

  test('an empty or missing condition group is no keys, not a crash', () => {
    expect([...headerKeysOf({ conditionGroup: [] })]).toEqual([]);
    expect([...headerKeysOf({ conditionGroup: [{ conditions: [] }] })]).toEqual(
      [],
    );
  });
});

describe('trustedRules', () => {
  const live = (m: Record<string, string[]>) =>
    new Map(Object.entries(m).map(([k, v]) => [k, new Set(v)]));

  test('a live rule requiring everything expected is trusted', () => {
    const expected = [rule('allow-x', ['pub', 'marker'])];
    expect(
      trustedRules(live({ 'allow-x': ['pub', 'marker'] }), expected),
    ).toEqual(['allow-x']);
  });

  test('a live rule missing a required header is NOT trusted', () => {
    // The case this exists for: applying from a checkout that predates the condition, or an edit
    // in the dashboard. The rule keeps matching and keeps looking fine.
    const expected = [rule('allow-x', ['pub', 'marker'])];
    expect(trustedRules(live({ 'allow-x': ['pub'] }), expected)).toEqual([]);
  });

  test('a live rule requiring MORE is still trusted', () => {
    // Stricter than we wrote is safe; only weaker is a problem.
    const expected = [rule('allow-x', ['pub'])];
    expect(
      trustedRules(live({ 'allow-x': ['pub', 'extra'] }), expected),
    ).toEqual(['allow-x']);
  });

  test('a rule absent from the live config is not trusted', () => {
    // Unknown does not pass. A rule that was never applied cannot be evidence of anything.
    expect(trustedRules(live({}), [rule('allow-x', ['pub'])])).toEqual([]);
  });

  test('casing differences between live and built do not break trust', () => {
    const expected = [rule('allow-x', ['X-Marker'])];
    expect(trustedRules(live({ 'allow-x': ['x-marker'] }), expected)).toEqual([
      'allow-x',
    ]);
  });

  test('each rule is judged on its own', () => {
    const expected = [rule('a', ['pub', 'marker']), rule('b', ['pub'])];
    expect(trustedRules(live({ a: ['pub'], b: ['pub'] }), expected)).toEqual([
      'b',
    ]);
  });

  test('a rule with no header requirements is trivially satisfied', () => {
    // Vacuous, and correct: there is nothing for the live rule to have lost. Whether such a rule
    // should certify anyone is HEADER_GATED_RULES' job, not this function's.
    expect(trustedRules(live({ a: [] }), [rule('a', [])])).toEqual(['a']);
  });
});
