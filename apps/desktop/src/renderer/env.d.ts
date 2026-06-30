type Unsubscribe = () => void;

interface TitlebarApi {
  back(): void;
  forward(): void;
  ready(): void;
  onNavState(
    cb: (s: { canGoBack: boolean; canGoForward: boolean }) => void,
  ): Unsubscribe;
  onTitle(cb: (t: string) => void): Unsubscribe;
  onTheme(cb: (t: { dark: boolean }) => void): Unsubscribe;
  onCursor(cb: (on: boolean) => void): Unsubscribe;
  command(cmd: 'toggle-theme' | 'toggle-cursor' | 'share'): void;
}

interface Window {
  titlebar: TitlebarApi;
}
