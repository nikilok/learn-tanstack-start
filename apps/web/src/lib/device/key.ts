// Pure half of the device-key pings; beacons.ts owns the DOM wiring.

/** Shape of a well-formed device key. Locked to the Nitro handlers by devicePing.test.ts. */
export const DEVICE_KEY_RE = /^[0-9a-f]{32}$/;

/** Ping path answered by server/api/p/[hash].post.ts. */
export function presentPingPath(key: string): string {
  return `/api/p/${key}`;
}

/** Ping path answered by server/api/v/[hash].post.ts. */
export function viewPingPath(key: string): string {
  return `/api/v/${key}`;
}

/** Ping path answered by server/api/e/[hash].post.ts. */
export function engagedPingPath(key: string): string {
  return `/api/e/${key}`;
}

type SendPing = (path: string) => void;

/** Queues pings until `ready` delivers a well-formed key, then sends straight through; presence and engaged fire at most once, a second `ready` is ignored, and with no key nothing is sent. */
export function createPinger(send: SendPing) {
  let key: string | null = null;
  let present = false;
  let presentSent = false;
  let pendingViews = 0;
  let engaged = false;
  let engagedSent = false;

  const flush = () => {
    if (key === null) return;
    if (present && !presentSent) {
      presentSent = true;
      send(presentPingPath(key));
    }
    for (; pendingViews > 0; pendingViews--) send(viewPingPath(key));
    if (engaged && !engagedSent) {
      engagedSent = true;
      send(engagedPingPath(key));
    }
  };

  return {
    present() {
      present = true;
      flush();
    },
    view() {
      pendingViews++;
      flush();
    },
    engage() {
      engaged = true;
      flush();
    },
    ready(candidate: string) {
      if (key !== null || !DEVICE_KEY_RE.test(candidate)) return;
      key = candidate;
      flush();
    },
  };
}
