import { describe, expect, test } from 'bun:test';

import { parseThemeMode, splashIsDark } from './theme-mode.ts';

describe('parseThemeMode', () => {
  test('accepts the three the web app actually uses', () => {
    expect(parseThemeMode('light')).toBe('light');
    expect(parseThemeMode('dark')).toBe('dark');
    expect(parseThemeMode('auto')).toBe('auto');
  });

  test('anything else reads as never-saved', () => {
    // A hand-edited or half-written file must not be able to force a theme.
    for (const value of ['', 'Dark', 'system', 0, 1, null, undefined, {}, []]) {
      expect(parseThemeMode(value)).toBe(null);
    }
  });
});

describe('splashIsDark', () => {
  test('an explicit choice wins over the OS', () => {
    expect(splashIsDark('light', true)).toBe(false);
    expect(splashIsDark('dark', false)).toBe(true);
  });

  test('auto follows the OS', () => {
    expect(splashIsDark('auto', true)).toBe(true);
    expect(splashIsDark('auto', false)).toBe(false);
  });

  test('a first-ever launch follows the OS too, not a hardcoded dark', () => {
    // Nothing saved yet: a light-mode user should not open onto a dark rectangle.
    expect(splashIsDark(null, false)).toBe(false);
    expect(splashIsDark(null, true)).toBe(true);
  });
});
