/** Actions the shortcuts drive; implemented in index.ts, which owns the window and views. */
export interface ShortcutActions {
  navigate: (dir: 'back' | 'forward') => void;
}

/** Binds the app's keyboard shortcuts on each target view, so they fire whichever one holds keyboard focus. */
export function registerKeyboardShortcuts(
  targets: Electron.WebContents[],
  actions: ShortcutActions,
): void {
  const isMac = process.platform === 'darwin';
  const onKey = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown' || input.alt || input.shift) return;
    const mod = isMac ? input.meta : input.control;
    if (!mod) return;
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
