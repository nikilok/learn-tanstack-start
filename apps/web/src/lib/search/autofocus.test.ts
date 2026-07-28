import { describe, expect, test } from 'bun:test';

import { shouldAutoFocusSearch } from './autofocus';

const HERO = {
  isStuck: false,
  search: '',
  filterMode: false,
  isPreview: false,
};

describe('search input autofocus', () => {
  test('claims focus on the empty hero', () => {
    expect(shouldAutoFocusSearch(HERO)).toBe(true);
  });

  test('stands down in filter mode', () => {
    // A nameless filtered listing is the answer already; focusing it opens the
    // soft keyboard over the results on mobile.
    expect(shouldAutoFocusSearch({ ...HERO, filterMode: true })).toBe(false);
    // Still suppressed with a term short enough to pass the length gate.
    expect(
      shouldAutoFocusSearch({ ...HERO, filterMode: true, search: 'ac' }),
    ).toBe(false);
  });

  test('stands down for a deep-linked query', () => {
    expect(shouldAutoFocusSearch({ ...HERO, search: 'acme' })).toBe(false);
    // Under the run-a-search threshold the hero is still what is on screen.
    expect(shouldAutoFocusSearch({ ...HERO, search: 'ac' })).toBe(true);
  });

  test('stands down inside the /download preview iframe', () => {
    // An ungated autofocus yanks focus and scroll from the parent page.
    expect(shouldAutoFocusSearch({ ...HERO, isPreview: true })).toBe(false);
  });

  test('stands down once the bar is stuck', () => {
    expect(shouldAutoFocusSearch({ ...HERO, isStuck: true })).toBe(false);
  });
});
