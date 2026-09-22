import { describe, expect, test } from 'bun:test';

import middleware from './middleware.ts';
import {
  engagedPingPath,
  presentPingPath,
  viewPingPath,
} from '#/lib/device/key';

const DEVICE_KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';

// The edge middleware only runs on Vercel (not in local dev), so it can't be
// curl-verified against web.local. These tests lock its agent-facing behaviour by
// asserting on @vercel/edge's wire format: next() sets `x-middleware-next: 1`, a
// request-header rewrite is encoded as `x-middleware-override-headers` +
// `x-middleware-request-<name>`, and response headers (Link) ride the returned Response.

/** Build a Request for `path` (with optional Accept) and run the middleware. */
function run(path: string, accept?: string): Response {
  const headers = new Headers();
  if (accept !== undefined) headers.set('accept', accept);
  return middleware(
    new Request(`https://sponsorsearch.co.uk${path}`, { headers }),
  );
}

const isNext = (res: Response) => res.headers.get('x-middleware-next') === '1';

/** The Accept value the origin will see if it was rewritten, else null. */
function overriddenAccept(res: Response): string | null {
  const overrides = res.headers.get('x-middleware-override-headers') ?? '';
  return overrides.split(',').includes('accept')
    ? res.headers.get('x-middleware-request-accept')
    : null;
}

describe('edge middleware: agent Accept handling', () => {
  test('homepage with a non-HTML Accept is repaired to also accept HTML', () => {
    const res = run('/', 'text/markdown');
    expect(isNext(res)).toBe(true);
    expect(overriddenAccept(res)).toBe('text/markdown, text/html');
  });

  test('company page with a non-HTML Accept is repaired', () => {
    const res = run('/company/abc/acme-ltd', 'text/markdown');
    expect(isNext(res)).toBe(true);
    expect(overriddenAccept(res)).toBe('text/markdown, text/html');
  });

  test('a browser Accept on a document is passed through unmodified', () => {
    const res = run('/', 'text/html,application/xhtml+xml');
    expect(isNext(res)).toBe(true);
    expect(overriddenAccept(res)).toBeNull();
  });

  test('wildcard Accept (curl default) is not repaired', () => {
    const res = run('/', '*/*');
    expect(isNext(res)).toBe(true);
    expect(overriddenAccept(res)).toBeNull();
  });

  test('missing Accept is not repaired', () => {
    const res = run('/');
    expect(isNext(res)).toBe(true);
    expect(overriddenAccept(res)).toBeNull();
  });

  test('a non-standard Accept with text/html only as a non-leading substring is still repaired', () => {
    // Mirrors the framework's `part.trim().startsWith(...)` check: 'application/x-text/html'
    // is NOT served HTML by the handler, so the guard must still repair it.
    const res = run('/', 'application/x-text/html');
    expect(overriddenAccept(res)).toBe('application/x-text/html, text/html');
  });

  test('every document response advertises llms.txt', () => {
    const link = '</llms.txt>; rel="describedby"';
    expect(run('/', 'text/markdown').headers.get('link')).toBe(link);
    expect(run('/', 'text/html').headers.get('link')).toBe(link);
    expect(run('/privacy', 'text/html').headers.get('link')).toBe(link);
  });
});

describe('edge middleware: routing is preserved', () => {
  test('API / server-function routes pass through without repair or Link header', () => {
    for (const path of [
      '/_server/x',
      '/api/tiles/dark/1/2/3',
      '/api/revalidate',
      '/api/engaged',
      '/.well-known/vercel/flags',
    ]) {
      const res = run(path, 'application/json');
      expect(isNext(res)).toBe(true);
      expect(overriddenAccept(res)).toBeNull();
      expect(res.headers.get('link')).toBeNull();
    }
  });

  test('the engagement ping reaches the function with the wildcard Accept sendBeacon sends', () => {
    // `navigator.sendBeacon` sends `Accept: */*`, which has no `text/html` in it — so without
    // its API prefix the document fallback would answer every ping with an edge 404, and
    // nothing in the app would ever notice: the beacon is fire-and-forget by design.
    const res = run('/api/engaged', '*/*');
    expect(res.status).not.toBe(404);
    expect(isNext(res)).toBe(true);
    expect(overriddenAccept(res)).toBeNull();
  });

  test('a look-alike of the engagement path still takes the edge 404', () => {
    // The endpoint has no sub-paths, so it is matched exactly: a prefix match would send
    // `/api/engaged-anything` to the origin, where Nitro 404s it after spending an invocation.
    for (const path of ['/api/engaged-any', '/api/engagedx', '/api/engaged/']) {
      const res = run(path, '*/*');
      expect(res.status).toBe(404);
      expect(isNext(res)).toBe(false);
    }
  });

  test('device-keyed pings reach the function with the wildcard Accept sendBeacon sends', () => {
    // Built with the client's own path builders, so the middleware is exercised against
    // exactly what the app emits.
    for (const path of [
      presentPingPath(DEVICE_KEY),
      viewPingPath(DEVICE_KEY),
      engagedPingPath(DEVICE_KEY),
    ]) {
      const res = run(path, '*/*');
      expect(res.status).not.toBe(404);
      expect(isNext(res)).toBe(true);
      expect(overriddenAccept(res)).toBeNull();
      expect(res.headers.get('link')).toBeNull();
    }
  });

  test('a malformed device-ping key takes the edge 404', () => {
    for (const path of [
      '/api/v/',
      '/api/v/abc',
      '/api/p/abc',
      `/api/v/${DEVICE_KEY.toUpperCase()}`,
      `/api/e/${DEVICE_KEY}0`,
      `/api/v/${DEVICE_KEY}/x`,
      `/api/x/${DEVICE_KEY}`,
    ]) {
      const res = run(path, '*/*');
      expect(res.status).toBe(404);
      expect(isNext(res)).toBe(false);
    }
  });

  test('/download (page) is a document, but /downloads/* (installer/updater) passes through', () => {
    // The download page gets the agent Link header...
    expect(run('/download', 'text/html').headers.get('link')).toBe(
      '</llms.txt>; rel="describedby"',
    );
    // ...while the sibling binary/updater route is untouched: no Link, no Accept repair.
    const dl = run('/downloads/latest/mac/SponsorSearch.dmg', 'text/markdown');
    expect(isNext(dl)).toBe(true);
    expect(dl.headers.get('link')).toBeNull();
    expect(overriddenAccept(dl)).toBeNull();
  });

  test('/filters (page) is served as a document', () => {
    expect(run('/filters', 'text/html').headers.get('link')).toBe(
      '</llms.txt>; rel="describedby"',
    );
    const res = run('/filters', 'text/markdown');
    expect(overriddenAccept(res)).toBe('text/markdown, text/html');
  });

  test('static assets pass through', () => {
    expect(isNext(run('/favicon.ico'))).toBe(true);
    expect(isNext(run('/llms.txt'))).toBe(true);
    expect(isNext(run('/sitemap.xml'))).toBe(true);
  });

  test('unknown path with a browser Accept reaches the app 404 page', () => {
    expect(isNext(run('/does-not-exist', 'text/html'))).toBe(true);
  });

  test('unknown path with a non-HTML Accept is blocked at the edge (404)', () => {
    const res = run('/does-not-exist', 'text/markdown');
    expect(res.status).toBe(404);
    expect(isNext(res)).toBe(false);
  });
});
