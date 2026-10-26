import { describe, expect, test } from 'bun:test';

import { type Officer, officerNamedIn, officersOf } from './officer-names';

describe('officersOf', () => {
  test('reads people from the officers API, current or resigned', () => {
    expect(
      officersOf({
        items: [
          { name: 'TALLOWMERE, Idris James', officer_role: 'director' },
          {
            name: 'FARADAY-QUIST, Morwenna',
            officer_role: 'secretary',
            resigned_on: '2019-04-01',
          },
        ],
      }),
    ).toEqual([
      { forename: 'IDRIS', surname: 'TALLOWMERE', current: true },
      { forename: 'MORWENNA', surname: 'FARADAY-QUIST', current: false },
    ]);
  });

  test('leaves out corporate officers and names it cannot split', () => {
    expect(
      officersOf({
        items: [
          { name: 'VARROWBY SECRETARIES LIMITED' },
          { name: 'HESTWICK, NOMINEES LIMITED' },
          { name: 'TALLOWMERE' },
          { name: 'TALLOWMERE, J' },
          { name: '' },
          {},
        ],
      }),
    ).toEqual([]);
  });

  test('anything but a list of items reads as no officers', () => {
    expect(officersOf(null)).toEqual([]);
    expect(officersOf({ items: 'none' })).toEqual([]);
  });
});

describe('officerNamedIn', () => {
  const idris: Officer = {
    forename: 'IDRIS',
    surname: 'TALLOWMERE',
    current: true,
  };

  test('forename then surname, with up to two middle names or initials between', () => {
    expect(officerNamedIn('Meet Idris Tallowmere, our founder', [idris])).toBe(
      true,
    );
    expect(officerNamedIn('Idris J. Tallowmere', [idris])).toBe(true);
    expect(officerNamedIn('Idris James Owen Tallowmere', [idris])).toBe(true);
    expect(officerNamedIn('Idris James Owen Rhys Tallowmere', [idris])).toBe(
      false,
    );
  });

  test('a surname alone, or a forename inside another word, is not a name', () => {
    expect(officerNamedIn('Contact Mr Tallowmere', [idris])).toBe(false);
    expect(officerNamedIn('Davidris Tallowmere', [idris])).toBe(false);
    expect(officerNamedIn('Idris Tallowmereson', [idris])).toBe(false);
  });

  test('a double-barrelled surname must be whole', () => {
    const morwenna: Officer = {
      forename: 'MORWENNA',
      surname: 'FARADAY-QUIST',
      current: true,
    };
    expect(officerNamedIn('Morwenna Faraday-Quist', [morwenna])).toBe(true);
    expect(officerNamedIn('Morwenna Faraday', [morwenna])).toBe(false);
  });
});
