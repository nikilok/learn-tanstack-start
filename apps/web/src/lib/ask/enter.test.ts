import { describe, expect, test } from 'bun:test';

import { enterIntent, offerStands, settleEnterIntent } from './enter';

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
