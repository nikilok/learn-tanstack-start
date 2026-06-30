// The bridge the Electron shell's preload exposes (see apps/desktop/src/preload/index.ts).
interface SsDesktop {
  /** Subscribe to title-bar commands; returns an unsubscribe fn. */
  onCommand(cb: (cmd: string) => void): () => void;
  /** Report the custom-cursor on/off state so the title-bar icon can mirror it. */
  reportCursor(on: boolean): void;
}

interface Window {
  isSponsorSearchDesktop?: boolean;
  ssDesktop?: SsDesktop;
}
