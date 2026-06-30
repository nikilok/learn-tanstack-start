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
}

interface Window {
  titlebar: TitlebarApi;
}
