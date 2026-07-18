import { describe, expect, test } from 'bun:test';

import { matchShortcut, type ShortcutInput } from './keyboard-shortcuts.ts';

/** A keyDown with no modifiers/flags; override per case. */
function key(overrides: Partial<ShortcutInput>): ShortcutInput {
  return {
    type: 'keyDown',
    code: '',
    shift: false,
    alt: false,
    meta: false,
    control: false,
    isAutoRepeat: false,
    ...overrides,
  };
}

describe('matchShortcut', () => {
  describe('macOS (⌘ modifier)', () => {
    test('⌘[ / ⌘] navigate', () => {
      expect(
        matchShortcut(key({ code: 'BracketLeft', meta: true }), true),
      ).toBe('back');
      expect(
        matchShortcut(key({ code: 'BracketRight', meta: true }), true),
      ).toBe('forward');
    });

    test('⌘⇧S / ⌘⇧C / ⌘⇧D drive the utility commands', () => {
      expect(
        matchShortcut(key({ code: 'KeyS', meta: true, shift: true }), true),
      ).toBe('share');
      expect(
        matchShortcut(key({ code: 'KeyC', meta: true, shift: true }), true),
      ).toBe('toggle-cursor');
      expect(
        matchShortcut(key({ code: 'KeyD', meta: true, shift: true }), true),
      ).toBe('toggle-theme');
    });

    test('Ctrl (not ⌘) does nothing on mac', () => {
      expect(
        matchShortcut(key({ code: 'BracketLeft', control: true }), true),
      ).toBeNull();
    });
  });

  describe('Windows / Linux (Ctrl modifier)', () => {
    test('Ctrl[ / Ctrl] navigate', () => {
      expect(
        matchShortcut(key({ code: 'BracketLeft', control: true }), false),
      ).toBe('back');
      expect(
        matchShortcut(key({ code: 'BracketRight', control: true }), false),
      ).toBe('forward');
    });

    test('Ctrl⇧S fires share', () => {
      expect(
        matchShortcut(key({ code: 'KeyS', control: true, shift: true }), false),
      ).toBe('share');
    });

    test('⌘ (not Ctrl) does nothing off mac', () => {
      expect(
        matchShortcut(key({ code: 'BracketLeft', meta: true }), false),
      ).toBeNull();
    });
  });

  describe('guards', () => {
    test('no modifier → no match (plain [ types normally)', () => {
      expect(matchShortcut(key({ code: 'BracketLeft' }), true)).toBeNull();
    });

    test('shift mismatch → no match (⌘S without shift ≠ share)', () => {
      expect(
        matchShortcut(key({ code: 'KeyS', meta: true, shift: false }), true),
      ).toBeNull();
    });

    test('an unbound key → no match', () => {
      expect(matchShortcut(key({ code: 'KeyX', meta: true }), true)).toBeNull();
    });

    test('keyUp is ignored (fire on press, not release)', () => {
      expect(
        matchShortcut(
          key({ code: 'BracketLeft', meta: true, type: 'keyUp' }),
          true,
        ),
      ).toBeNull();
    });

    test('Alt held → no match', () => {
      expect(
        matchShortcut(
          key({ code: 'BracketLeft', meta: true, alt: true }),
          true,
        ),
      ).toBeNull();
    });

    test('auto-repeat is ignored (a held shortcut fires once)', () => {
      expect(
        matchShortcut(
          key({ code: 'BracketLeft', meta: true, isAutoRepeat: true }),
          true,
        ),
      ).toBeNull();
    });
  });
});
