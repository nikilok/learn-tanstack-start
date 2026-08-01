import { describe, expect, test } from 'bun:test';

import type {
  MergedWebsite,
  RevalidateResult,
  StoredWebsite,
} from './revalidate.ts';
import { mergeRevalidation } from './revalidate.ts';

/**
 * These rules used to live in SQL CASE expressions inside makeApplyResult,
 * where nothing could reach them without a database. Three defects settled
 * there across two review rounds, and each one is pinned below by name.
 */

const stored = (over: Partial<StoredWebsite> = {}): StoredWebsite => ({
  url: 'https://www.example.co.uk',
  evidence: 'registry',
  evidenceUrl: null,
  confidence: '0.950',
  ...over,
});

const result = (over: Partial<RevalidateResult> = {}): RevalidateResult => ({
  url: 'https://www.example.co.uk',
  status: 'verified',
  evidence: 'registry',
  confidence: '0.950',
  evidenceUrl: null,
  failureCount: 0,
  checkedAt: true,
  verified: true,
  live: true,
  hostAnswered: true,
  note: '',
  ...over,
});

const merge = (
  s: Partial<StoredWebsite> = {},
  r: Partial<RevalidateResult> = {},
): MergedWebsite => mergeRevalidation(stored(s), result(r));

describe('mergeRevalidation — evidence_url', () => {
  test('keeps the stored proof page when this pass found none', () => {
    // The defect: a bare assignment wrote NULL on every later pass, and
    // first-pass-only probing meant it could never be rebuilt.
    const next = merge(
      {
        evidence: 'crn_on_page',
        evidenceUrl: 'https://acme.co.uk/contact',
        confidence: '0.990',
      },
      { evidence: 'crn_on_page', confidence: '0.990', evidenceUrl: null },
    );
    expect(next.evidenceUrl).toBe('https://acme.co.uk/contact');
  });

  test('replaces it when this pass found a new one', () => {
    const next = merge(
      { evidenceUrl: 'https://acme.co.uk/old' },
      {
        evidenceUrl: 'https://acme.co.uk/terms',
        evidence: 'crn_on_page',
        confidence: '0.990',
      },
    );
    expect(next.evidenceUrl).toBe('https://acme.co.uk/terms');
  });

  test('survives a failed pass, which reports no proof', () => {
    const next = merge(
      { evidenceUrl: 'https://acme.co.uk/contact' },
      {
        status: 'unreachable',
        live: false,
        verified: false,
        failureCount: 1,
        evidenceUrl: null,
      },
    );
    expect(next.evidenceUrl).toBe('https://acme.co.uk/contact');
  });
});

describe('mergeRevalidation — confidence', () => {
  test('follows the evidence DOWN, not just up', () => {
    // Was "never slips backwards", which held only while revalidate could not
    // lower a tier. Once registry_confirmed became revocable, a monotonic
    // confidence left 0.970 beside evidence `registry`, and
    // upgradeOnlyPredicateSql then rejected every correction the registry
    // published for that company — permanently, on every monthly import.
    const next = merge(
      { evidence: 'registry_confirmed', confidence: '0.970' },
      { evidence: 'registry', confidence: '0.950' },
    );
    expect(next.evidence).toBe('registry');
    expect(next.confidence).toBe('0.950');
  });

  test('rises with a promotion', () => {
    const next = merge(
      { confidence: '0.950' },
      { evidence: 'crn_on_page', confidence: '0.990' },
    );
    expect(next.confidence).toBe('0.990');
  });

  test('treats a null stored confidence as zero, not as NaN', () => {
    const next = merge({ confidence: null }, { confidence: '0.950' });
    expect(next.confidence).toBe('0.950');
  });

  test('is always written to three places, matching the column', () => {
    expect(merge({ confidence: null }, { confidence: '1' }).confidence).toBe(
      '1.000',
    );
  });
});

describe('mergeRevalidation — liveness columns', () => {
  test('carries the status the revalidation decided', () => {
    expect(merge({}, { status: 'dead' }).status).toBe('dead');
    expect(merge({}, { status: 'unreachable' }).status).toBe('unreachable');
  });

  test('carries the url the revalidation settled on', () => {
    const next = merge({}, { url: 'https://example.co.uk' });
    expect(next.url).toBe('https://example.co.uk');
  });

  test('carries the failure count and the verified-at bump', () => {
    expect(merge({}, { failureCount: 2 }).failureCount).toBe(2);
    expect(merge({}, { verified: false }).bumpVerifiedAt).toBe(false);
    expect(merge({}, { verified: true }).bumpVerifiedAt).toBe(true);
  });
});

describe('mergeRevalidation — every column is decided', () => {
  test('returns a value for each column the writer assigns', () => {
    // If a column is added to the UPDATE without being added here, this fails
    // rather than the column silently writing undefined.
    const next = merge();
    expect(Object.keys(next).sort()).toEqual([
      'bumpVerifiedAt',
      'confidence',
      'evidence',
      'evidenceUrl',
      'failureCount',
      'status',
      'url',
    ]);
    for (const [key, value] of Object.entries(next)) {
      expect(value, `${key} must be decided`).not.toBeUndefined();
    }
  });
});
