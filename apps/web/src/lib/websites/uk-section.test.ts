import { describe, expect, test } from 'bun:test';

import { ukSection } from './uk-section';

const ORIGIN = 'https://www.ostrava-pumps.com';

describe('ukSection', () => {
  test("takes the homepage's en-GB alternate", () => {
    const html = `<head>
      <link rel="alternate" hreflang="de-de" href="https://www.ostrava-pumps.com/de-de/">
      <link rel="alternate" hreflang="en-GB" href="https://www.ostrava-pumps.com/en-gb/home">
    </head>`;
    expect(ukSection(ORIGIN, html)).toBe(
      'https://www.ostrava-pumps.com/en-gb/home',
    );
  });

  test('reads attributes in any order and quoting, and relative hrefs', () => {
    const html = `<link href='/uk/' hreflang=en-uk rel="alternate">`;
    expect(ukSection(ORIGIN, html)).toBe('https://www.ostrava-pumps.com/uk/');
  });

  test('puts a www-less alternate on the origin it was read from', () => {
    const html = `<link rel="alternate" hreflang="en-gb" href="https://ostrava-pumps.com/en-gb/">`;
    expect(ukSection(ORIGIN, html)).toBe(
      'https://www.ostrava-pumps.com/en-gb/',
    );
  });

  test('never follows an alternate onto another site, nor to the home itself', () => {
    // A UK brand site is another site: none of the checks read it.
    expect(
      ukSection(
        ORIGIN,
        `<link rel="alternate" hreflang="en-gb" href="https://www.ostrava-pumps.co.uk/en-gb/">`,
      ),
    ).toBeNull();
    expect(
      ukSection(ORIGIN, '<a href="https://uk.ostrava-pumps.com/en-gb/">UK</a>'),
    ).toBeNull();
    expect(
      ukSection(
        ORIGIN,
        `<link rel="alternate" hreflang="en-gb" href="https://www.ostrava-pumps.com/">`,
      ),
    ).toBeNull();
  });

  test('falls back to a link whose first segment is a UK locale, at its section root', () => {
    const html = `<nav><a href="/fr-fr/">France</a><a class="x" href="/en-gb/products/pumps">United Kingdom</a></nav>`;
    expect(ukSection(ORIGIN, html)).toBe(
      'https://www.ostrava-pumps.com/en-gb/',
    );
  });

  test('a path that only starts with the letters is no UK section', () => {
    expect(
      ukSection(ORIGIN, '<a href="/ukraine/">Ukraine</a><a href="/gbp/">'),
    ).toBeNull();
    expect(ukSection(ORIGIN, '<a href="/en-us/">US</a>')).toBeNull();
  });

  test('a page that shows no UK section has none', () => {
    expect(ukSection(ORIGIN, '<p>Pumps since 1921.</p>')).toBeNull();
  });
});
