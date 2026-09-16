import { describe, expect, test } from 'bun:test';

import { DESKTOP_PREVIEW_WINDOW_NAME } from '../utils/desktop-preview';
import {
  ENGAGED_DRIFT_PX,
  ENGAGED_EVENTS,
  ENGAGED_PATH,
  ENGAGEMENT_INIT_SCRIPT,
} from './engagement-init';

// The script is a pre-hydration string, so — like browser-init.test.ts — it runs against
// mocked globals via `new Function`, whose parameters shadow the `window` and `navigator`
// the IIFE reads. The mock window records what was listened for; the handler is then driven
// by hand with fake events, which is the only way to say precisely which input counts.

type Listener = (e: FakeEvent) => void;
type FakeEvent = {
  type: string;
  isTrusted: boolean;
  clientX?: number;
  clientY?: number;
};

function boot(
  opts: { preview?: boolean; forgedName?: boolean; beacon?: boolean } = {},
) {
  const listeners = new Map<string, { fn: Listener; options: unknown }>();
  const removed: string[] = [];
  const beacons: string[] = [];
  const self = {};
  const win = {
    name: opts.preview || opts.forgedName ? DESKTOP_PREVIEW_WINDOW_NAME : '',
    self,
    // A preview iframe is framed; a forged name on a top-level tab is not.
    top: opts.preview ? {} : self,
    addEventListener(type: string, fn: Listener, options: unknown) {
      listeners.set(type, { fn, options });
    },
    removeEventListener(type: string, _fn: Listener, _cap: unknown) {
      removed.push(type);
      listeners.delete(type);
    },
  };
  const nav: { sendBeacon?: (url: string) => boolean } =
    opts.beacon === false
      ? {}
      : {
          sendBeacon(url: string) {
            beacons.push(url);
            return true;
          },
        };
  const run = new Function('window', 'navigator', ENGAGEMENT_INIT_SCRIPT) as (
    w: unknown,
    n: unknown,
  ) => void;
  run(win, nav);
  const fire = (e: FakeEvent) => listeners.get(e.type)?.fn(e);
  return { listeners, removed, beacons, fire };
}

const trusted = (type: string, x = 0, y = 0): FakeEvent => ({
  type,
  isTrusted: true,
  clientX: x,
  clientY: y,
});

describe('ENGAGEMENT_INIT_SCRIPT', () => {
  test('listens for exactly the engagement events, in capture and passive, and never scroll', () => {
    const { listeners } = boot();
    expect([...listeners.keys()].sort()).toEqual([...ENGAGED_EVENTS].sort());
    for (const { options } of listeners.values())
      expect(options).toEqual({ capture: true, passive: true });
    // Programmatic scroll restores fire `scroll`; it must never be a way in.
    expect(listeners.has('scroll')).toBe(false);
  });

  test('a trusted click sends one ping to the engaged path and removes every listener', () => {
    const { beacons, removed, fire, listeners } = boot();
    fire(trusted('pointerdown'));
    expect(beacons).toEqual([ENGAGED_PATH]);
    expect(removed.sort()).toEqual([...ENGAGED_EVENTS].sort());
    expect(listeners.size).toBe(0);
  });

  test('a key or a wheel notch counts too', () => {
    for (const type of ['keydown', 'wheel']) {
      const { beacons, fire } = boot();
      fire(trusted(type));
      expect(beacons).toEqual([ENGAGED_PATH]);
    }
  });

  test('script-dispatched events do not count', () => {
    const { beacons, listeners, fire } = boot();
    fire({ type: 'pointerdown', isTrusted: false });
    fire({ type: 'keydown', isTrusted: false });
    expect(beacons).toEqual([]);
    expect(listeners.size).toBe(ENGAGED_EVENTS.length);
  });

  test('pointer movement counts only past the drift threshold, measured from the first position', () => {
    const { beacons, fire } = boot();
    // The browser's hover-recompute move: same coordinates as where the cursor rested.
    fire(trusted('pointermove', 100, 100));
    fire(trusted('pointermove', 100, 100));
    expect(beacons).toEqual([]);
    // Sensor jitter under a resting hand.
    fire(trusted('pointermove', 100 + ENGAGED_DRIFT_PX - 1, 100));
    expect(beacons).toEqual([]);
    // Real travel.
    fire(trusted('pointermove', 100 + ENGAGED_DRIFT_PX, 100));
    expect(beacons).toEqual([ENGAGED_PATH]);
  });

  test('it pings once per page view, whatever comes after', () => {
    const { beacons, fire } = boot();
    fire(trusted('pointerdown'));
    fire(trusted('pointerdown'));
    fire(trusted('keydown'));
    expect(beacons).toEqual([ENGAGED_PATH]);
  });

  test('the /download preview iframe registers nothing — it is driven by script, not a visitor', () => {
    const { listeners, beacons } = boot({ preview: true });
    expect(listeners.size).toBe(0);
    expect(beacons).toEqual([]);
  });

  test('a forged preview name on a top-level tab is not a preview', () => {
    const { listeners } = boot({ forgedName: true });
    expect(listeners.size).toBe(ENGAGED_EVENTS.length);
  });

  test('without sendBeacon it registers nothing and throws nothing', () => {
    const { listeners, beacons } = boot({ beacon: false });
    expect(listeners.size).toBe(0);
    expect(beacons).toEqual([]);
  });

  test('a throwing window is swallowed, like every other init script', () => {
    const run = new Function('window', 'navigator', ENGAGEMENT_INIT_SCRIPT) as (
      w: unknown,
      n: unknown,
    ) => void;
    expect(() =>
      run(
        {
          name: '',
          addEventListener() {
            throw new Error('no');
          },
        },
        { sendBeacon() {} },
      ),
    ).not.toThrow();
  });
});
