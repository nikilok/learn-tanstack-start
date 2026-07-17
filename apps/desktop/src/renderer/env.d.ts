type Unsubscribe = () => void;
type TitlebarCommand = 'toggle-theme' | 'toggle-cursor' | 'share' | 'home';
type NavTooltipKind = 'back' | 'forward';

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
  // Nav-arrow hover -> main (bar view); nav tooltip content <- main (tooltip view).
  hoverNav(payload: { kind: NavTooltipKind; x: number } | null): void;
  onNavTooltip(
    cb: (payload: { kind: NavTooltipKind } | null) => void,
  ): Unsubscribe;
  platform: string;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  onMaximized(cb: (max: boolean) => void): Unsubscribe;
}

interface Window {
  titlebar: TitlebarApi;
}
