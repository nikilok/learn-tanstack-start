import { describe, expect, test } from 'bun:test';

import middleware from './middleware.ts';

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
      '/.well-known/vercel/flags',
    ]) {
      const res = run(path, 'application/json');
      expect(isNext(res)).toBe(true);
      expect(overriddenAccept(res)).toBeNull();
      expect(res.headers.get('link')).toBeNull();
    }
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
