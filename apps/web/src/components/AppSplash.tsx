import Logo from './Logo';

/**
 * Server-rendered brand splash for installed-PWA launches (gated to
 * html[data-standalone] in styles.css). It paints navy + the white wordmark to
 * bridge the native manifest splash; standalone-init.ts then hides it at first
 * paint (html[data-splash-done]) — decoupled from React hydration, so the app
 * is revealed at first paint rather than after hydrating. Deliberately static
 * (no state, no effects, no transitions): the goal is the fastest reveal, not a
 * fade.
 */
export default function AppSplash() {
  return (
    <div className="app-splash" aria-hidden="true">
      <div className="app-splash__inner">
        {/* White wordmark reads on the ink splash and matches the app icon. */}
        <Logo
          className="app-splash__logo"
          navyColor="#ffffff"
          redColor="#ffffff"
        />
      </div>
    </div>
  );
}
