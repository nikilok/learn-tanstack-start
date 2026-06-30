interface TitlebarApi {
  back(): void;
  forward(): void;
  ready(): void;
  onNavState(
    cb: (s: { canGoBack: boolean; canGoForward: boolean }) => void,
  ): void;
  onTitle(cb: (t: string) => void): void;
  onTheme(cb: (t: { dark: boolean }) => void): void;
}

interface Window {
  titlebar: TitlebarApi;
}
