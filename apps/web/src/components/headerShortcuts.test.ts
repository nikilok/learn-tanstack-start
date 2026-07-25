import { describe, expect, test } from 'bun:test';

// The shell's own table, imported so parity is enforced rather than asserted from a copy.
import { SHORTCUTS as SHELL } from '../../../desktop/src/shared/shortcuts.ts';
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
    key: '',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...overrides,
  };
}

describe('SHORTCUTS parity with the desktop shell', () => {
  // Rebinding either table breaks this, so the two surfaces can't teach different keys.
  test.each(['share', 'toggle-cursor', 'filters'] as const)(
    '%s matches the shell entry exactly',
    (id) => {
      expect(SHORTCUTS[id]).toEqual(SHELL[id]);
    },
  );

  test('theme diverges — the shell’s mod+shift+D is "Bookmark All Tabs" in a browser', () => {
    expect(SHELL['toggle-theme'].code).toBe('KeyD');
    expect(SHORTCUTS['toggle-theme']).toEqual({
      code: 'KeyL',
      shift: true,
      keys: ['mod', 'shift', 'L'],
    });
  });

  test('back/forward are dropped — the browser binds mod+[ / mod+] natively', () => {
    expect(SHELL.back).toBeDefined();
    expect(SHELL.forward).toBeDefined();
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
        key({ code: 'KeyF', key: 'F', metaKey: true, shiftKey: true }),
        'filters',
        true,
      ),
    ).toBe(true);
  });

  test('Ctrl+Shift+F fires filters off macOS', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyF', key: 'F', ctrlKey: true, shiftKey: true }),
        'filters',
        false,
      ),
    ).toBe(true);
  });

  test('the other platform’s modifier does not fire', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyF', key: 'F', ctrlKey: true, shiftKey: true }),
        'filters',
        true,
      ),
    ).toBe(false);
    expect(
      matchesShortcut(
        key({ code: 'KeyF', key: 'F', metaKey: true, shiftKey: true }),
        'filters',
        false,
      ),
    ).toBe(false);
  });

  test('a bare modifier without Shift does not fire', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyF', key: 'f', metaKey: true }),
        'filters',
        true,
      ),
    ).toBe(false);
  });

  test('Alt is excluded — it changes the character and carries AltGr', () => {
    expect(
      matchesShortcut(
        key({
          code: 'KeyF',
          key: 'F',
          metaKey: true,
          shiftKey: true,
          altKey: true,
        }),
        'filters',
        true,
      ),
    ).toBe(false);
  });

  // Auto-repeat is the caller's business: useShortcut still preventDefaults a repeat so
  // the browser's own binding for the chord never runs, then skips the handler.
  test('a repeat still matches, so the caller can cancel it', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyL', key: 'L', metaKey: true, shiftKey: true }),
        'toggle-theme',
        true,
      ),
    ).toBe(true);
  });

  test('the physical key position fires even where it types another letter', () => {
    // Dvorak: physical KeyS types 'o'.
    expect(
      matchesShortcut(
        key({ code: 'KeyS', key: 'O', metaKey: true, shiftKey: true }),
        'share',
        true,
      ),
    ).toBe(true);
  });

  test('the advertised letter fires wherever it lives on the layout', () => {
    // Dvorak: 'S' is typed by physical KeyO — the chip says ⌘⇧S, so ⌘⇧S must work.
    expect(
      matchesShortcut(
        key({ code: 'KeyO', key: 'S', metaKey: true, shiftKey: true }),
        'share',
        true,
      ),
    ).toBe(true);
  });

  test('an unrelated chord fires nothing', () => {
    expect(
      matchesShortcut(
        key({ code: 'KeyQ', key: 'Q', metaKey: true, shiftKey: true }),
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

  test('nothing before the platform is known — SSR must not guess', () => {
    expect(keycaps('filters', null)).toEqual([]);
  });
});

describe('ariaKeyShortcuts', () => {
  test('names only the modifier the matcher actually accepts', () => {
    expect(ariaKeyShortcuts('filters', true)).toBe('Meta+Shift+F');
    expect(ariaKeyShortcuts('filters', false)).toBe('Control+Shift+F');
  });

  test('absent before the platform is known, so no false shortcut is announced', () => {
    expect(ariaKeyShortcuts('toggle-cursor', null)).toBeUndefined();
  });
});
