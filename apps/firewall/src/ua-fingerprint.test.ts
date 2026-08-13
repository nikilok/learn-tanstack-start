// The fixture is the real 2026-08-12 measurement: the scraper claims Chrome 142/143, whose
// genuine populations live on …_222222222222, and also claims Edge 144/145, which it dominates
// on this site and which must therefore stay SILENT rather than convict it.

import { describe, expect, test } from 'bun:test';

import {
  type UaPair,
  buildUaBaseline,
  mismatchLines,
  shortUa,
  uaFingerprintCheck,
} from './ua-fingerprint';

const SUBJECT = 't13d1516h2_cccccccccccc_111111111111';
const REAL_CHROME = 't13d1516h2_cccccccccccc_222222222222';
const CH142 = 'Mozilla/5.0 (Windows NT 10.0) Chrome/142.0.0.0 Safari/537.36';
const CH143 = 'Mozilla/5.0 (Windows NT 10.0) Chrome/143.0.0.0 Safari/537.36';
const EDGE145 = 'Mozilla/5.0 (Windows NT 10.0) Chrome/145.0.0.0 Edg/145.0.0.0';

const PAIRS: UaPair[] = [
  // Chrome 142: the subject is a bystander, the real build owns it.
  { ua: CH142, digest: SUBJECT, count: 58 },
  { ua: CH142, digest: REAL_CHROME, count: 625 },
  { ua: CH142, digest: 't13d1517h2_cccccccccccc_444444444444', count: 84 },
  // Chrome 143: same shape, but the subject holds ~30% of it — inside the bystander bar.
  { ua: CH143, digest: SUBJECT, count: 38 },
  { ua: CH143, digest: REAL_CHROME, count: 77 },
  { ua: CH143, digest: 't13d1517h2_cccccccccccc_333333333333', count: 13 },
  // Edge 145: the subject IS the dominant source, so the baseline is poisoned.
  { ua: EDGE145, digest: SUBJECT, count: 61 },
  { ua: EDGE145, digest: 't13d3111h2_555555555555_666666666666', count: 22 },
];

const check = (over: Partial<Parameters<typeof uaFingerprintCheck>[0]> = {}) =>
  uaFingerprintCheck({
    digest: SUBJECT,
    subjectUas: [
      [CH142, 58],
      [CH143, 38],
      [EDGE145, 61],
    ],
    subjectTotal: 417,
    baseline: buildUaBaseline(PAIRS, true),
    ...over,
  });

describe('uaFingerprintCheck — the impersonator', () => {
  test('catches a user-agent whose real home is another fingerprint', () => {
    const v = check();
    expect(v.mismatched?.map((m) => m.ua)).toEqual([CH142]);
    expect(v.mismatched?.[0]?.rivalDigest).toBe(REAL_CHROME);
    expect(v.mismatched?.[0]?.subjectShare).toBeCloseTo(58 / 767, 3);
  });

  test('a ~30% holder is NOT convicted — that headroom is for corporate TLS inspection', () => {
    // Chrome 143 is 38 of 128 here, and by the real measurement the subject is its second
    // largest source. Zscaler-style middleboxes rewrite the ClientHello while preserving a
    // genuine user-agent, so their users look exactly like an impersonator and can be a real
    // share of a string. The bar is set below that population on purpose; tightening it is a
    // change to who gets convicted, not a display fix.
    expect(check().mismatched?.map((m) => m.ua)).not.toContain(CH143);
  });

  test('stays SILENT where the subject dominates the user-agent — a loud client cannot convict itself', () => {
    // Edge 145 is 61 of 83 here. If volume alone were the baseline, a scraper would become the
    // definition of every string it sends often enough.
    expect(check().mismatched?.map((m) => m.ua)).not.toContain(EDGE145);
  });

  test('scores the contradicted traffic against the subject total', () => {
    expect(check().share).toBeCloseTo(58 / 417, 5);
  });

  test('the note names the arithmetic an operator would check', () => {
    expect(check().note).toContain('58 of 417');
    expect(check().note).toContain('DIFFERENT fingerprint');
  });
});

describe('uaFingerprintCheck — undecidable is not innocent', () => {
  test('an unread baseline is UNKNOWN, never a clean bill of health', () => {
    const v = check({ baseline: buildUaBaseline([], true) });
    expect(v.mismatched).toBeNull();
    expect(v.share).toBeNull();
    expect(v.note).toContain('UNKNOWN');
  });

  test('a subject whose user-agents appear nowhere else is undecidable, not consistent', () => {
    const v = check({
      subjectUas: [['Some/Private Agent', 40]],
      baseline: buildUaBaseline(PAIRS, true),
    });
    expect(v.mismatched).toBeNull();
    expect(v.note).toContain('nothing to compare');
  });

  test('a subject with no user-agent or no fingerprint is undecidable', () => {
    expect(check({ subjectUas: [] }).mismatched).toBeNull();
    expect(check({ digest: '' }).mismatched).toBeNull();
  });

  test('consistent is reported as consistent, and is NOT the same value as undecidable', () => {
    const v = check({ subjectUas: [[EDGE145, 61]] });
    expect(v.mismatched).toEqual([]);
    expect(v.share).toBe(0);
    expect(v.note).toContain('consistent');
  });
});

describe('uaFingerprintCheck — truncation can only under-report', () => {
  test('a dropped RIVAL row silences the check rather than inverting it', () => {
    const v = check({
      baseline: buildUaBaseline(
        PAIRS.filter((p) => p.digest !== REAL_CHROME),
        false,
      ),
    });
    // Chrome 142's only surviving rival is the 84-request one, which does not own it.
    expect(v.mismatched).toEqual([]);
  });

  test('a dropped SUBJECT row does not fire spuriously — its count comes from its own profile', () => {
    // This is the dangerous direction: without the subject-side count, `mine` reads 0, the
    // subject looks like a bystander on a user-agent it actually owns, and the check convicts it.
    const poisoned: UaPair[] = [
      {
        ua: EDGE145,
        digest: 't13dother00_aaaaaaaaaaaa_bbbbbbbbbbbb',
        count: 22,
      },
    ];
    const v = uaFingerprintCheck({
      digest: SUBJECT,
      subjectUas: [[EDGE145, 300]], // the subject really owns this string
      subjectTotal: 300,
      baseline: buildUaBaseline(poisoned, false),
    });
    expect(v.mismatched).toEqual([]);
  });

  test('a truncated baseline says so, so a zero is read as a floor', () => {
    const v = check({ baseline: buildUaBaseline(PAIRS, false) });
    expect(v.note).toContain('floors');
  });
});

describe('mismatchLines', () => {
  test('renders the comparison an operator acts on', () => {
    const [first] = mismatchLines(check());
    expect(first).toContain('58x');
    expect(first).toContain(REAL_CHROME);
  });

  test('is empty when there is nothing to say, including when undecidable', () => {
    expect(mismatchLines(check({ subjectUas: [[EDGE145, 61]] }))).toEqual([]);
    expect(
      mismatchLines(check({ baseline: buildUaBaseline([], true) })),
    ).toEqual([]);
  });

  test('clamps to the head, since an impersonator rotates dozens of strings', () => {
    const many = Array.from({ length: 20 }, (_, i) => `UA-${i}`);
    const pairs = many.flatMap((ua): UaPair[] => [
      { ua, digest: SUBJECT, count: 1 },
      { ua, digest: REAL_CHROME, count: 99 },
    ]);
    const v = uaFingerprintCheck({
      digest: SUBJECT,
      subjectUas: many.map((ua) => [ua, 1] as [string, number]),
      subjectTotal: 20,
      baseline: buildUaBaseline(pairs, true),
    });
    expect(v.mismatched).toHaveLength(20);
    expect(mismatchLines(v)).toHaveLength(4);
  });
});

describe('shortUa', () => {
  const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

  test('keeps the VERSION, which is the whole subject of this check', () => {
    // Regression, seen live: head-truncation rendered four different contradicted strings as the
    // identical prefix, because every modern UA opens with the same ~50 characters.
    expect(shortUa(UA)).toContain('Chrome/142.0.0.0');
  });

  test('keeps the platform too, so two ends identify the string', () => {
    expect(shortUa(UA)).toContain('Mozilla/5.0');
  });

  test('two UAs differing only at the end stay distinguishable', () => {
    expect(shortUa(UA)).not.toBe(shortUa(UA.replace('142', '145')));
  });

  test('a short UA is left alone', () => {
    expect(shortUa('Bun/1.3.13')).toBe('Bun/1.3.13');
  });

  test('respects the width budget', () => {
    expect(shortUa(UA).length).toBeLessThanOrEqual(64);
  });
});
