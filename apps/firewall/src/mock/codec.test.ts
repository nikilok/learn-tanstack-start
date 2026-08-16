import { describe, expect, test } from 'bun:test';

import type { LiveConfig } from '../seed-items';
import {
  decodeLiveConfig,
  decodeRuleNames,
  encodeLiveConfig,
  encodeRuleNames,
} from './codec';

const CONFIG: LiveConfig = {
  idByName: new Map([['ja4-denylist', 'rule_1']]),
  activeByName: new Map([['ja4-denylist', true]]),
  actionByName: new Map([['ja4-denylist', 'deny']]),
  headerKeysByName: new Map([
    ['allow-ch-stream-revalidate', [new Set(['x-revalidate-token'])]],
  ]),
};

describe('the live config codec', () => {
  test('round-trips the Maps and Sets JSON cannot hold', () => {
    expect(decodeLiveConfig(encodeLiveConfig(CONFIG))).toEqual(CONFIG);
  });

  test('keeps each condition group separate, since the weakest one governs', () => {
    const twoGroups: LiveConfig = {
      ...CONFIG,
      headerKeysByName: new Map([
        ['allow', [new Set(['a']), new Set(['b', 'c'])]],
      ]),
    };
    const back = decodeLiveConfig(encodeLiveConfig(twoGroups));
    expect(back.headerKeysByName.get('allow')).toEqual([
      new Set(['a']),
      new Set(['b', 'c']),
    ]);
  });

  // A cassette is a file a crash can truncate and a human can edit. Refusing to boot over one bad
  // entry is worth less than booting with that entry missing.
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nonsense'],
    ['an array', [1, 2, 3]],
    ['an object of the wrong shape', { idByName: 'not-pairs' }],
  ])('decodes %s to an empty config rather than throwing', (_label, raw) => {
    const back = decodeLiveConfig(raw);
    expect(back.idByName.size).toBe(0);
    expect(back.activeByName.size).toBe(0);
    expect(back.actionByName.size).toBe(0);
    expect(back.headerKeysByName.size).toBe(0);
  });

  // An unrecognised action would otherwise reach the pane as a live action nothing can render.
  test('drops a rule whose recorded action is not one of the four choices', () => {
    const back = decodeLiveConfig({
      ...encodeLiveConfig(CONFIG),
      actionByName: [
        ['ja4-denylist', 'deny'],
        ['other', 'rate_limit'],
      ],
    });
    expect(back.actionByName.get('ja4-denylist')).toBe('deny');
    expect(back.actionByName.has('other')).toBe(false);
  });

  // Filtering the bad member out invented a group that was never recorded — and groups are OR'd
  // with the weakest governing, so a fabricated group is a claim about what the live rule requires.
  test('drops the whole rule when a header group holds a non-string', () => {
    const back = decodeLiveConfig({
      ...encodeLiveConfig(CONFIG),
      headerKeysByName: [['allow-x', [['x-token', 42]]]],
    });
    expect(back.headerKeysByName.has('allow-x')).toBe(false);
  });

  test('drops a pair whose value is the wrong type rather than storing it', () => {
    const back = decodeLiveConfig({
      ...encodeLiveConfig(CONFIG),
      activeByName: [
        ['ja4-denylist', true],
        ['other', 'yes'],
      ],
    });
    expect(back.activeByName.get('ja4-denylist')).toBe(true);
    expect(back.activeByName.has('other')).toBe(false);
  });
});

describe('the rule-name codec', () => {
  test('round-trips the lookup', () => {
    const names = new Map([
      ['rule_1', 'ja4-denylist'],
      ['rule_2', 'asn-denylist'],
    ]);
    expect(decodeRuleNames(encodeRuleNames(names))).toEqual(names);
  });

  // The same thing the live lookup returns when it fails, so the caller's existing handling covers it.
  test('decodes an unrecognised value to an empty map', () => {
    expect(decodeRuleNames({ not: 'pairs' }).size).toBe(0);
  });
});
