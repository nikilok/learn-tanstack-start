// The bridge the Electron shell's preload exposes (see apps/desktop/src/preload/index.ts).

/** How the shell wants a ready update applied. */
type DesktopUpdateMode = 'install' | 'download';
/** A ready update from the shell. Older shells sent just the version string; newer ones send this. */
interface DesktopUpdateInfo {
  version: string;
  mode: DesktopUpdateMode;
}

interface SsDesktop {
  /** Subscribe to title-bar commands; returns an unsubscribe fn. */
  onCommand(cb: (cmd: string) => void): () => void;
  /** Report the custom-cursor on/off state so the title-bar icon can mirror it. */
  reportCursor(on: boolean): void;
  /** Report the active filter count so the title-bar icon can badge it. Optional: older shells predate it. */
  reportFilters?(count: number): void;
  /** Ask the preload to re-report the theme (after a mode change that didn't flip the class). */
  pokeTheme(): void;
  /** Copy text via the main-process clipboard (works without a user gesture). */
  copy(text: string): void;
  /** Subscribe to a ready update; older shells send a bare version string, newer ones send { version, mode }. Returns an unsubscribe fn. Optional: older shells predate it. */
  onUpdateReady?(cb: (update: string | DesktopUpdateInfo) => void): () => void;
  /** Act on the ready update — restart to install, or open /download for a Linux manual update. Optional: older shells predate it. */
  installUpdate?(): void;
}

interface Window {
  isSponsorSearchDesktop?: boolean;
  ssDesktop?: SsDesktop;
}
