// Flipped once by the root component's first client effect. Distinguishes the
// SSR-hydration mount (which must render exactly the server HTML, so it can't
// read localStorage) from later SPA mounts, app-wide — a Home-local flag would
// stay false for sessions whose first client-rendered route isn't Home.
let done = false;

/** True once the initial hydration commit has completed. */
export function hydrationDone(): boolean {
  return done;
}

/** Called from the root component's mount effect; idempotent. */
export function markHydrationDone(): void {
  done = true;
}
