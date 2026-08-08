// A hit on an allow rule is only evidence while the live rule still demands what the built rule
// demands. Nothing about the hit changes when a condition goes missing, so the difference has to
// be found here or not at all.

import { describe, expect, test } from 'bun:test';

import {
  headerKeysByGroup,
  headerKeysOf,
  trustedRules,
  unstatedInRobots,
} from './rule-integrity';

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
  // One condition group per rule — what the built rules have.
  const live = (m: Record<string, string[]>) =>
    new Map(Object.entries(m).map(([k, v]) => [k, [new Set(v)]]));

  // Several OR'd groups — what a dashboard edit can produce, and what a pooled key set hides.
  const liveGroups = (m: Record<string, string[][]>) =>
    new Map(Object.entries(m).map(([k, gs]) => [k, gs.map((g) => new Set(g))]));

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

  test('an alternative group that drops a header is not trusted', () => {
    // Groups are OR'd — the live denylist rule is built that way, one digest per group — so a
    // caller satisfies the rule by matching any ONE. Pooling every group's keys into one set
    // made the weak group invisible behind the strict one, and certified the rule as proof of a
    // first-party caller that anyone sending only `pub` could impersonate.
    const expected = [rule('allow-x', ['pub', 'marker'])];
    const twoGroups = liveGroups({ 'allow-x': [['pub', 'marker'], ['pub']] });
    expect(trustedRules(twoGroups, expected)).toEqual([]);
  });

  test('every group carrying the requirement is still trusted', () => {
    const expected = [rule('allow-x', ['pub', 'marker'])];
    const twoGroups = liveGroups({
      'allow-x': [
        ['pub', 'marker'],
        ['pub', 'marker', 'extra'],
      ],
    });
    expect(trustedRules(twoGroups, expected)).toEqual(['allow-x']);
  });

  test('a live rule carrying no groups at all is not trusted', () => {
    // `[].every` is true, so an empty group list would certify a rule demanding nothing — the
    // vacuous pass this module exists to catch, reintroduced by the fix for the one above.
    const expected = [rule('allow-x', ['pub'])];
    expect(trustedRules(liveGroups({ 'allow-x': [] }), expected)).toEqual([]);
  });
});

describe('negated conditions', () => {
  const negated = {
    conditionGroup: [
      {
        conditions: [
          { type: 'path', op: 'eq', value: '/api/x' },
          { type: 'header', op: 'ex', key: 'marker', neg: true },
        ],
      },
    ],
  };

  test('a negated header-existence condition is not a requirement', () => {
    // `neg` inverts it: the header must be ABSENT, which every caller that omits it satisfies.
    // Read as a requirement it means the exact opposite of how it looks.
    expect([...headerKeysOf(negated)]).toEqual([]);
  });

  test('a live rule that negated a required header is NOT trusted', () => {
    // The failure this guards: a dashboard edit flips the condition, the rule keeps matching, and
    // the certification it backs keeps reading as proof.
    const expected = [
      {
        name: 'allow-x',
        conditionGroup: [
          {
            conditions: [{ type: 'header', op: 'ex', key: 'marker' }],
          },
        ],
      },
    ];
    const live = new Map([['allow-x', headerKeysByGroup(negated)]]);
    expect(trustedRules(live, expected)).toEqual([]);
  });

  test('an explicitly non-negated condition still counts', () => {
    const r = {
      conditionGroup: [
        {
          conditions: [{ type: 'header', op: 'ex', key: 'marker', neg: false }],
        },
      ],
    };
    expect([...headerKeysOf(r)]).toEqual(['marker']);
  });
});

// The firewall enforces the policy and robots.txt requests it. They are two statements of one
// thing in two files, one secret and one public, with nothing holding them together.
describe('unstatedInRobots', () => {
  const robots = [
    'User-agent: *',
    'Allow: /',
    '',
    'User-agent: ShapBot',
    'Disallow: /',
    '',
    '# a comment',
    'User-agent: AhrefsBot',
    'Disallow: /',
  ].join('\n');

  test('a denied crawler that robots.txt also refuses is fine', () => {
    expect(unstatedInRobots(['ShapBot', 'AhrefsBot'], robots)).toEqual([]);
  });

  test('a denied crawler robots.txt never mentions is reported', () => {
    expect(unstatedInRobots(['ShapBot', 'Bytespider'], robots)).toEqual([
      'Bytespider',
    ]);
  });

  test('matching is case-insensitive, as robots.txt is', () => {
    expect(unstatedInRobots(['shapbot'], robots)).toEqual([]);
  });

  test('a narrower Disallow is not a refusal of the site', () => {
    // `Disallow: /admin` would otherwise read as "we asked them to stop", which is the exact
    // false agreement this is meant to catch.
    const partial = 'User-agent: Bytespider\nDisallow: /admin';
    expect(unstatedInRobots(['Bytespider'], partial)).toEqual(['Bytespider']);
  });

  test('an empty robots.txt reports everything, never nothing', () => {
    expect(unstatedInRobots(['ShapBot'], '')).toEqual(['ShapBot']);
  });
  test('consecutive User-agent lines share the directives beneath them', () => {
    // robots.txt groups several agents under one Disallow. Tracking a single agent kept only the
    // last, so every earlier name in a group read as unstated.
    const grouped = [
      'User-agent: ShapBot',
      'User-agent: AhrefsBot',
      'User-agent: Bytespider',
      'Disallow: /',
    ].join('\n');
    expect(
      unstatedInRobots(['ShapBot', 'AhrefsBot', 'Bytespider'], grouped),
    ).toEqual([]);
  });

  test('a User-agent after a directive opens a NEW group', () => {
    // Otherwise the second agent inherits the first group's Disallow and reads as refused when
    // robots.txt says the opposite.
    const two = [
      'User-agent: ShapBot',
      'Disallow: /',
      '',
      'User-agent: Googlebot',
      'Allow: /',
    ].join('\n');
    expect(unstatedInRobots(['ShapBot'], two)).toEqual([]);
    expect(unstatedInRobots(['Googlebot'], two)).toEqual(['Googlebot']);
  });
});

describe('unstatedInRobots — RFC 9309 shapes', () => {
  test('CR-only line endings still parse', () => {
    // Splitting on \n alone collapses such a file to one line, and every crawler then reads as
    // unstated: safe direction, but wrong.
    const cr = 'User-agent: ShapBot\rDisallow: /\r';
    expect(unstatedInRobots(['ShapBot'], cr)).toEqual([]);
  });

  test('CRLF still parses', () => {
    expect(
      unstatedInRobots(['ShapBot'], 'User-agent: ShapBot\r\nDisallow: /\r\n'),
    ).toEqual([]);
  });

  test('whitespace before the colon is allowed', () => {
    // RFC 9309 permits it, and a robots.txt written that way is not a gap.
    expect(
      unstatedInRobots(['ShapBot'], 'User-agent : ShapBot\nDisallow : /'),
    ).toEqual([]);
  });

  test('a Sitemap line does not split a group', () => {
    // Sitemap is a NON-GROUP record. Treating it as a directive started a new group and
    // orphaned every agent named above it.
    const withSitemap = [
      'User-agent: ShapBot',
      'Sitemap: https://example.com/sitemap.xml',
      'User-agent: AhrefsBot',
      'Disallow: /',
    ].join('\n');
    expect(unstatedInRobots(['ShapBot', 'AhrefsBot'], withSitemap)).toEqual([]);
  });

  test('an Allow directive still closes the group', () => {
    const two = 'User-agent: A\nAllow: /\nUser-agent: B\nDisallow: /';
    expect(unstatedInRobots(['A'], two)).toEqual(['A']);
    expect(unstatedInRobots(['B'], two)).toEqual([]);
  });
});
