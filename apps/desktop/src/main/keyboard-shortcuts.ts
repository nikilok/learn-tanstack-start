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

/** Binds the app's keyboard shortcuts on each target view, so they fire whichever one holds keyboard focus. */
export function registerKeyboardShortcuts(
  targets: Electron.WebContents[],
  actions: ShortcutActions,
): void {
  const isMac = process.platform === 'darwin';
  const onKey = (event: Electron.Event, input: Electron.Input): void => {
    // Ignore auto-repeat so a held shortcut fires once, not a burst (theme strobe / rapid back).
    if (input.type !== 'keyDown' || input.alt || input.isAutoRepeat) return;
    const mod = isMac ? input.meta : input.control;
    if (!mod) return;
    // Match the physical key + Shift (layout-proof: [ / ] work on QWERTZ/AZERTY too).
    const hit = BINDINGS.find(
      (b) => b.code === input.code && b.shift === input.shift,
    );
    if (!hit) return;
    event.preventDefault();
    if (hit.id === 'back' || hit.id === 'forward') actions.navigate(hit.id);
    else actions.command(hit.id);
  };
  for (const wc of targets) wc.on('before-input-event', onKey);
}
