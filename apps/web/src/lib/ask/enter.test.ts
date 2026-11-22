import { describe, expect, test } from 'bun:test';

import {
  enterIntent,
  enterOpensRow,
  offerStands,
  settleEnterIntent,
  submitPress,
} from './enter';

const TEXT = 'care homes in leeds';

describe('enterIntent', () => {
  test('a press while the text is still being searched, or not yet committed, is remembered; a settled or running one, or an empty box, is not', () => {
    expect(
      enterIntent(TEXT, {
        search: 'care homes in',
        loading: false,
        asking: false,
      }),
    ).toBe(TEXT);
    expect(
      enterIntent(`${TEXT} `, { search: TEXT, loading: true, asking: false }),
    ).toBe(TEXT);
    expect(
      enterIntent(TEXT, { search: TEXT, loading: false, asking: false }),
    ).toBeNull();
    expect(
      enterIntent(TEXT, {
        search: 'care homes in',
        loading: true,
        asking: true,
      }),
    ).toBeNull();
    expect(
      enterIntent('  ', { search: '', loading: true, asking: false }),
    ).toBeNull();
  });
});

describe('settleEnterIntent', () => {
  const at = { typed: TEXT, search: TEXT };

  test('asks once the offer is on for the text; holds while its search runs or the URL lags; drops when the text moved on or the search settled without the offer', () => {
    expect(
      settleEnterIntent(TEXT, { ...at, eligible: true, loading: false }),
    ).toBe('ask');
    expect(
      settleEnterIntent(TEXT, { ...at, eligible: false, loading: true }),
    ).toBe('hold');
    expect(
      settleEnterIntent(TEXT, {
        ...at,
        search: 'care homes in',
        eligible: false,
        loading: false,
      }),
    ).toBe('hold');
    expect(
      settleEnterIntent(TEXT, { ...at, eligible: false, loading: false }),
    ).toBe('drop');
    expect(
      settleEnterIntent(TEXT, {
        ...at,
        typed: `${TEXT} today`,
        eligible: true,
        loading: false,
      }),
    ).toBe('drop');
  });
});

describe('offerStands', () => {
  test('the offer stands for the committed text only: text typed since waits for its own search', () => {
    expect(offerStands(TEXT, { search: TEXT, eligible: true })).toBe(true);
    expect(offerStands(`${TEXT} `, { search: TEXT, eligible: true })).toBe(
      true,
    );
    expect(offerStands(`${TEXT} today`, { search: TEXT, eligible: true })).toBe(
      false,
    );
    expect(offerStands(TEXT, { search: TEXT, eligible: false })).toBe(false);
  });
});

describe('enterOpensRow', () => {
  test("a keyboard's Enter opens the highlighted row; a phone keyboard's search key opens none, though a name search lists its top row highlighted", () => {
    expect(enterOpensRow(0, true)).toBe(true);
    expect(enterOpensRow(3, true)).toBe(true);
    expect(enterOpensRow(0, false)).toBe(false);
    expect(enterOpensRow(3, false)).toBe(false);
  });

  test('with no row highlighted Enter opens nothing, keyboard or not', () => {
    expect(enterOpensRow(-1, true)).toBe(false);
    expect(enterOpensRow(-1, false)).toBe(false);
  });
});

describe('submitPress', () => {
  test("a submit of the box is the press, once, and never loads a page: a phone keyboard's search key submits as Enter does", () => {
    let prevented = 0;
    let pressed = 0;
    submitPress({ preventDefault: () => prevented++ }, () => pressed++);
    expect(prevented).toBe(1);
    expect(pressed).toBe(1);
  });

  test('a box with nobody to hand the press to still keeps the page', () => {
    let prevented = 0;
    submitPress({ preventDefault: () => prevented++ });
    expect(prevented).toBe(1);
  });
});
