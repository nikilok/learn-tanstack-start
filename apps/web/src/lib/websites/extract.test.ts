import { describe, expect, test } from 'bun:test';

import {
  companyNumberVariants,
  pageHasCompanyNumber,
  pageHasPostcode,
} from './extract.ts';

const page = (body: string) =>
  `<!doctype html><html><head><title>Acme Care</title></head><body>${body}</body></html>`;

describe('companyNumberVariants', () => {
  test('offers the padded and unpadded forms of a numeric number', () => {
    expect(companyNumberVariants('03260168').sort()).toEqual([
      '03260168',
      '3260168',
    ]);
  });

  test('leaves a lettered number alone, since it is never abbreviated', () => {
    expect(companyNumberVariants('SC123456')).toEqual(['SC123456']);
    expect(companyNumberVariants('IP21143R')).toEqual(['IP21143R']);
  });

  test('does not strip a number down to something indistinct', () => {
    expect(companyNumberVariants('00000012')).toEqual(['00000012']);
  });
});

describe('pageHasCompanyNumber', () => {
  test('finds the number in a typical footer disclosure', () => {
    const html = page(
      '<footer>Acme Care Ltd. Registered in England and Wales, Company No. 03260168.</footer>',
    );
    expect(pageHasCompanyNumber(html, '03260168')).toBe(true);
  });

  test('finds it with the leading zero dropped, as sites commonly write it', () => {
    const html = page('<p>Registered in England No 3260168</p>');
    expect(pageHasCompanyNumber(html, '03260168')).toBe(true);
  });

  test('finds a lettered number case-insensitively', () => {
    expect(
      pageHasCompanyNumber(page('<p>Company sc123456</p>'), 'SC123456'),
    ).toBe(true);
  });

  test('does not match a number embedded in a longer digit run', () => {
    // The failure this prevents: a phone number or order reference that happens
    // to contain the company number as a substring.
    expect(
      pageHasCompanyNumber(page('<p>Call 0800103260168 now</p>'), '03260168'),
    ).toBe(false);
  });

  test('does not accept a different company number', () => {
    const html = page('<footer>Company No. 09999999</footer>');
    expect(pageHasCompanyNumber(html, '03260168')).toBe(false);
  });

  test('ignores numbers inside script and style bodies', () => {
    // An analytics id or a CSS content string is not a trading disclosure.
    const html = page(
      '<script>var trackingId = "03260168";</script><style>.x::after{content:"03260168"}</style><p>Welcome</p>',
    );
    expect(pageHasCompanyNumber(html, '03260168')).toBe(false);
  });

  test('ignores numbers inside HTML comments', () => {
    expect(
      pageHasCompanyNumber(page('<!-- 03260168 --><p>Welcome</p>'), '03260168'),
    ).toBe(false);
  });

  test('finds it when tags interrupt the surrounding sentence', () => {
    const html = page(
      '<p>Registered number <strong>03260168</strong> in England</p>',
    );
    expect(pageHasCompanyNumber(html, '03260168')).toBe(true);
  });

  test('is false for an empty page or an empty number', () => {
    expect(pageHasCompanyNumber('', '03260168')).toBe(false);
    expect(pageHasCompanyNumber(page('<p>hi</p>'), '')).toBe(false);
  });
});

describe('pageHasPostcode', () => {
  test('matches regardless of internal spacing', () => {
    const html = page('<address>1 High St, London SW1A1AA</address>');
    expect(pageHasPostcode(html, 'SW1A 1AA')).toBe(true);
  });

  test('matches when the page spaces it and we do not', () => {
    const html = page('<address>1 High St, London SW1A 1AA</address>');
    expect(pageHasPostcode(html, 'SW1A1AA')).toBe(true);
  });

  test('matches case-insensitively', () => {
    expect(pageHasPostcode(page('<p>london sw1a 1aa</p>'), 'SW1A 1AA')).toBe(
      true,
    );
  });

  test('matches across intervening tags, since whitespace is collapsed', () => {
    const html = page('<span>SW1A</span> <span>1AA</span>');
    expect(pageHasPostcode(html, 'SW1A 1AA')).toBe(true);
  });

  test('does not match a different postcode', () => {
    expect(pageHasPostcode(page('<p>M1 1AE</p>'), 'SW1A 1AA')).toBe(false);
  });

  test('refuses a postcode too short to be distinctive', () => {
    expect(pageHasPostcode(page('<p>M1 1A</p>'), 'M11A')).toBe(false);
    expect(pageHasPostcode(page('<p>anything</p>'), '')).toBe(false);
  });
});
