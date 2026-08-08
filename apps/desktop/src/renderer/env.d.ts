import type { ShortcutId } from '../shared/shortcuts';

declare global {
  type Unsubscribe = () => void;
  type TitlebarCommand =
    | 'toggle-theme'
    | 'toggle-cursor'
    | 'share'
    | 'home'
    | 'filters';
  // Any button that can raise a tooltip: every shortcut, plus the shortcut-less logo (home).
  type TooltipKind = ShortcutId | 'home';
  // Why the local stand-in screen is up, and what it counts down to.
  type BlockReason = 'blocked' | 'offline' | 'unreachable';
  interface BlockState {
    reason: BlockReason;
    retryAt: number;
    checking: boolean;
  }

  interface TitlebarApi {
    back(): void;
    forward(): void;
    ready(): void;
    onNavState(
      cb: (s: { canGoBack: boolean; canGoForward: boolean }) => void,
    ): Unsubscribe;
    onTitle(cb: (t: string) => void): Unsubscribe;
    onTheme(cb: (t: { dark: boolean; mode: string }) => void): Unsubscribe;
    onCursor(cb: (on: boolean) => void): Unsubscribe;
    onFilters(cb: (count: number) => void): Unsubscribe;
    onCopied(cb: () => void): Unsubscribe;
    onScreenSaver(cb: (on: boolean) => void): Unsubscribe;
    command(cmd: TitlebarCommand): void;
    // Button hover -> main (bar view); tooltip content + caret offset <- main (tooltip view).
    showTooltip(payload: { kind: TooltipKind; x: number } | null): void;
    onTooltip(
      cb: (payload: { kind: TooltipKind; caretX: number } | null) => void,
    ): Unsubscribe;
    onBlocked(cb: (state: BlockState | null) => void): Unsubscribe;
    retryBlocked(): void;
    platform: string;
    windowControl(action: 'minimize' | 'maximize' | 'close'): void;
    onMaximized(cb: (max: boolean) => void): Unsubscribe;
  }

  interface Window {
    titlebar: TitlebarApi;
  }
}
