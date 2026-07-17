/** Actions the shortcuts drive; implemented in index.ts, which owns the window and views. */
export interface ShortcutActions {
  navigate: (dir: 'back' | 'forward') => void;
  command: (cmd: string) => void;
}

// Cmd/Ctrl + Shift + <physical key> -> a utility command sent to the page (share / cursor / theme).
const SHIFT_COMMANDS: Record<string, string> = {
  KeyS: 'share',
  KeyC: 'toggle-cursor',
  KeyD: 'toggle-theme',
};

/** Binds the app's keyboard shortcuts on each target view, so they fire whichever one holds keyboard focus. */
export function registerKeyboardShortcuts(
  targets: Electron.WebContents[],
  actions: ShortcutActions,
): void {
  const isMac = process.platform === 'darwin';
  const onKey = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown' || input.alt) return;
    const mod = isMac ? input.meta : input.control;
    if (!mod) return;
    if (input.shift) {
      // Cmd/Ctrl + Shift + S/C/D -> share / cursor / theme (by physical key, layout-proof).
      const command = SHIFT_COMMANDS[input.code];
      if (command) {
        event.preventDefault();
        actions.command(command);
      }
      return;
    }
    // Cmd/Ctrl + [ / ] navigate back / forward (Discord-style).
    if (input.key === '[') {
      event.preventDefault();
      actions.navigate('back');
    } else if (input.key === ']') {
      event.preventDefault();
      actions.navigate('forward');
    }
  };
  for (const wc of targets) wc.on('before-input-event', onKey);
}
