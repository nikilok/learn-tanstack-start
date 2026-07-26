import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';

import { cleanTitle, companySearchName, formatRelative } from './utils.ts';

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

  test('strips the home title tagline down to the brand phrase', () => {
    expect(cleanTitle('UK Sponsor Search . Skilled Worker Visa Sponsors')).toBe(
      'UK Sponsor Search',
    );
    expect(cleanTitle('UK Sponsor Search — Skilled Worker Visa Sponsors')).toBe(
      'UK Sponsor Search',
    );
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

// The clock is pinned so relative-bucket boundaries assert deterministically.
describe('formatRelative', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z');
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  test('seconds', () => {
    expect(formatRelative(ago(10 * SEC))).toBe('a few seconds ago');
    expect(formatRelative(ago(44 * SEC))).toBe('a few seconds ago');
  });

  test('minutes — singular at the 45s cutover, then plural', () => {
    expect(formatRelative(ago(60 * SEC))).toBe('1 min ago');
    expect(formatRelative(ago(5 * MIN))).toBe('5 mins ago');
    expect(formatRelative(ago(44 * MIN))).toBe('44 mins ago');
  });

  test('hours — singular then plural, up to the 22h edge', () => {
    expect(formatRelative(ago(60 * MIN))).toBe('1 hour ago');
    expect(formatRelative(ago(5 * HOUR))).toBe('5 hours ago');
    expect(formatRelative(ago(21 * HOUR))).toBe('21 hours ago');
  });

  test('days — singular then plural', () => {
    expect(formatRelative(ago(24 * HOUR))).toBe('1 day ago');
    expect(formatRelative(ago(2 * DAY))).toBe('2 days ago');
  });

  test('days → months rolls over at 26 days', () => {
    expect(formatRelative(ago(25 * DAY))).toBe('25 days ago');
    expect(formatRelative(ago(26 * DAY))).toBe('1 month ago');
    expect(formatRelative(ago(60 * DAY))).toBe('2 months ago');
    expect(formatRelative(ago(335 * DAY))).toBe('11 months ago');
  });

  test('months → years rolls over near a year', () => {
    expect(formatRelative(ago(365 * DAY))).toBe('1 year ago');
    expect(formatRelative(ago(730 * DAY))).toBe('2 years ago');
  });

  test('same instant and future dates clamp to "a few seconds ago"', () => {
    expect(formatRelative(ago(0))).toBe('a few seconds ago');
    expect(formatRelative(ago(-5 * MIN))).toBe('a few seconds ago');
  });

  test('invalid date returns an empty string', () => {
    expect(formatRelative(new Date('not a date'))).toBe('');
  });
});
