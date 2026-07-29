import { describe, expect, test } from 'bun:test';

import { namesAreCompatible, normaliseCompanyNumber } from './registry-rows.ts';

describe('normaliseCompanyNumber', () => {
  test('passes a plain 8-digit number through', () => {
    expect(normaliseCompanyNumber('03260168')).toBe('03260168');
  });

  test('restores dropped leading zeros', () => {
    // 323 CQC rows are stored unpadded; unpadded they match zero companies,
    // padded they match 120. This is the whole reason the function exists.
    expect(normaliseCompanyNumber('9024705')).toBe('09024705');
    expect(normaliseCompanyNumber('7284014')).toBe('07284014');
  });

  test('accepts lettered prefixes, including society numbers', () => {
    // IP…R looked malformed but 25 of them join to real CH profiles.
    expect(normaliseCompanyNumber('IP21143R')).toBe('IP21143R');
    expect(normaliseCompanyNumber('SC123456')).toBe('SC123456');
    expect(normaliseCompanyNumber('OC301234')).toBe('OC301234');
  });

  test('uppercases and strips incidental whitespace', () => {
    expect(normaliseCompanyNumber(' sc123456 ')).toBe('SC123456');
    expect(normaliseCompanyNumber('OC 301234')).toBe('OC301234');
  });

  test('rejects anything that is not a company number shape', () => {
    expect(normaliseCompanyNumber('123456789')).toBeNull();
    expect(normaliseCompanyNumber('N/A')).toBeNull();
    expect(normaliseCompanyNumber('not applicable')).toBeNull();
    expect(normaliseCompanyNumber('')).toBeNull();
    expect(normaliseCompanyNumber(null)).toBeNull();
  });
});

describe('namesAreCompatible', () => {
  test('accepts an exact match', () => {
    expect(
      namesAreCompatible('Greensleeves Care Ltd', 'GREENSLEEVES CARE LIMITED'),
    ).toBe(true);
  });

  test('accepts a legal-suffix difference', () => {
    expect(namesAreCompatible('Lovett Care', 'LOVETT CARE LIMITED')).toBe(true);
  });

  test('accepts when one name contains the other', () => {
    expect(
      namesAreCompatible('Milewood Healthcare', 'MILEWOOD HEALTHCARE LIMITED'),
    ).toBe(true);
  });

  test('flags two entirely unrelated companies', () => {
    // The failure this guards: a mistyped charity number zero-pads into a
    // structurally valid but unrelated company number. A false result
    // downgrades the row to registry_unconfirmed, it does not drop it.
    expect(
      namesAreCompatible('St Anne’s Community Services', 'BARCLAYS BANK PLC'),
    ).toBe(false);
    // Real CQC rows that should be flagged (the CRN points somewhere else).
    expect(
      namesAreCompatible('Carebase (Guildford) Limited', 'AMYN HOTELS LIMITED'),
    ).toBe(false);
  });

  test('stays loose enough not to be worth tightening', () => {
    // These three are real CQC rows the guard currently flags, and all three
    // are CORRECT — the CH name changed post-administration, or the trading
    // name is an acronym. They are why a flag downgrades instead of dropping.
    // Do not tune the threshold to "fix" them without re-running the
    // calibration: at 0.22% it already fires rarely enough.
    const knownFalseFlags: [string, string][] = [
      ['Llyon Health Ltd', 'LH REALISATIONS LTD'],
      ['Stapely Jewish Care Home Limited', 'SJH REALISATIONS LIMITED'],
      ['H I C A', 'HUMBERSIDE INDEPENDENT CARE ASSOCIATION LIMITED'],
    ];
    for (const [registry, ch] of knownFalseFlags) {
      expect(namesAreCompatible(registry, ch)).toBe(false);
    }
  });

  test('abstains when either name is missing', () => {
    expect(namesAreCompatible(null, 'ACME LIMITED')).toBe(true);
    expect(namesAreCompatible('ACME LIMITED', undefined)).toBe(true);
    expect(namesAreCompatible('', 'ACME LIMITED')).toBe(true);
  });

  test('a name too short to judge is not treated as confirmed', () => {
    // These returned true: "A" is a substring of nearly everything, and a
    // 1-character key produces an empty bigram set which also scored as a
    // match. That is exactly the degenerate row the guard exists for — a
    // placeholder company number of "1" zero-pads into a real company.
    expect(namesAreCompatible('A', 'BARCLAYS BANK PLC')).toBe(false);
    expect(namesAreCompatible('AC Ltd', 'ABACUS CARE LIMITED')).toBe(false);
    expect(namesAreCompatible('ACME LIMITED', 'A')).toBe(false);
  });
});
