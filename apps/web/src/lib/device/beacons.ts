import {
  ENGAGED_FLAG,
  ENGAGED_HOOK,
} from '../../scripts/engagement-init';
import { isDesktopPreview } from '../../utils/desktop-preview';
import { createPinger } from './key';

type EngagedWindow = Window & {
  [ENGAGED_FLAG]?: 1;
  [ENGAGED_HOOK]?: () => void;
};

/** Fire-and-forget, like the engagement ping: no response is ever read. */
const send = (path: string) => {
  try {
    navigator.sendBeacon(path);
  } catch {
    // A ping that cannot be sent is simply absent.
  }
};

const pinger = createPinger(send);
let booted = false;

/** Notes one company page view. Safe to call before boot: views queue until the key resolves, and stay unsent where boot never runs. */
export function noteCompanyView(): void {
  pinger.view();
}

/** Boots the device-keyed pings once per document, from a root effect; the key computation is deferred to idle so hydration never waits on it. The /download preview iframes stay out, as with every telemetry channel. */
export function initDeviceBeacons(): void {
  if (booted) return;
  booted = true;
  if (typeof window === 'undefined') return;
  if (isDesktopPreview()) return;
  if (typeof navigator.sendBeacon !== 'function') return;

  const w = window as EngagedWindow;
  if (w[ENGAGED_FLAG]) pinger.engage();
  else w[ENGAGED_HOOK] = () => pinger.engage();
  // One presence ping per document, gated only on the key.
  pinger.present();

  const start = () => {
    import('./setup')
      .then(({ computeDeviceKey }) => computeDeviceKey())
      .then(
        (key) => {
          if (key !== null) pinger.ready(key);
        },
        () => {
          // A failed import sends nothing, like a failed computation.
        },
      );
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(start, { timeout: 4000 });
  } else {
    // Safari has no requestIdleCallback; a beat after hydration is enough.
    setTimeout(start, 1500);
  }
}
