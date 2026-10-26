import { describe, expect, test } from 'bun:test';

import {
  MAX_PAGE_POSTCODES,
  pagePostcodes,
  placePhrases,
  postcodeDistrict,
  textNamesPlace,
} from './place-signal';

describe('placePhrases', () => {
  test('register towns and the registered locality, letters only, once each', () => {
    expect(
      placePhrases(['St. Albans', 'HARROGATE', null], 'Harrogate'),
    ).toEqual(['ST ALBANS', 'HARROGATE']);
  });

  test('a place shorter than four letters is too common a word to count', () => {
    expect(placePhrases(['Ely', 'Hull'], 'Rye')).toEqual(['HULL']);
  });
});

describe('textNamesPlace', () => {
  test('whole words only: Ware is not in software', () => {
    expect(textNamesPlace('Bespoke software for clinics', ['WARE'])).toBe(
      false,
    );
    expect(textNamesPlace('Our office in Ware, Hertfordshire', ['WARE'])).toBe(
      true,
    );
  });

  test('a phrase reads through punctuation and case', () => {
    expect(
      textNamesPlace('Visit us: 4 High St, St Albans.', ['ST ALBANS']),
    ).toBe(true);
    expect(textNamesPlace('newcastle-upon-tyne', ['NEWCASTLE UPON TYNE'])).toBe(
      true,
    );
  });
});

describe('pagePostcodes', () => {
  test('reads postcodes with or without the space, once each, in page order', () => {
    expect(
      pagePostcodes('HG1 9ZQ and hg19zq, then SO22 5AZ\nand M1 1AE'),
    ).toEqual(['HG1 9ZQ', 'SO22 5AZ', 'M1 1AE']);
  });

  test('keeps the first MAX_PAGE_POSTCODES only', () => {
    const many = Array.from(
      { length: MAX_PAGE_POSTCODES + 5 },
      (_, i) => `B${i + 1} 1AA`,
    ).join(', ');
    expect(pagePostcodes(many)).toHaveLength(MAX_PAGE_POSTCODES);
  });
});

describe('postcodeDistrict', () => {
  test('is the outward code', () => {
    expect(postcodeDistrict('so22 5az')).toBe('SO22');
    expect(postcodeDistrict('SW1A1AA')).toBe('SW1A');
  });

  test('a postcode too short to have one has none', () => {
    expect(postcodeDistrict('')).toBe('');
    expect(postcodeDistrict('AB1')).toBe('');
  });
});
