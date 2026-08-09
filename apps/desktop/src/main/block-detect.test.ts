import { describe, expect, test } from 'bun:test';

import {
  isEdgeDenied,
  isMissingApp,
  isServerError,
  probeDelayMs,
  probeStillDenied,
  simulatedReason,
} from './block-detect.ts';

const facts = (over: Partial<Parameters<typeof isEdgeDenied>[0]> = {}) => ({
  statusCode: 200,
  resourceType: 'xhr',
  ...over,
});

describe('isServerError', () => {
  /** A 5xx error page: a document with a body, which is what every real one is. */
  const errorPage = (statusCode: number, contentType = 'text/html') =>
    facts({
      statusCode,
      resourceType: 'mainFrame',
      responseHeaders: { 'content-type': [contentType] },
    });

  test('a 5xx error page is one, which is the case nothing else catches', () => {
    // The real one this pins: portless up with the dev server behind it gone answers 502
    // text/html (measured), and production has the same shape in the platform's own error
    // pages. Either is a complete, successful load — no failure event anywhere — so
    // without this the window is handed someone else's error page with no way off it.
    for (const statusCode of [500, 502, 503, 504]) {
      expect(isServerError(errorPage(statusCode))).toBe(true);
    }
  });

  test('the content type is matched past its charset, and case-insensitively', () => {
    expect(isServerError(errorPage(502, 'text/html; charset=utf-8'))).toBe(
      true,
    );
    expect(isServerError(errorPage(502, 'Text/HTML'))).toBe(true);
    expect(
      isServerError(
        facts({
          statusCode: 502,
          resourceType: 'mainFrame',
          responseHeaders: { 'Content-Type': ['text/html'] },
        }),
      ),
    ).toBe(true);
  });

  test('a bodiless 5xx is not a site that is down', () => {
    // The real one this pins: the app's own file routes answer a missing env var with
    // `new Response(null, { status: 500 })` — no content type at all. An installer link
    // landing on one is a failed download, and covering the window would take a working
    // app away over it.
    expect(
      isServerError(facts({ statusCode: 500, resourceType: 'mainFrame' })),
    ).toBe(false);
    expect(isServerError(errorPage(500, 'application/json'))).toBe(false);
    expect(isServerError(errorPage(502, 'application/octet-stream'))).toBe(
      false,
    );
  });

  test('a served page is not', () => {
    for (const statusCode of [200, 204, 301, 404, 403, 499]) {
      expect(isServerError(errorPage(statusCode))).toBe(false);
    }
  });

  test('a failing subresource is the page‘s problem, not the window‘s', () => {
    // One RPC returning 500 is for the app to report; covering the whole window over it
    // would take a working page away from someone over a single failed request.
    for (const resourceType of ['xhr', 'script', 'image', 'stylesheet']) {
      expect(
        isServerError(
          facts({
            statusCode: 503,
            resourceType,
            responseHeaders: { 'content-type': ['text/html'] },
          }),
        ),
      ).toBe(false);
    }
  });
});

describe('isMissingApp', () => {
  const page = (statusCode: number, contentType = 'text/html') =>
    facts({
      statusCode,
      resourceType: 'mainFrame',
      responseHeaders: { 'content-type': [contentType] },
    });

  test('a 404 before the app has served anything is not the app', () => {
    // The real one this pins: the dev proxy with nothing behind it answers 404 to every
    // request including the first, and a 404 with a body is a successful load — no failure
    // event fires anywhere, so without this the window is handed the proxy's own page.
    expect(isMissingApp(page(404), false)).toBe(true);
  });

  test('once the app has served a document, a 404 is its own page', () => {
    // A company slug that no longer exists renders the app's not-found, with working
    // navigation. Covering that would take a usable page away — and, because the check
    // would clear against a healthy root and then reload straight back into the same 404,
    // it would flip between the two forever.
    expect(isMissingApp(page(404), true)).toBe(false);
  });

  test('only documents, and only ones carrying a page', () => {
    expect(
      isMissingApp(facts({ statusCode: 404, resourceType: 'xhr' }), false),
    ).toBe(false);
    expect(isMissingApp(page(404, 'application/json'), false)).toBe(false);
    expect(
      isMissingApp(
        facts({ statusCode: 404, resourceType: 'mainFrame' }),
        false,
      ),
    ).toBe(false);
  });

  test("anything that is not a 404 is somebody else's problem", () => {
    for (const statusCode of [200, 301, 403, 500, 502]) {
      expect(isMissingApp(page(statusCode), false)).toBe(false);
    }
  });
});

describe('isEdgeDenied', () => {
  test('a refused sub-resource counts, not just a document', () => {
    expect(
      isEdgeDenied(
        facts({
          statusCode: 403,
          responseHeaders: { 'x-vercel-mitigated': ['deny'] },
        }),
      ),
    ).toBe(true);
  });

  test('the marker header is read case-insensitively', () => {
    expect(
      isEdgeDenied(
        facts({
          statusCode: 403,
          responseHeaders: { 'X-Vercel-Mitigated': ['Deny'] },
        }),
      ),
    ).toBe(true);
  });

  test('a challenge is not a refusal — the view can solve it', () => {
    // Covering it would replace the only path back with a screen that never clears.
    expect(
      isEdgeDenied(
        facts({
          statusCode: 403,
          resourceType: 'mainFrame',
          responseHeaders: { 'x-vercel-mitigated': ['challenge'] },
        }),
      ),
    ).toBe(false);
  });

  test('a refused document counts without the marker', () => {
    expect(
      isEdgeDenied(facts({ statusCode: 403, resourceType: 'mainFrame' })),
    ).toBe(true);
  });

  test('an unmarked sub-resource refusal does not count', () => {
    // The tile proxy passes an upstream refusal straight through, and that is not ours.
    expect(
      isEdgeDenied(facts({ statusCode: 403, resourceType: 'image' })),
    ).toBe(false);
  });

  test('every other status is untouched', () => {
    for (const statusCode of [200, 304, 404, 429, 500, 502]) {
      expect(
        isEdgeDenied(facts({ statusCode, resourceType: 'mainFrame' })),
      ).toBe(false);
    }
  });

  test('a challenge is left alone whatever status it arrives on', () => {
    expect(
      isEdgeDenied(
        facts({
          statusCode: 429,
          resourceType: 'mainFrame',
          responseHeaders: { 'x-vercel-mitigated': ['challenge'] },
        }),
      ),
    ).toBe(false);
  });
});

describe('probeStillDenied', () => {
  test('a refusal reads as still refused', () => {
    expect(probeStillDenied(403, 'deny')).toBe(true);
    expect(probeStillDenied(403, null)).toBe(true);
  });

  test('a challenge counts as clear — the page can take it from here', () => {
    expect(probeStillDenied(429, 'challenge')).toBe(false);
    expect(probeStillDenied(403, 'challenge')).toBe(false);
  });

  test('anything else is clear, errors included', () => {
    // An error means the request reached something, which is all this is asking.
    expect(probeStillDenied(200, null)).toBe(false);
    expect(probeStillDenied(500, null)).toBe(false);
  });
});

describe('simulatedReason', () => {
  test('no flags means no simulation', () => {
    expect(simulatedReason({})).toBe(null);
    expect(simulatedReason({ PATH: '/usr/bin' })).toBe(null);
  });

  test('each flag asks for its own state', () => {
    expect(simulatedReason({ DESKTOP_SIMULATE_RATE_LIMIT: '1' })).toBe(
      'blocked',
    );
    expect(simulatedReason({ DESKTOP_SIMULATE_OFFLINE: '1' })).toBe('offline');
    expect(simulatedReason({ DESKTOP_SIMULATE_UNREACHABLE: '1' })).toBe(
      'unreachable',
    );
  });

  test('any truthy value turns one on', () => {
    expect(simulatedReason({ DESKTOP_SIMULATE_OFFLINE: 'yes' })).toBe(
      'offline',
    );
    expect(simulatedReason({ DESKTOP_SIMULATE_OFFLINE: 'true' })).toBe(
      'offline',
    );
  });

  test('off values read as off, so a stale export does not hold the screen up', () => {
    for (const value of ['', '0', 'false']) {
      expect(simulatedReason({ DESKTOP_SIMULATE_OFFLINE: value })).toBe(null);
    }
  });

  test('two at once resolves to one, not to whichever the environment ordered first', () => {
    expect(
      simulatedReason({
        DESKTOP_SIMULATE_OFFLINE: '1',
        DESKTOP_SIMULATE_RATE_LIMIT: '1',
      }),
    ).toBe('blocked');
  });
});

describe('probeDelayMs', () => {
  test('a dropped connection is checked sooner than the other states', () => {
    expect(probeDelayMs('offline', 0)).toBeLessThan(probeDelayMs('blocked', 0));
  });

  test('delays grow with each failed attempt', () => {
    const steps = [0, 1, 2, 3].map((n) => probeDelayMs('blocked', n));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size).toBe(steps.length);
  });

  test('holds at the last step instead of growing without bound', () => {
    const last = probeDelayMs('offline', 4);
    expect(probeDelayMs('offline', 99)).toBe(last);
    expect(probeDelayMs('offline', 1e6)).toBe(last);
  });

  test('a nonsense attempt falls back to the first step', () => {
    const first = probeDelayMs('blocked', 0);
    expect(probeDelayMs('blocked', -3)).toBe(first);
    expect(probeDelayMs('blocked', Number.NaN)).toBe(first);
  });
});
