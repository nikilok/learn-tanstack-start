// A family is a client build line, not an actor. The popular ones carry real users permanently,
// so the relation is only usable where nothing on the line renders — and these tests exist mainly
// to pin the cases where it must stay silent.

import { describe, expect, test } from 'bun:test';

import { familyOf, kinOfListed, renderingFamilies } from './ja4-family';

// Same family, different extensions hash — what a client rebuild produces.
const LISTED = 't13dscrp00_aaaaaaaaaaaa_111111111111';
const SIBLING = 't13dscrp00_aaaaaaaaaaaa_222222222222';
// Same cipher hash, different profile: NOT the same family.
const COUSIN = 't13dothrh2_aaaaaaaaaaaa_333333333333';
const UNRELATED = 't13dbingh2_444444444444_555555555555';

const MAX_SHARE = 0.05;
const PAGE = '/company/[slug]';
const RPC = '/_serverFn/abc';

const row = (digest: string, route: string, count_sum: number) => ({
  clientJa4Digest: digest,
  route,
  count_sum,
});

describe('familyOf', () => {
  test('keeps the profile and cipher halves, drops the extensions hash', () => {
    expect(familyOf(LISTED)).toBe('t13dscrp00_aaaaaaaaaaaa');
    expect(familyOf(SIBLING)).toBe(familyOf(LISTED));
  });

  test('a different profile is a different family on the same cipher hash', () => {
    // The cipher hash alone is "a modern TLS stack" — shared by our own services, third-party
    // crawlers and real browsers at once. Grouping on it is the one aggregation never to make.
    expect(familyOf(COUSIN)).not.toBe(familyOf(LISTED));
  });

  test('malformed input gets an empty family, so it never groups with a real one', () => {
    for (const bad of [
      '',
      'nonsense',
      't13dscrp00_aaaaaaaaaaaa',
      '__',
      // Three non-empty parts is NOT the test. Counting parts accepts these, and then anything
      // else shaped like them joins a real build line.
      'a_b_c',
      `${LISTED}_extra`,
      't13dscrp00_aaaaaaaaaaaa_zzzzzzzzzzzz',
      't13dscrp00_aaaaaaaaaaaa_11111111111',
    ])
      expect(familyOf(bad)).toBe('');
  });

  test('surrounding whitespace is stripped — the list files do not trim their fields', () => {
    expect(familyOf(` ${LISTED} `)).toBe(familyOf(LISTED));
  });

  test('case is normalised — dashboards render hashes upper-case', () => {
    expect(familyOf(LISTED.toUpperCase())).toBe(familyOf(LISTED));
  });
});

describe('renderingFamilies', () => {
  test('a family whose member renders is named', () => {
    const out = renderingFamilies(
      [row(SIBLING, PAGE, 100), row(SIBLING, RPC, 900)],
      MAX_SHARE,
    );
    expect([...(out ?? [])]).toEqual([familyOf(SIBLING)]);
  });

  test('a response of ONLY malformed digests establishes nothing', () => {
    // Not the '(none)'/'?' placeholders — anything that is not a real digest. Counting them left
    // a defined-but-empty Set, which reads as the affirmative claim that nothing renders anywhere.
    const out = renderingFamilies(
      [row('nonsense', RPC, 900), row('a_b_c', RPC, 900)],
      MAX_SHARE,
    );
    expect(out).toBeUndefined();
    expect(kinOfListed([SIBLING], [LISTED], out).size).toBe(0);
  });

  test('a family that only fetches pages is not', () => {
    expect(renderingFamilies([row(SIBLING, PAGE, 900)], MAX_SHARE)?.size).toBe(
      0,
    );
  });

  test('ONE rendering member taints the whole family', () => {
    // The point of the exclusion: a build line with any browser on it cannot be treated as an
    // actor, however much non-rendering traffic sits beside it.
    const out = renderingFamilies(
      [row(LISTED, PAGE, 5000), row(SIBLING, PAGE, 10), row(SIBLING, RPC, 90)],
      MAX_SHARE,
    );
    expect(out?.has(familyOf(LISTED))).toBe(true);
  });

  test('a placeholder digest beside a real one is skipped, not grouped', () => {
    const out = renderingFamilies(
      [row('(none)', RPC, 900), row('?', RPC, 900), row(SIBLING, PAGE, 900)],
      MAX_SHARE,
    );
    expect([...(out ?? [])]).toEqual([]);
  });

  test('UNDEFINED when no row carries a measurable digest', () => {
    // Not an empty Set. Empty is the affirmative claim "nothing renders anywhere", which is the
    // widest answer available, and a response that measured nothing cannot support it.
    for (const rows of [
      [],
      [row('(none)', RPC, 900), row('?', RPC, 900), row('', RPC, 900)],
    ])
      expect(renderingFamilies(rows, MAX_SHARE)).toBeUndefined();
  });
});

describe('kinOfListed', () => {
  const quiet = new Set<string>();

  test('a sibling of a listed digest is kin', () => {
    const out = kinOfListed([SIBLING], [LISTED], quiet);
    expect([...out]).toEqual([SIBLING]);
  });

  test('the listed digest is not its own kin', () => {
    expect(kinOfListed([LISTED, SIBLING], [LISTED], quiet).has(LISTED)).toBe(
      false,
    );
  });

  test('an unrelated digest is not kin', () => {
    expect(kinOfListed([UNRELATED], [LISTED], quiet).size).toBe(0);
  });

  test('sharing only the cipher hash is not kin', () => {
    expect(kinOfListed([COUSIN], [LISTED], quiet).size).toBe(0);
  });

  test('NO KIN on a family that carries a renderer', () => {
    // The case that killed the naive version: two of this site's largest real populations share
    // a family with a listed digest, one of them a verified crawler.
    const rendering = new Set([familyOf(LISTED)]);
    expect(kinOfListed([SIBLING], [LISTED], rendering).size).toBe(0);
  });

  test('NO KIN when the family evidence is undefined', () => {
    // Undefined is "could not look". Treating it as "nothing renders" would widen the screen on
    // the strength of a query that failed.
    expect(kinOfListed([SIBLING], [LISTED], undefined).size).toBe(0);
  });

  test('a malformed listed entry does not make every malformed digest kin', () => {
    expect(kinOfListed(['nonsense'], ['also-nonsense'], quiet).size).toBe(0);
  });

  test('case differences still match', () => {
    const out = kinOfListed([SIBLING.toUpperCase()], [LISTED], quiet);
    expect([...out]).toEqual([SIBLING]);
  });

  test('nothing listed means nothing is kin', () => {
    expect(kinOfListed([SIBLING, UNRELATED], [], quiet).size).toBe(0);
  });

  test('an already-known digest is omitted without its family counting as listed', () => {
    // `known` is the watch list — entries already surfaced once. Folding it into `listed` would
    // let a merely-seen digest recruit its whole build line into the notice.
    const other = 't13dknwn00_bbbbbbbbbbbb_999999999999';
    const sameLineAsKnown = 't13dknwn00_bbbbbbbbbbbb_888888888888';
    const out = kinOfListed([SIBLING, sameLineAsKnown], [LISTED], quiet, [
      other,
    ]);
    expect([...out]).toEqual([SIBLING]);
  });

  test('a known digest stops repeating', () => {
    expect(kinOfListed([SIBLING], [LISTED], quiet, [SIBLING]).size).toBe(0);
  });

  test('a hand-padded known entry still suppresses', () => {
    // `parseWatchlist` trims the line, and the entry an operator adds to silence this is the one
    // most likely to carry a stray space. Matching on the padded string silently does nothing.
    expect(kinOfListed([SIBLING], [LISTED], quiet, [` ${SIBLING}`]).size).toBe(
      0,
    );
  });
});
