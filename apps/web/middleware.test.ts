import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';

import { encryptFlagValues } from 'flags';

import { BROWSER_CHECK_PATH } from '#/lib/device/browser-check-config';
import {
  engagedPingPath,
  presentPingPath,
  viewPingPath,
} from '#/lib/device/key';
import { SESSION_CALL_PATH } from '#/lib/session/calls';
import { issueSession } from '#/lib/session/token';

import middleware from './middleware.ts';

const DEVICE_KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';

// The edge middleware only runs on Vercel (not in local dev), so it can't be
// curl-verified against web.local. These tests lock its agent-facing behaviour by
// asserting on @vercel/edge's wire format: next() sets `x-middleware-next: 1`, a
// request-header rewrite is encoded as `x-middleware-override-headers` +
// `x-middleware-request-<name>`, and response headers (Link) ride the returned Response.

/** Build a Request for `path` (with optional Accept) and run the middleware, which answers these paths at once. */
function run(path: string, accept?: string): Response {
  const headers = new Headers();
  if (accept !== undefined) headers.set('accept', accept);
  const res = middleware(
    new Request(`https://sponsorsearch.co.uk${path}`, { headers }),
  );
  if (res instanceof Promise)
    throw new Error(`${path} was not answered at once`);
  return res;
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

  test("the browser check's challenge and every call it makes pass through to the proxy", () => {
    // The challenge's own calls carry no file extension and no HTML Accept: answered by the
    // edge 404, they never reached Vercel, the challenge never completed, and every visitor
    // was judged automated.
    for (const [path, accept] of [
      [`${BROWSER_CHECK_PATH}/a-4-a/c.js?v=3&h=sponsorsearch.co.uk`, '*/*'],
      [`${BROWSER_CHECK_PATH}/tl`, '*/*'],
      [`${BROWSER_CHECK_PATH}/fp?x-kpsdk-v=j-1.0.0`, 'application/json'],
      [`${BROWSER_CHECK_PATH}/mfc`, undefined],
    ] as const) {
      const res = run(path, accept);
      expect(res.status).not.toBe(404);
      expect(isNext(res)).toBe(true);
      expect(overriddenAccept(res)).toBeNull();
      expect(res.headers.get('link')).toBeNull();
    }
  });

  test('a path that only begins like the browser check still takes the edge 404', () => {
    const res = run(`${BROWSER_CHECK_PATH}-x/tl`, '*/*');
    expect(res.status).toBe(404);
    expect(isNext(res)).toBe(false);
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

describe('edge middleware: company pages, and their data calls by session', () => {
  const SECRET = 'test-secret-not-a-real-one';
  /** A 32-byte key, base64url, as FLAGS_SECRET holds one. */
  const flagsSecret = () =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
      'base64url',
    );
  const FLAGS_SECRET = flagsSecret();
  const VISITOR = '81.2.69.160';
  const CRAWLER = '66.249.64.10';
  const ENV = [
    'DOCUMENT_MODE',
    'ENGAGE_TOKEN_SECRET',
    'FLAGS_SECRET',
    'CRAWLER_RANGES_LOCAL',
    'GLOBAL_CONFIG',
    'EDGE_CONFIG',
  ] as const;
  const saved = Object.fromEntries(
    ENV.map((name) => [name, process.env[name]]),
  );
  let logged: ReturnType<typeof spyOn>;

  beforeAll(() => {
    // No store is connected in a test, so the edge reads the local list.
    delete process.env.GLOBAL_CONFIG;
    delete process.env.EDGE_CONFIG;
    process.env.ENGAGE_TOKEN_SECRET = SECRET;
    process.env.FLAGS_SECRET = FLAGS_SECRET;
    process.env.CRAWLER_RANGES_LOCAL = '66.249.64.0/27';
  });
  afterAll(() => {
    for (const name of ENV)
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  });
  beforeEach(() => {
    logged = spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => logged.mockRestore());

  /** One request through the middleware, under the given mode, from the given address and session. */
  async function visit(
    path: string,
    options: {
      mode?: 'observe' | 'enforce';
      ip?: string;
      session?: string;
      owner?: string;
      accept?: string;
      method?: 'GET' | 'POST';
    } = {},
  ): Promise<Response> {
    if (options.mode) process.env.DOCUMENT_MODE = options.mode;
    else delete process.env.DOCUMENT_MODE;
    const headers = new Headers({
      accept: options.accept ?? 'text/html',
      'x-real-ip': options.ip ?? VISITOR,
    });
    const cookies = [
      options.session && `ss-session=${options.session}`,
      options.owner && `ss-owner=${options.owner}`,
    ].filter(Boolean);
    if (cookies.length) headers.set('cookie', cookies.join('; '));
    const method = options.method ?? 'GET';
    return middleware(
      new Request(`https://sponsorsearch.co.uk${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
    );
  }

  /** A valid session value for `scope`. */
  const session = async (scope = VISITOR) =>
    (await issueSession({ scope, standing: 'person', secret: SECRET })).value;
  /** The owner cookie, sealed as `owner.server.ts` seals it, with `key`. */
  const owner = (key = FLAGS_SECRET) =>
    encryptFlagValues({ 'ss-owner': true }, key);
  /** Where the middleware rewrote a request to, or null. */
  const rewrittenTo = (res: Response) =>
    res.headers.get('x-middleware-rewrite');
  /** The test company's page URL with `query`. */
  const shell = (query: string) =>
    `https://sponsorsearch.co.uk/company/acme-ltd?${query}`;

  test('off: a company page is served as it always was', async () => {
    const res = await visit('/company/acme-ltd');
    expect(isNext(res)).toBe(true);
    expect(rewrittenTo(res)).toBeNull();
    expect(logged).not.toHaveBeenCalled();
  });

  test('off: a shell mark asked for directly is dropped', async () => {
    const res = await visit('/company/acme-ltd?render=client&search=acme');
    expect(rewrittenTo(res)).toBe(
      'https://sponsorsearch.co.uk/company/acme-ltd?search=acme',
    );
  });

  test('enforce: a visitor gets the shell, rendered from its own URL', async () => {
    const res = await visit('/company/acme-ltd', { mode: 'enforce' });
    expect(rewrittenTo(res)).toBe(shell('render=client'));
    expect(res.headers.get('link')).toBe('</llms.txt>; rel="describedby"');
    expect(String(logged.mock.calls[0]?.[0])).toBe(
      '[document] client (visitor)',
    );
  });

  test('enforce: the shell keeps the search term and leaves every other parameter off', async () => {
    const res = await visit('/company/acme-ltd?utm_source=x&search=acme', {
      mode: 'enforce',
    });
    expect(rewrittenTo(res)).toBe(shell('search=acme&render=client'));
  });

  test('enforce: a non-HTML Accept is still repaired on the shell', async () => {
    const res = await visit('/company/acme-ltd', {
      mode: 'enforce',
      accept: 'text/markdown',
    });
    expect(rewrittenTo(res)).toBe(shell('render=client'));
    expect(overriddenAccept(res)).toBe('text/markdown, text/html');
  });

  test('enforce: a session, held for this address or another, still gets the shell', async () => {
    for (const scope of [VISITOR, '81.2.69.161']) {
      const res = await visit('/company/acme-ltd', {
        mode: 'enforce',
        session: await session(scope),
      });
      expect(rewrittenTo(res)).toBe(shell('render=client'));
    }
    const asked = await visit('/company/acme-ltd?render=client', {
      mode: 'enforce',
      session: await session(),
    });
    expect(rewrittenTo(asked)).toBe(shell('render=client'));
  });

  test('enforce: a crawler address gets the full document without a session', async () => {
    const res = await visit('/company/acme-ltd', {
      mode: 'enforce',
      ip: CRAWLER,
    });
    expect(isNext(res)).toBe(true);
    expect(rewrittenTo(res)).toBeNull();
    expect(String(logged.mock.calls[0]?.[0])).toBe(
      '[document] server (crawler)',
    );
  });

  test('enforce: the owner gets the full document, and its data calls need no session', async () => {
    const page = await visit('/company/acme-ltd', {
      mode: 'enforce',
      owner: await owner(),
    });
    expect(isNext(page)).toBe(true);
    expect(rewrittenTo(page)).toBeNull();
    const call = await visit(`${SESSION_CALL_PATH}abc`, {
      mode: 'enforce',
      method: 'POST',
      owner: await owner(),
    });
    expect(isNext(call)).toBe(true);
    expect(logged.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      '[document] server (owner)',
    ]);
  });

  test('enforce: an owner cookie sealed with another key gets the shell, and its call is refused', async () => {
    const forged = await owner(flagsSecret());
    const page = await visit('/company/acme-ltd', {
      mode: 'enforce',
      owner: forged,
    });
    expect(rewrittenTo(page)).toBe(shell('render=client'));
    const call = await visit(`${SESSION_CALL_PATH}abc`, {
      mode: 'enforce',
      method: 'POST',
      owner: forged,
    });
    expect(call.status).toBe(403);
  });

  test('enforce: a crawler asking for the shell URL gets the full document', async () => {
    const res = await visit('/company/acme-ltd?render=client', {
      mode: 'enforce',
      ip: CRAWLER,
    });
    expect(rewrittenTo(res)).toBe(
      'https://sponsorsearch.co.uk/company/acme-ltd',
    );
  });

  test('observe: the decision is logged and everyone gets the full document', async () => {
    const res = await visit('/company/acme-ltd', { mode: 'observe' });
    expect(isNext(res)).toBe(true);
    expect(String(logged.mock.calls[0]?.[0])).toBe(
      '[document] client (visitor)',
    );
  });

  test('the legacy two-segment page and the trailing-slash form are not decided', async () => {
    for (const path of ['/company/abc/acme-ltd', '/company/acme-ltd/']) {
      const res = await visit(path, { mode: 'enforce' });
      expect(isNext(res)).toBe(true);
      expect(rewrittenTo(res)).toBeNull();
    }
  });

  test('enforce: a company data call without a session is refused, and never cached', async () => {
    const res = await visit(`${SESSION_CALL_PATH}abc?payload=x`, {
      mode: 'enforce',
      accept: 'application/json',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-session')).toBe('required');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  test('enforce: a POST data call without a session is refused too, and with one passes', async () => {
    const refused = await visit(`${SESSION_CALL_PATH}abc`, {
      mode: 'enforce',
      method: 'POST',
      accept: 'application/json',
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('x-session')).toBe('required');
    const passed = await visit(`${SESSION_CALL_PATH}abc`, {
      mode: 'enforce',
      method: 'POST',
      session: await session(),
    });
    expect(isNext(passed)).toBe(true);
  });

  test('enforce: a company data call with a session, or from a crawler, passes', async () => {
    const withSession = await visit(`${SESSION_CALL_PATH}abc`, {
      mode: 'enforce',
      session: await session(),
    });
    const fromCrawler = await visit(`${SESSION_CALL_PATH}abc`, {
      mode: 'enforce',
      ip: CRAWLER,
    });
    expect(isNext(withSession)).toBe(true);
    expect(isNext(fromCrawler)).toBe(true);
  });

  test('observe: every company data call decision is logged, and none is refused', async () => {
    const without = await visit(`${SESSION_CALL_PATH}abc`, { mode: 'observe' });
    const withSession = await visit(`${SESSION_CALL_PATH}abc`, {
      mode: 'observe',
      session: await session(),
    });
    expect(isNext(without)).toBe(true);
    expect(isNext(withSession)).toBe(true);
    expect(logged.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
      '[call] client (no session)',
      '[call] server (session)',
    ]);
  });

  test('every other server function, and the session endpoint, pass through untouched', async () => {
    for (const path of ['/_serverFn/0123abcd', '/api/session']) {
      const res = await visit(path, {
        mode: 'enforce',
        accept: 'application/json',
      });
      expect(isNext(res)).toBe(true);
    }
  });

  test('any other spelling the router resolves to a company page is redirected to its own', async () => {
    for (const [path, to] of [
      ['/COMPANY/acme-ltd', '/company/acme-ltd'],
      ['/Company/Acme-Ltd?search=acme', '/company/acme-ltd?search=acme'],
      ['/%63ompany/acme-ltd', '/company/acme-ltd'],
      ['/company/acme%2Dltd', '/company/acme-ltd'],
      ['/company/Acme%20Ltd', '/company/acme%20ltd'],
    ] as const) {
      const res = await visit(path, { mode: 'enforce' });
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(
        `https://sponsorsearch.co.uk${to}`,
      );
    }
  });

  test('the redirect is the same with the switch off, and its target is decided', async () => {
    const off = await visit('/COMPANY/acme-ltd');
    expect(off.status).toBe(301);
    const target = await visit('/company/acme%20ltd', { mode: 'enforce' });
    expect(rewrittenTo(target)).toContain('render=client');
  });

  test('enforce: a data call is refused however its path is spelled', async () => {
    for (const path of [
      `${SESSION_CALL_PATH}abc`,
      '/_serverFn/%73-abc',
      '/_serverFn/s%2Dabc',
      '/_server%46n/s-abc',
      '/_SERVERFN/S-abc',
    ]) {
      const res = await visit(path, {
        mode: 'enforce',
        accept: 'application/json',
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('x-session')).toBe('required');
    }
  });

  test('a path that does not decode is refused at the edge', async () => {
    const res = await visit('/company/%E0%A4%A', { mode: 'enforce' });
    expect(res.status).toBe(400);
  });
});
