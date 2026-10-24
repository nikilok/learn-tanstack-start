import { describe, expect, test } from 'bun:test';

import { rejectSite } from './rejected-site';

// A club matched to its community trust's site, which search banked several times.
const trust = 'https://www.club-trust.org';
const banked = [
  'https://www.club-trust.org/about',
  'https://club-trust.org/',
  'https://shop.club-trust.org/kit',
  'https://www.club.co.uk/',
];

describe('rejectSite', () => {
  test('a row holding the site goes back to none, and the site leaves its candidates', () => {
    expect(rejectSite({ url: trust, candidates: banked }, trust)).toEqual({
      reset: true,
      candidates: ['https://www.club.co.uk/'],
    });
  });

  test('a row already reset keeps nothing of the site to choose again', () => {
    // The reset that only cleared the URL: the walk's next version chose it again.
    expect(
      rejectSite({ url: null, candidates: banked }, 'https://club-trust.org'),
    ).toEqual({ reset: false, candidates: ['https://www.club.co.uk/'] });
  });

  test("a row on another site keeps it, and loses only the rejected site's candidates", () => {
    expect(
      rejectSite({ url: 'https://www.club.co.uk', candidates: banked }, trust),
    ).toEqual({ reset: false, candidates: ['https://www.club.co.uk/'] });
  });

  test('only the site and its subdomains, never a host that merely ends like it', () => {
    const candidates = [
      'https://notclub-trust.org/',
      'https://club-trust.org.evil.example/',
      'not a url',
      42,
    ];
    expect(rejectSite({ url: null, candidates }, trust)).toBeNull();
  });

  test('a row banking no candidates is still taken off the site', () => {
    expect(rejectSite({ url: trust, candidates: null }, trust)).toEqual({
      reset: true,
      candidates: null,
    });
    expect(rejectSite({ url: null, candidates: null }, trust)).toBeNull();
  });

  test('the rejected site must be a URL', () => {
    expect(() =>
      rejectSite({ url: null, candidates: [] }, 'club-trust'),
    ).toThrow();
  });
});
