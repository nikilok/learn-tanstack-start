import Logo from './Logo';

/** Static brand splash for installed-PWA launches; shown then hidden at first paint by standalone-init.ts (+ styles.css). White wordmark reads on the ink background and matches the app icon. */
export default function AppSplash() {
  return (
    <div className="app-splash" aria-hidden="true">
      <Logo
        className="app-splash__logo"
        navyColor="#ffffff"
        redColor="#ffffff"
      />
    </div>
  );
}
