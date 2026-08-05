// One og:image, or shared links render the wrong aspect ratio. This is measurable in production
// rather than theoretical: with two declared, crawlers fetched the second one exclusively.

import { describe, expect, test } from 'bun:test';

import { OG_IMAGE, ogImageMeta } from './social-meta';

describe('ogImageMeta', () => {
  const meta = ogImageMeta();

  test('declares exactly one og:image', () => {
    // The regression: a second og:image won over the first for every crawler observed.
    expect(meta.filter((m) => m.property === 'og:image')).toHaveLength(1);
  });

  test('it is the 1200x630 landscape twitter:card=summary_large_image expects', () => {
    expect(OG_IMAGE.width).toBe('1200');
    expect(OG_IMAGE.height).toBe('630');
    // 1.91:1, within the tolerance every large-card surface renders without cropping.
    expect(Number(OG_IMAGE.width) / Number(OG_IMAGE.height)).toBeCloseTo(
      1.9,
      1,
    );
  });

  test('the square variant is not declared — it was what crawlers were picking', () => {
    expect(meta.some((m) => m.content.includes('og-square'))).toBe(false);
  });

  test('width and height follow their og:image, since they bind to the preceding one', () => {
    expect(meta.map((m) => m.property)).toEqual([
      'og:image',
      'og:image:width',
      'og:image:height',
    ]);
  });

  test('the url is absolute — relative og:image is not resolved by every crawler', () => {
    expect(OG_IMAGE.url).toMatch(/^https:\/\//);
  });
});
