// Keyboard shortcuts for the header controls, mirroring the desktop shell's table
// (apps/desktop/src/shared/shortcuts.ts) so both surfaces teach the same keys — the
// two copies are locked by matching tests (headerShortcuts.test.ts /
// apps/desktop/src/main/keyboard-shortcuts.test.ts). Change one, change the other,
// except where noted below.
//
// Two deliberate divergences from the shell, both because a browser owns the key
// and Electron doesn't:
// - `back`/`forward` (mod+[ / mod+]) are absent: browsers already bind those to
//   history natively, so the web has parity without any code — and intercepting
//   them would replace real history with a same-origin-only copy.
// - `toggle-theme` is mod+shift+L, not the shell's mod+shift+D: every major browser
//   binds mod+shift+D to "Bookmark All Tabs", a menu accelerator the page cannot
//   cancel, so the keydown never arrives. (mod+shift+L is in turn Safari's
//   show-sidebar on macOS — the one platform where this control loses its key.)

export type ShortcutId = 'share' | 'toggle-cursor' | 'toggle-theme' | 'filters';

export interface ShortcutDef {
  /** Physical KeyboardEvent.code the handler matches (layout-independent). */
  code: string;
  /** Whether Shift must be held. */
  shift: boolean;
  /** Keycap tokens for the tooltip; 'mod'/'shift' resolve to the platform glyphs. */
  keys: readonly string[];
}

export const SHORTCUTS: Record<ShortcutId, ShortcutDef> = {
  share: { code: 'KeyS', shift: true, keys: ['mod', 'shift', 'S'] },
  'toggle-cursor': { code: 'KeyC', shift: true, keys: ['mod', 'shift', 'C'] },
  'toggle-theme': { code: 'KeyL', shift: true, keys: ['mod', 'shift', 'L'] },
  filters: { code: 'KeyF', shift: true, keys: ['mod', 'shift', 'F'] },
};

/** The subset of `KeyboardEvent` the matcher reads — structural so it's testable without a DOM. */
export interface ShortcutKeyInput {
  code: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat: boolean;
}

/** Does this keydown fire `id` on this platform? Mirrors the shell's main-process matcher. */
export function matchesShortcut(
  e: ShortcutKeyInput,
  id: ShortcutId,
  isMac: boolean,
): boolean {
  if (e.altKey || e.repeat) return false;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const def = SHORTCUTS[id];
  return mod && e.shiftKey === def.shift && e.code === def.code;
}

/** Keycap glyphs for the tooltip — `⌘⇧F` on macOS, `Ctrl Shift F` everywhere else. */
export function keycaps(id: ShortcutId, isMac: boolean): string[] {
  return SHORTCUTS[id].keys.map((k) => {
    if (k === 'mod') return isMac ? '⌘' : 'Ctrl';
    if (k === 'shift') return isMac ? '⇧' : 'Shift';
    return k;
  });
}

/**
 * Both platform spellings for `aria-keyshortcuts`, which takes a space-separated
 * list of alternatives. Deliberately platform-blind: the header renders into
 * edge-cached documents (`/company/**`), so nothing here may vary by user agent.
 */
export function ariaKeyShortcuts(id: ShortcutId): string {
  const def = SHORTCUTS[id];
  const tail = def.keys.filter((k) => k !== 'mod' && k !== 'shift').join('+');
  const shift = def.shift ? 'Shift+' : '';
  return `Meta+${shift}${tail} Control+${shift}${tail}`;
}
