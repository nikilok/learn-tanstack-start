import { DESKTOP_PREVIEW_WINDOW_NAME } from '../utils/desktop-preview';

/** Where the ping goes. Paired with the Nitro route file `server/api/engaged.post.ts` — the test locks the two spellings together. */
export const ENGAGED_PATH = '/api/engaged';

/** Pointer travel below this many pixels does not count as movement (see the tests). */
export const ENGAGED_DRIFT_PX = 6;

/** The events that count. Pointer events cover mouse, pen and touch. */
export const ENGAGED_EVENTS = [
  'pointerdown',
  'keydown',
  'wheel',
  'pointermove',
] as const;

/** Page-global flag set once the ping has fired. */
export const ENGAGED_FLAG = '__ssEngaged';

/** Page-global callback slot for a module that loads later (lib/device/beacons.ts). */
export const ENGAGED_HOOK = '__ssOnEngaged';

/**
 * Pre-hydration inline script: one fire-and-forget, body-less POST to `ENGAGED_PATH` per
 * document on the visitor's first input, after which it removes its listeners, stamps
 * `ENGAGED_FLAG` and calls `ENGAGED_HOOK` if one is registered. Inline so it counts from the
 * first byte; nothing is read, stored or logged in the app. The /download preview iframes
 * stay out, as with every telemetry channel. The tests are the definition of what counts.
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
      window.${ENGAGED_FLAG} = 1;
      var h = window.${ENGAGED_HOOK};
      if (typeof h === 'function') h();
    };
    for (var i = 0; i < types.length; i++) window.addEventListener(types[i], on, { capture: true, passive: true });
  } catch (_e) {}
})();`;
