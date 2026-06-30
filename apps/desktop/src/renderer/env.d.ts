type Unsubscribe = () => void;

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
  command(cmd: 'toggle-theme' | 'toggle-cursor' | 'share'): void;
  platform: string;
  windowControl(action: 'minimize' | 'maximize' | 'close'): void;
  onMaximized(cb: (max: boolean) => void): Unsubscribe;
}

interface Window {
  titlebar: TitlebarApi;
}
