// Mirrors the shell's table (apps/desktop/src/shared/shortcuts.ts), which headerShortcuts.test.ts imports to enforce parity.
// Diverges only where a browser owns the key: back/forward dropped (browsers bind mod+[ / mod+]), theme on L not D ("Bookmark All Tabs").

export type ShortcutId = 'share' | 'toggle-cursor' | 'toggle-theme' | 'filters';

export interface ShortcutDef {
  /** Physical KeyboardEvent.code the handler matches. */
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
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** The advertised letter — what the chip and `aria-keyshortcuts` name. */
function letterOf(def: ShortcutDef): string {
  return def.keys[def.keys.length - 1] ?? '';
}

/** Does this keydown fire `id`? Matches physical `code` OR the advertised letter, so the chip never lies on non-QWERTY. Repeats match — the caller cancels them. */
export function matchesShortcut(
  e: ShortcutKeyInput,
  id: ShortcutId,
  isMac: boolean,
): boolean {
  if (e.altKey) return false;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const def = SHORTCUTS[id];
  if (!mod || e.shiftKey !== def.shift) return false;
  return e.code === def.code || e.key.toUpperCase() === letterOf(def);
}

/** Keycap glyphs for the tooltip; empty until the platform is known (see `useIsMac`). */
export function keycaps(id: ShortcutId, isMac: boolean | null): string[] {
  if (isMac === null) return [];
  return SHORTCUTS[id].keys.map((k) => {
    if (k === 'mod') return isMac ? '⌘' : 'Ctrl';
    if (k === 'shift') return isMac ? '⇧' : 'Shift';
    return k;
  });
}

/** `aria-keyshortcuts` for the platform actually matched; undefined until it's known. */
export function ariaKeyShortcuts(
  id: ShortcutId,
  isMac: boolean | null,
): string | undefined {
  if (isMac === null) return undefined;
  const def = SHORTCUTS[id];
  return `${isMac ? 'Meta' : 'Control'}+${def.shift ? 'Shift+' : ''}${letterOf(def)}`;
}
