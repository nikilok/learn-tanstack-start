type Unsubscribe = () => void;
type TitlebarCommand = 'toggle-theme' | 'toggle-cursor' | 'share' | 'home';
type TooltipKind =
  | 'back'
  | 'forward'
  | 'share'
  | 'toggle-cursor'
  | 'toggle-theme'
  | 'home';

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
  onCopied(cb: () => void): Unsubscribe;
  command(cmd: TitlebarCommand): void;
  // Button hover -> main (bar view); tooltip content + caret offset <- main (tooltip view).
  showTooltip(payload: { kind: TooltipKind; x: number } | null): void;
  onTooltip(
    cb: (payload: { kind: TooltipKind; caretX: number } | null) => void,
  ): Unsubscribe;
  platform: string;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  onMaximized(cb: (max: boolean) => void): Unsubscribe;
}

interface Window {
  titlebar: TitlebarApi;
}
