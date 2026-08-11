import { describe, expect, test } from 'bun:test';

import { isRenderingBot } from './rendering-bot';

// The exact UA observed on 2026-08-11, when Googlebot's page renders drove the
// geocode fn to ~26 Nominatim calls/min and real users' maps collapsed on the
// resulting nulls.
const GOOGLEBOT_SMARTPHONE =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.186 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

describe('isRenderingBot', () => {
  test('matches Googlebot smartphone renders', () => {
    expect(isRenderingBot(GOOGLEBOT_SMARTPHONE)).toBe(true);
  });

  test('matches classic Googlebot and bingbot', () => {
    expect(
      isRenderingBot(
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      ),
    ).toBe(true);
    expect(
      isRenderingBot(
        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
      ),
    ).toBe(true);
  });

  test('does not match real browsers (including the desktop shell, which sends a plain Chrome UA)', () => {
    expect(
      isRenderingBot(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(
      isRenderingBot(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
    expect(isRenderingBot('')).toBe(false);
  });
});
