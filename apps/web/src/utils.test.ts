import { describe, expect, test } from 'bun:test';

import { cleanTitle, companySearchName } from './utils.ts';

// These cases MUST stay in lockstep with apps/desktop/src/main/site.test.ts —
// the two cleanTitle copies mirror each other, and drift breaks the desktop preview title.
describe('cleanTitle (web mirror of the desktop shell)', () => {
  test('strips a pipe-separated site name (with or without .co.uk)', () => {
    expect(cleanTitle('Acme Ltd | SponsorSearch')).toBe('Acme Ltd');
    expect(cleanTitle('Acme Ltd | SponsorSearch.co.uk')).toBe('Acme Ltd');
  });

  test('strips hyphen / en-dash / em-dash separated site names', () => {
    expect(cleanTitle('Acme Ltd - SponsorSearch')).toBe('Acme Ltd');
    expect(cleanTitle('Acme Ltd – SponsorSearch')).toBe('Acme Ltd');
    expect(cleanTitle('Acme Ltd — SponsorSearch')).toBe('Acme Ltd');
  });

  test('strips the "- UK Visa Sponsor" suffix', () => {
    expect(cleanTitle('Acme Ltd - UK Visa Sponsor')).toBe('Acme Ltd');
  });

  test('is case-insensitive on the suffix', () => {
    expect(cleanTitle('Acme Ltd | sponsorsearch')).toBe('Acme Ltd');
  });

  test('leaves a suffix-less title untouched (trimmed)', () => {
    expect(cleanTitle('Just A Company')).toBe('Just A Company');
    expect(cleanTitle('  Padded  ')).toBe('Padded');
  });

  test('only strips a trailing suffix, not a mid-title mention', () => {
    expect(cleanTitle('SponsorSearch helps Acme Ltd')).toBe(
      'SponsorSearch helps Acme Ltd',
    );
  });
});

describe('companySearchName', () => {
  test('strips trailing legal suffixes', () => {
    expect(companySearchName('Acme Ltd')).toBe('Acme');
    expect(companySearchName('Acme Limited')).toBe('Acme');
    expect(companySearchName('Globex PLC')).toBe('Globex');
    expect(companySearchName('Initech LLP')).toBe('Initech');
    expect(companySearchName('Acme, Inc')).toBe('Acme');
    expect(companySearchName('Acme Holdings Ltd.')).toBe('Acme Holdings');
  });

  test('strips parenthetical qualifiers like (UK)', () => {
    expect(companySearchName('Acme (UK) Ltd')).toBe('Acme');
    expect(companySearchName('Acme (UK) Limited')).toBe('Acme');
    expect(companySearchName('Acme (Holdings) PLC')).toBe('Acme');
  });

  test('strips a dangling "& Co" once the suffix is gone', () => {
    expect(companySearchName('Smith & Co Ltd')).toBe('Smith');
    expect(companySearchName('Smith and Co Limited')).toBe('Smith');
  });

  test('drops a "t/a" trading-as tail', () => {
    expect(companySearchName('Foo Ltd t/a Bar')).toBe('Foo');
    expect(companySearchName('Foo Limited trading as Bar')).toBe('Foo');
  });

  test('keeps meaningful name words (Group, Holdings, leading UK)', () => {
    expect(companySearchName('Acme Group Limited')).toBe('Acme Group');
    expect(companySearchName('UK Power Networks Limited')).toBe(
      'UK Power Networks',
    );
    expect(companySearchName('Marks & Spencer Group Plc')).toBe(
      'Marks & Spencer Group',
    );
  });

  test('collapses whitespace and tidies punctuation', () => {
    expect(companySearchName('  Acme   Ltd  ')).toBe('Acme');
  });

  test('falls back to the original when cleaning would empty it', () => {
    expect(companySearchName('Limited')).toBe('Limited');
    expect(companySearchName('Acme')).toBe('Acme');
  });
});
