import { SHORTCUTS } from '../shared/shortcuts';
import type { ShortcutId } from '../shared/shortcuts';

/** Actions the shortcuts drive; implemented in index.ts, which owns the window and views. */
export interface ShortcutActions {
  navigate: (dir: 'back' | 'forward') => void;
  command: (cmd: string) => void;
}

const BINDINGS = Object.entries(SHORTCUTS).map(([id, def]) => ({
  id: id as ShortcutId,
  ...def,
}));

/** The subset of Electron.Input that shortcut-matching reads — kept minimal so it's testable without an Electron event. */
export interface ShortcutInput {
  type: string;
  code: string;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  control: boolean;
  isAutoRepeat: boolean;
}

/** The shortcut an input triggers, or null. Fires only on a keyDown carrying the platform modifier (⌘ on mac, Ctrl elsewhere), no Alt, not an auto-repeat, and a physical-code + Shift match (layout-proof: [ / ] work on QWERTZ/AZERTY). */
export function matchShortcut(
  input: ShortcutInput,
  isMac: boolean,
): ShortcutId | null {
  if (input.type !== 'keyDown' || input.alt || input.isAutoRepeat) return null;
  const mod = isMac ? input.meta : input.control;
  if (!mod) return null;
  const hit = BINDINGS.find(
    (b) => b.code === input.code && b.shift === input.shift,
  );
  return hit ? hit.id : null;
}

/** Binds the app's keyboard shortcuts on each target view, so they fire whichever one holds keyboard focus. */
export function registerKeyboardShortcuts(
  targets: Electron.WebContents[],
  actions: ShortcutActions,
): void {
  const isMac = process.platform === 'darwin';
  const onKey = (event: Electron.Event, input: Electron.Input): void => {
    const id = matchShortcut(input, isMac);
    if (!id) return;
    event.preventDefault();
    if (id === 'back' || id === 'forward') actions.navigate(id);
    else actions.command(id);
  };
  for (const wc of targets) wc.on('before-input-event', onKey);
}
