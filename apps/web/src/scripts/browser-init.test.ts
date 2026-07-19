import { describe, expect, test } from 'bun:test';

import { BROWSER_INIT_SCRIPT } from './browser-init';

// Locks the load-bearing decision from the "non-Chromium view-transition snapshot" saga
// (see the reference in browser-init.ts + the memory it points to): WebKit AND Gecko can't
// render backdrop-filter inside a view-transition snapshot, so the frosted header renders
// bare mid-morph. The script therefore MUST neutralise `document.startViewTransition` on
// every non-Blink engine (safari/firefox/unknown) and leave it untouched on chrome/edge.
// Re-enabling the morph on Safari/Firefox — the exact regression this whole saga was — turns
// these red. The script is a pre-hydration string, so we execute it against a mocked
// document/navigator (bun test has no DOM) via `new Function`, whose params shadow the
// globals the IIFE reads — no global mutation, highest fidelity (the real string runs).

const UA = {
  chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefox:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:129.0) Gecko/20100101 Firefox/129.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  safariIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/129.0 Mobile/15E148 Safari/605.1.15',
  unknown: 'CustomAgent/1.0',
} as const;

type ShimTransition = {
  finished: Promise<unknown>;
  ready: Promise<unknown>;
  updateCallbackDone: Promise<unknown>;
  skipTransition: () => void;
};
type StartViewTransition = (
  arg: (() => unknown) | { update: () => unknown },
) => ShimTransition;

// Run the actual init-script string against a fresh mocked document + navigator.
function runInit(ua: string, withStartViewTransition = true) {
  const attrs: Record<string, string> = {};
  const nativeSvt = function native() {};
  const doc: Record<string, unknown> = {
    documentElement: {
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
    },
  };
  if (withStartViewTransition) doc.startViewTransition = nativeSvt;
  const run = new Function('navigator', 'document', BROWSER_INIT_SCRIPT) as (
    navigator: { userAgent: string },
    document: unknown,
  ) => void;
  run({ userAgent: ua }, doc);
  return {
    browser: attrs['data-browser'],
    svt: doc.startViewTransition,
    nativeSvt,
  };
}

describe('BROWSER_INIT_SCRIPT — engine detection', () => {
  test('buckets each engine by UA (Chromium tokens checked in the right order)', () => {
    expect(runInit(UA.chrome).browser).toBe('chrome');
    expect(runInit(UA.edge).browser).toBe('edge');
    expect(runInit(UA.firefox).browser).toBe('firefox');
    expect(runInit(UA.safariMac).browser).toBe('safari');
    expect(runInit(UA.unknown).browser).toBe('unknown');
  });

  test('every iOS browser buckets as safari (all WebKit under the hood)', () => {
    expect(runInit(UA.safariIOS).browser).toBe('safari');
    expect(runInit(UA.chromeIOS).browser).toBe('safari'); // CriOS
    expect(runInit(UA.firefoxIOS).browser).toBe('safari'); // FxiOS
  });
});

describe('BROWSER_INIT_SCRIPT — view-transition kill (non-Chromium)', () => {
  test('Blink (chrome/edge) KEEPS startViewTransition — the morph runs', () => {
    const c = runInit(UA.chrome);
    expect(c.svt).toBe(c.nativeSvt);
    const e = runInit(UA.edge);
    expect(e.svt).toBe(e.nativeSvt);
  });

  test('WebKit + Gecko + unknown REPLACE startViewTransition — the morph is killed', () => {
    for (const ua of [
      UA.firefox,
      UA.safariMac,
      UA.safariIOS,
      UA.chromeIOS,
      UA.firefoxIOS,
      UA.unknown,
    ]) {
      const r = runInit(ua);
      expect(r.svt).not.toBe(r.nativeSvt);
      expect(typeof r.svt).toBe('function');
    }
  });

  test('no-op when startViewTransition is absent (older engines) — no crash, still stamps', () => {
    const r = runInit(UA.safariMac, false);
    expect(r.svt).toBeUndefined();
    expect(r.browser).toBe('safari');
  });
});

describe('BROWSER_INIT_SCRIPT — the shim contract', () => {
  test('runs the update callback (function form) and resolves a no-op transition', async () => {
    const svt = runInit(UA.safariMac).svt as StartViewTransition;
    let ran = false;
    const t = svt(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(typeof t.skipTransition).toBe('function');
    await expect(t.finished).resolves.toBeUndefined();
    await expect(t.ready).resolves.toBeUndefined();
    await expect(t.updateCallbackDone).resolves.toBeUndefined();
  });

  test('runs the object form ({ update }) too', () => {
    const svt = runInit(UA.firefox).svt as StartViewTransition;
    let ran = false;
    svt({
      update: () => {
        ran = true;
      },
    });
    expect(ran).toBe(true);
  });

  test('swallows a throwing update callback (never rejects the navigation)', () => {
    const svt = runInit(UA.safariMac).svt as StartViewTransition;
    expect(() =>
      svt(() => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });
});
