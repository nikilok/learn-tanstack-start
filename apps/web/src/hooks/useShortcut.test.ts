import { describe, expect, test } from 'bun:test';

import { DESKTOP_INIT_SCRIPT } from '../scripts/desktop-init';
import { shellOwnsShortcuts } from './useShortcut';

// Locks the only coupling between the header shortcuts and desktop-init's pre-paint stamp.
// It is load-bearing: the shell binds toggle-theme to mod+shift+D and preventDefaults only
// its own matches, so the web copy's mod+shift+L is NOT swallowed and would reach the
// renderer — cycling the theme through the hidden web ThemeToggle, desynced from the shell's
// own handler and its title-bar report. Renaming the attribute on either side turns these red.

describe('shellOwnsShortcuts', () => {
  test('true once the attribute is stamped, whatever its value', () => {
    expect(shellOwnsShortcuts({ dataset: { desktop: '' } })).toBe(true);
    expect(shellOwnsShortcuts({ dataset: { desktop: 'anything' } })).toBe(true);
  });

  test('false on the plain web document', () => {
    expect(shellOwnsShortcuts({ dataset: {} })).toBe(false);
  });
});

describe('desktop-init stamps the attribute this gate reads', () => {
  test('sets dataset.desktop for the Electron shell and the preview iframe', () => {
    const stamps = DESKTOP_INIT_SCRIPT.match(
      /document\.documentElement\.dataset\.desktop\s*=/g,
    );
    expect(stamps?.length).toBe(2);
  });

  test('the gate reads exactly the property the script writes', () => {
    // `dataset.desktop` on both sides — a rename on either would leave the other stranded.
    expect(DESKTOP_INIT_SCRIPT).toContain('dataset.desktop');
    expect(shellOwnsShortcuts({ dataset: { desktop: '' } })).toBe(true);
  });
});
