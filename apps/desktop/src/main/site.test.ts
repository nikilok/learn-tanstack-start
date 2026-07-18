import { describe, expect, test } from 'bun:test';

import { cleanTitle, desktopUserAgent } from './site.ts';

describe('desktopUserAgent', () => {
  // A representative default Electron UA (Windows), carrying the two tokens the app must strip.
  const DEFAULT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SponsorSearch/0.2.1 Chrome/148.0.7778.271 Electron/42.5.0 Safari/537.36';

  test('strips the Electron token — the WAF must never see it', () => {
    expect(desktopUserAgent(DEFAULT, 'SponsorSearch', '0.2.1')).not.toContain(
      'Electron/',
    );
  });

  test('strips the productName token', () => {
    // The result still contains "SponsorSearch" (in the desktop marker) but not the "Name/version" form.
    expect(desktopUserAgent(DEFAULT, 'SponsorSearch', '0.2.1')).not.toContain(
      'SponsorSearch/0.2.1',
    );
  });

  test('produces exactly the clean Chrome UA + desktop marker', () => {
    expect(desktopUserAgent(DEFAULT, 'SponsorSearch', '0.2.1')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.271 Safari/537.36 SponsorSearchDesktop/0.2.1',
    );
  });

  test('preserves the Chrome version and platform', () => {
    const ua = desktopUserAgent(DEFAULT, 'SponsorSearch', '0.2.1');
    expect(ua).toContain('Chrome/148.0.7778.271');
    expect(ua).toContain('(Windows NT 10.0; Win64; x64)');
  });

  test('appends the marker with the supplied version', () => {
    expect(
      desktopUserAgent(DEFAULT, 'SponsorSearch', '9.9.9').endsWith(
        ' SponsorSearchDesktop/9.9.9',
      ),
    ).toBe(true);
  });

  test('works on the macOS default UA shape too', () => {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) SponsorSearch/0.2.1 Chrome/148.0.7778.271 Electron/42.5.0 Safari/537.36';
    const ua = desktopUserAgent(mac, 'SponsorSearch', '0.2.1');
    expect(ua).not.toContain('Electron/');
    expect(ua).toContain('(Macintosh; Intel Mac OS X 10_15_7)');
    expect(ua.endsWith(' SponsorSearchDesktop/0.2.1')).toBe(true);
  });

  test('escapes regex metacharacters in the app name', () => {
    // A '.' must match literally (not "any char"); a '[' must not throw an unterminated class.
    const ua =
      'Mozilla/5.0 (X) AppleWebKit/537.36 (KHTML, like Gecko) Spo.sor/0.2.1 Chrome/148.0 Electron/42.0 Safari/537.36';
    expect(desktopUserAgent(ua, 'Spo.sor', '0.2.1')).toBe(
      'Mozilla/5.0 (X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36 SponsorSearchDesktop/0.2.1',
    );
    expect(() => desktopUserAgent(ua, 'Spo[nsor', '0.2.1')).not.toThrow();
  });
});

describe('cleanTitle', () => {
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
