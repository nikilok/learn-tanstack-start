import { DESKTOP_PREVIEW_WINDOW_NAME } from '../utils/desktop-preview';

/** Where the ping goes. Paired with the Nitro route file `server/api/engaged.post.ts` — the test locks the two spellings together. */
export const ENGAGED_PATH = '/api/engaged';

/**
 * Pointer travel before movement counts as input. The browser dispatches a `pointermove` at
 * UNCHANGED coordinates to recompute hover state when something appears under a resting
 * cursor (the screensaver hit exactly this — see hooks/useIdle.ts), so a bare move event is
 * not a person moving. Six pixels is the same threshold the screensaver settled on.
 */
export const ENGAGED_DRIFT_PX = 6;

/** The events that count. Pointer events cover mouse, pen and touch. */
export const ENGAGED_EVENTS = [
  'pointerdown',
  'keydown',
  'wheel',
  'pointermove',
] as const;

/**
 * Pre-hydration inline script that reports a page view as ENGAGED, once, on the visitor's
 * first genuine input — a click or tap, a key, a wheel notch, or pointer travel past
 * `ENGAGED_DRIFT_PX`. It sends a single fire-and-forget, body-less POST to `ENGAGED_PATH`
 * and removes its listeners; the platform's request analytics do the counting, so nothing
 * is read, stored or logged anywhere in the app.
 *
 * An inline script rather than a hook because engagement should count from the first byte:
 * a visitor who moves or scrolls before hydration finishes is the most impatient kind, and a
 * hook would miss them.
 *
 * What deliberately does NOT count:
 * - `scroll` — the back-nav scroll restore fires it programmatically, so it says nothing
 *   about a person (the screensaver's activity list excludes it for the same reason);
 * - anything a script dispatches — only `isTrusted` events register;
 * - the /download live-preview iframes — they are driven by script and stay out of every
 *   telemetry channel, as Analytics and SpeedInsights do via `dropPreviewEvents`. The check
 *   is the same framed-only one as desktop-init.ts: a forged top-level `window.name` is not
 *   a preview.
 */
export const ENGAGEMENT_INIT_SCRIPT = `(() => {
  try {
    if (window.name === '${DESKTOP_PREVIEW_WINDOW_NAME}' && window.self !== window.top) return;
    if (typeof navigator.sendBeacon !== 'function') return;
    var types = ${JSON.stringify(ENGAGED_EVENTS)};
    var anchor = null;
    var sent = false;
    var off = function () {
      for (var i = 0; i < types.length; i++) window.removeEventListener(types[i], on, true);
    };
    var on = function (e) {
      if (sent || !e.isTrusted) return;
      if (e.type === 'pointermove') {
        if (anchor === null) { anchor = [e.clientX, e.clientY]; return; }
        var dx = e.clientX - anchor[0];
        var dy = e.clientY - anchor[1];
        if (dx * dx + dy * dy <= ${ENGAGED_DRIFT_PX * ENGAGED_DRIFT_PX}) return;
      }
      sent = true;
      off();
      navigator.sendBeacon('${ENGAGED_PATH}');
    };
    for (var i = 0; i < types.length; i++) window.addEventListener(types[i], on, { capture: true, passive: true });
  } catch (_e) {}
})();`;
