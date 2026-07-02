// The bridge the Electron shell's preload exposes (see apps/desktop/src/preload/index.ts).
interface SsDesktop {
  /** Subscribe to title-bar commands; returns an unsubscribe fn. */
  onCommand(cb: (cmd: string) => void): () => void;
  /** Report the custom-cursor on/off state so the title-bar icon can mirror it. */
  reportCursor(on: boolean): void;
  /** Ask the preload to re-report the theme (after a mode change that didn't flip the class). */
  pokeTheme(): void;
  /** Copy text via the main-process clipboard (works without a user gesture). */
  copy(text: string): void;
  /** Subscribe to "update downloaded & ready" (fires with the new version); returns an unsubscribe fn. Optional: older shells predate it. */
  onUpdateReady?(cb: (version: string) => void): () => void;
  /** Quit and restart into the downloaded update. Optional: older shells predate it. */
  installUpdate?(): void;
}

interface Window {
  isSponsorSearchDesktop?: boolean;
  ssDesktop?: SsDesktop;
}
