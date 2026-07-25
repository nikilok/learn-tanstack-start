import { describe, expect, test } from 'bun:test';

import {
  ariaKeyShortcuts,
  keycaps,
  matchesShortcut,
  SHORTCUTS,
  type ShortcutKeyInput,
} from './headerShortcuts.ts';

/** A keydown with no modifiers/flags; override per case. */
function key(overrides: Partial<ShortcutKeyInput>): ShortcutKeyInput {
  return {
    code: '',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    ...overrides,
  };
}

// Locks the table against the desktop shell's copy in
// apps/desktop/src/shared/shortcuts.ts — if that changes, this fails and the web
// header's tooltips stop lying about the keys.
describe('SHORTCUTS parity with the desktop shell', () => {
  test('binds the shell accelerators', () => {
    expect(SHORTCUTS.share).toEqual({
      code: 'KeyS',
      shift: true,
      keys: ['mod', 'shift', 'S'],
    });
    expect(SHORTCUTS['toggle-cursor']).toEqual({
      code: 'KeyC',
      shift: true,
      keys: ['mod', 'shift', 'C'],
    });
    expect(SHORTCUTS.filters).toEqual({
      code: 'KeyF',
      shift: true,
      keys: ['mod', 'shift', 'F'],
    });
  });

  test('diverges on theme — the shell’s mod+shift+D is "Bookmark All Tabs" here', () => {
    expect(SHORTCUTS['toggle-theme']).toEqual({
      code: 'KeyL',
      shift: true,
      keys: ['mod', 'shift', 'L'],
    });
  });

  test('omits back/forward — the browser binds mod+[ / mod+] natively', () => {
    expect(Object.keys(SHORTCUTS).sort()).toEqual([
      'filters',
      'share',
      'toggle-cursor',
      'toggle-theme',
    ]);
  });
});

describe('matchesShortcut', () => {
  test('⌘⇧F fires filters on macOS', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyF', metaKey: true, shiftKey: true }),
        'filters',
        true,
      ),
    ).toBe(true);
  });

  test('Ctrl+Shift+F fires filters off macOS', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyF', ctrlKey: true, shiftKey: true }),
        'filters',
        false,
      ),
    ).toBe(true);
  });

  test('the other platform’s modifier does not fire', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyF', ctrlKey: true, shiftKey: true }),
        'filters',
        true,
      ),
    ).toBe(false);
    expect(
      matchesShortcut(
        key({ code: 'KeyF', metaKey: true, shiftKey: true }),
        'filters',
        false,
      ),
    ).toBe(false);
  });

  test('a bare modifier without Shift does not fire', () => {
    expect(
      matchesShortcut(key({ code: 'KeyF', metaKey: true }), 'filters', true),
    ).toBe(false);
  });

  test('Alt is excluded — it changes the character and carries AltGr', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyF', metaKey: true, shiftKey: true, altKey: true }),
        'filters',
        true,
      ),
    ).toBe(false);
  });

  test('auto-repeat does not re-fire a held combo', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyL', metaKey: true, shiftKey: true, repeat: true }),
        'toggle-theme',
        true,
      ),
    ).toBe(false);
  });

  test('matches the physical code, so layout never shifts the binding', () => {
    // Same combo, but a layout where KeyS produces something else entirely.
    expect(
      matchesShortcut(
        key({ code: 'KeyS', metaKey: true, shiftKey: true }),
        'share',
        true,
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        key({ code: 'KeyO', metaKey: true, shiftKey: true }),
        'share',
        true,
      ),
    ).toBe(false);
  });
});

describe('keycaps', () => {
  test('glyphs on macOS, spelled-out modifiers elsewhere', () => {
    expect(keycaps('filters', true)).toEqual(['⌘', '⇧', 'F']);
    expect(keycaps('filters', false)).toEqual(['Ctrl', 'Shift', 'F']);
  });
});

describe('ariaKeyShortcuts', () => {
  test('lists both platform spellings, so the value never varies by UA', () => {
    expect(ariaKeyShortcuts('filters')).toBe('Meta+Shift+F Control+Shift+F');
    expect(ariaKeyShortcuts('toggle-cursor')).toBe(
      'Meta+Shift+C Control+Shift+C',
    );
  });
});
