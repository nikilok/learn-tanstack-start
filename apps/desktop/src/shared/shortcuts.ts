// Single source of truth for the title-bar shortcuts, shared across the main/renderer boundary:
// the main handler binds `code`+`shift`, the tooltip overlay renders `keys` as keycaps.

export type ShortcutId =
  | 'back'
  | 'forward'
  | 'share'
  | 'toggle-cursor'
  | 'toggle-theme'
  | 'filters';

export interface ShortcutDef {
  /** Physical KeyboardEvent.code the handler matches (layout-independent). */
  code: string;
  /** Whether Shift must be held. */
  shift: boolean;
  /** Keycap tokens for the tooltip; 'mod'/'shift' resolve to the platform glyphs. */
  keys: readonly string[];
}

export const SHORTCUTS: Record<ShortcutId, ShortcutDef> = {
  back: { code: 'BracketLeft', shift: false, keys: ['mod', '['] },
  forward: { code: 'BracketRight', shift: false, keys: ['mod', ']'] },
  share: { code: 'KeyS', shift: true, keys: ['mod', 'shift', 'S'] },
  'toggle-cursor': { code: 'KeyC', shift: true, keys: ['mod', 'shift', 'C'] },
  'toggle-theme': { code: 'KeyD', shift: true, keys: ['mod', 'shift', 'D'] },
  filters: { code: 'KeyF', shift: true, keys: ['mod', 'shift', 'F'] },
};
