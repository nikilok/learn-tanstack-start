// The screen is cheap and the profile is not (~21 queries each), so what survives the screen is
// the whole cost model. And `notEnforcing` names the state the tool calls the most costly kind
// of wrong: a rule that looks handled while the traffic it lists is served normally.

import { describe, expect, test } from 'bun:test';

import { type Advice } from './ban-advice';
import { lineText } from './line-model';
import { rollingWindow } from './time-window';
import {
  type WatchReport,
  impersonators,
  isActionable,
  notEnforcing,
  watchLines,
  worthProfiling,
} from './watch';

const A = 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb';
const B = 't13dbingh2_333333333333_444444444444';

describe('worthProfiling', () => {
  test('keeps a busy fingerprint that is not already denied', () => {
    expect(worthProfiling([[A, 500]], [])).toEqual([
      { digest: A, allowed: 500 },
    ]);
  });

  test('drops anything already in the denylist — its traffic is deny-actioned, not allowed', () => {
    expect(worthProfiling([[A, 500]], [A])).toEqual([]);
  });

  test('matches the denylist case-insensitively', () => {
    // Dashboards render digests upper-case; a raw compare would re-profile a banned identity
    // every single run.
    expect(worthProfiling([[A.toUpperCase(), 500]], [A])).toEqual([]);
  });

  test('drops anything under the floor — it cannot clear the advisory anyway', () => {
    expect(worthProfiling([[A, 20]], [], 100)).toEqual([]);
  });

  test('drops the empty grouping key', () => {
    expect(
      worthProfiling(
        [
          ['(none)', 900],
          ['', 900],
        ],
        [],
      ),
    ).toEqual([]);
  });

  test('caps the number profiled, so a classification change cannot cause a query storm', () => {
    // Synthetic, like every other digest in this file. The index varies inside the JA4a segment
    // so the ALPN slot stays a fixed `h2` and none of these read as a tell.
    const many: [string, number][] = Array.from({ length: 40 }, (_, i) => [
      `t13dq${String(i).padStart(3, '0')}h2_cccccccccccc_dddddddddddd`,
      500,
    ]);
    expect(worthProfiling(many, [], 100, 6)).toHaveLength(6);
  });

  test('preserves the screen order — the API returns it ranked by volume', () => {
    const out = worthProfiling(
      [
        [A, 900],
        [B, 500],
      ],
      [],
    );
    expect(out.map((c) => c.digest)).toEqual([A, B]);
  });
});

// The screen returned nothing from the day it shipped, because `botCategory eq '…'` is accepted
// by the API and matches zero rows. It never errored, so every "nothing wants a human" it printed
// was this. The category is now selected here instead, where it can be tested.
describe('impersonators', () => {
  const row = (digest: string, botCategory: string, count_sum: number) => ({
    clientJa4Digest: digest,
    botCategory,
    count_sum,
  });

  test('keeps only the impersonation rows', () => {
    expect(
      impersonators(
        [
          row(A, 'search_engine_crawler', 9000),
          row(B, 'browser_impersonation', 30),
        ],
        10,
      ),
    ).toEqual([[B, 30]]);
  });

  test('busiest first, whatever order the API returned', () => {
    expect(
      impersonators(
        [
          row(A, 'browser_impersonation', 30),
          row(B, 'browser_impersonation', 900),
        ],
        10,
      ),
    ).toEqual([
      [B, 900],
      [A, 30],
    ]);
  });

  test('an empty category is not impersonation', () => {
    // Most rows carry no category at all; treating blank as a match would flag the whole site.
    expect(impersonators([row(A, '', 9000)], 10)).toEqual([]);
  });

  test('a missing category field is not impersonation either', () => {
    expect(
      impersonators([{ clientJa4Digest: A, count_sum: 9000 }], 10),
    ).toEqual([]);
  });

  test('caps what it returns', () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      row(
        `t13dq${String(i).padStart(3, '0')}h2_cccccccccccc_dddddddddddd`,
        'browser_impersonation',
        500,
      ),
    );
    expect(impersonators(many, 50)).toHaveLength(50);
  });

  test('an empty summary yields nothing, not a crash', () => {
    expect(impersonators([], 10)).toEqual([]);
  });
});

describe('notEnforcing', () => {
  const rule = (over = {}) => ({
    name: 'deny-scraper-ja4',
    active: true,
    action: 'deny',
    values: 1,
    ...over,
  });

  test('an active deny rule with entries is fine', () => {
    expect(notEnforcing([rule()])).toEqual([]);
  });

  test('flags a rule cycled to log — it lists digests and blocks nothing', () => {
    expect(notEnforcing([rule({ action: 'log' })])[0]).toContain('set to log');
  });

  test('flags a deactivated rule', () => {
    expect(notEnforcing([rule({ active: false })])[0]).toContain('DEACTIVATED');
  });

  test('an EMPTY rule is silent whatever its action — revoked is the resting state', () => {
    expect(notEnforcing([rule({ values: 0, action: 'log' })])).toEqual([]);
    expect(notEnforcing([rule({ values: 0, active: false })])).toEqual([]);
  });

  test('reports each broken rule separately', () => {
    expect(
      notEnforcing([
        rule({ action: 'log' }),
        rule({ name: 'deny-scraper-asn', active: false, values: 3 }),
      ]),
    ).toHaveLength(2);
  });
});

// The fires-case had no way to be exercised while it depended on a live scraper, so the tool
// could only ever be observed NOT finding something. That is the same trap that hid a dead ban
// axis for a day: a branch reads perfectly and never runs.
describe('watchLines', () => {
  const DIG = 't13dnewx00_abcabcabcabc_defdefdefdef';
  const advice = (over: Partial<Advice> = {}): Advice => ({
    verdict: 'ban',
    digest: DIG,
    lever: {
      kind: 'ja4',
      value: DIG,
      why: 'no browser has ever rendered from it',
    },
    reasons: [
      'zero rendering requests across 9060 requests — a raw-HTML fetcher',
    ],
    blockers: [],
    leverNotes: ['fingerprint has ZERO rendering requests'],
    ...over,
  });
  const report = (over: Partial<WatchReport> = {}): WatchReport => ({
    window: rollingWindow(24, new Date('2026-08-05T12:00:00.000Z')),
    screened: 9060,
    fingerprints: 3,
    candidates: 1,
    truncated: false,
    findings: [{ digest: DIG, allowed: 9060, total: 9060, advice: advice() }],
    enforcement: [],
    errors: [],
    ...over,
  });
  const text = (r: WatchReport) => watchLines(r).map(lineText).join('\n');

  test('a detection names the verdict, the lever, and how to act on it', () => {
    const t = text(report());
    expect(t).toContain('BAN');
    expect(t).toContain(`ja4 ${DIG}`);
    expect(t).toContain('stage with b in firewall:setup');
    expect(t).toContain('raw-HTML fetcher');
  });

  test('it reports how much of the traffic was ALLOWED, which is the whole point', () => {
    // Vercel classified it and let it through; that gap is what the screen exists to find.
    expect(text(report())).toContain('9060 allowed of 9060 total');
  });

  test('an ASN lever says the AS number must be supplied', () => {
    const t = text(
      report({
        findings: [
          {
            digest: DIG,
            allowed: 900,
            total: 900,
            advice: advice({
              lever: {
                kind: 'asn',
                value: 'Some Network',
                why: 'x',
                needsAsNumber: true,
              },
            }),
          },
        ],
      }),
    );
    expect(t).toContain('needs the AS number');
  });

  test('a non-ban finding is reported without being dressed as one', () => {
    const t = text(
      report({
        findings: [
          {
            digest: DIG,
            allowed: 900,
            total: 900,
            advice: advice({ verdict: 'watch', lever: undefined }),
          },
        ],
      }),
    );
    expect(t).toContain('WATCH');
    expect(t).not.toContain('stage with b'); // no lever, so nothing to act on
    // Shown for context, but still not actionable — the report says so rather than implying a
    // decision is waiting. Waking someone for `watch` is how a watch gets muted.
    expect(t).toContain('nothing wants a human');
  });

  test('quiet when there is nothing — the expected outcome', () => {
    const t = text(
      report({ screened: 0, fingerprints: 0, candidates: 0, findings: [] }),
    );
    expect(t).toContain('nothing wants a human');
    expect(t).not.toContain('BAN');
  });

  test('a broken deny rule is actionable on its own, with no candidates at all', () => {
    const r = report({
      screened: 0,
      fingerprints: 0,
      candidates: 0,
      truncated: false,
      findings: [],
      enforcement: ['deny-scraper-ja4 carries 1 entry but is set to log'],
    });
    expect(text(r)).toContain('ENFORCEMENT');
    expect(text(r)).not.toContain('nothing wants a human');
    expect(isActionable(r)).toBe(true);
  });

  test('errors are surfaced AND make the run actionable', () => {
    // Rendering the error was never enough: exit 0 tells a loop to go back to sleep, so a watch
    // that could not read its own inputs would have gone quiet about it forever.
    const r = report({
      screened: 0,
      fingerprints: 0,
      candidates: 0,
      findings: [],
      errors: ['FW_BLOCKED_JA4 unreadable: boom'],
    });
    expect(text(r)).toContain('unreadable');
    expect(text(r)).not.toContain('nothing wants a human');
    expect(isActionable(r)).toBe(true);
  });
});

describe('isActionable', () => {
  const base: WatchReport = {
    window: rollingWindow(24, new Date('2026-08-05T12:00:00.000Z')),
    screened: 0,
    fingerprints: 0,
    candidates: 0,
    truncated: false,
    findings: [],
    enforcement: [],
    errors: [],
  };
  const withVerdict = (v: Advice['verdict']): WatchReport => ({
    ...base,
    findings: [
      {
        digest: 't13dnewx00_abcabcabcabc_defdefdefdef',
        allowed: 500,
        total: 500,
        advice: { verdict: v, reasons: [], blockers: [], leverNotes: [] },
      },
    ],
  });

  test('only a ban is actionable — watch and leave are not', () => {
    // The exit code drives a loop. Waking a human for `watch` every hour is how a watch gets
    // muted, and a muted watch is worse than none.
    expect(isActionable(withVerdict('ban'))).toBe(true);
    for (const v of ['watch', 'leave', 'already', 'staged'] as const)
      expect(isActionable(withVerdict(v))).toBe(false);
  });

  test('an enforcement failure is actionable with no findings', () => {
    expect(isActionable({ ...base, enforcement: ['x'] })).toBe(true);
  });

  test('an empty report is quiet', () => {
    expect(isActionable(base)).toBe(false);
  });

  test('a truncated screen that found nothing escalates', () => {
    // Capped and empty cannot be told apart from genuinely quiet — the rows we wanted may have
    // been the ones dropped, which is the silent-truncation failure this tool exists to notice.
    expect(isActionable({ ...base, truncated: true })).toBe(true);
  });

  test('a truncated screen that DID find fingerprints does not', () => {
    // We saw something, so the run is not blind. Escalating every capped window is how a watch
    // gets muted, and a muted watch is worse than none.
    expect(isActionable({ ...base, truncated: true, fingerprints: 3 })).toBe(
      false,
    );
  });
});
