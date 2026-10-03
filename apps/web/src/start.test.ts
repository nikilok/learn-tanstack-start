import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { redirect } from '@tanstack/react-router';
import { requestHandler } from '@tanstack/react-start/server';

import { LONG_EDGE_CACHE, setRpcCacheControl } from './api/cache-headers';
import { SERVER_FN_ERROR_MESSAGE } from './lib/server-fn-errors';
import { startInstance } from './start';

const options = await startInstance.getOptions();
const [serverFnErrors] = options.functionMiddleware ?? [];
const [csrf] = options.requestMiddleware ?? [];

const RPC_PATH = '/_serverFn/test';

/** Runs the registered server-function middleware around `next`, as getCompanyProfile, inside a request for `path`; settles with what it returned or threw and the answered Cache-Control. */
async function serve(path: string, next: () => Promise<unknown>) {
  const server = serverFnErrors?.options.server as unknown as (ctx: {
    next: () => Promise<unknown>;
    serverFnMeta: { id: string; name: string; filename: string };
  }) => Promise<unknown>;
  const settled: { result?: unknown; error?: unknown } = {};
  const respond = requestHandler(async () => {
    try {
      settled.result = await server({
        next,
        serverFnMeta: {
          id: 'test',
          name: 'getCompanyProfile',
          filename: 'src/api/companiesHouse.ts',
        },
      });
    } catch (error) {
      settled.error = error;
    }
    // A server function answers 200 whether it succeeded or failed.
    return new Response(null);
  });
  const response = await respond(
    new Request(`https://sponsorsearch.co.uk${path}`),
    {},
  );
  return { ...settled, cacheControl: response.headers.get('cache-control') };
}

/** A handler that sets its 30-day header, then fails tagging its rows, as getHmrcCompanyBySlug can. */
async function failsAfterLongHeader(): Promise<never> {
  setRpcCacheControl(LONG_EDGE_CACHE);
  throw new TypeError("Header 'x-vercel-cache-tag' has invalid value");
}

/** Runs the registered request middleware for a request carrying `headers`; a rejection comes back as its status. */
async function request(
  headers: Record<string, string>,
  handlerType: 'serverFn' | 'router' = 'serverFn',
) {
  const server = csrf?.options.server as unknown as (ctx: {
    request: Request;
    pathname: string;
    context: object;
    handlerType: 'serverFn' | 'router';
    next: () => Promise<unknown>;
  }) => Promise<unknown>;
  const result = await server({
    request: new Request(`https://sponsorsearch.co.uk${RPC_PATH}`, {
      headers,
    }),
    pathname: RPC_PATH,
    context: {},
    handlerType,
    next: async () => 'handled',
  });
  return result instanceof Response ? result.status : result;
}

let errorLog: ReturnType<typeof spyOn>;
beforeEach(() => {
  errorLog = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

describe('startInstance request middleware', () => {
  // A start instance replaces the framework default that ran this check.
  test('rejects a cross-site server-function call', async () => {
    expect(await request({ 'sec-fetch-site': 'cross-site' })).toBe(403);
  });

  test('rejects a server-function call with no origin headers', async () => {
    expect(await request({})).toBe(403);
  });

  test('lets a same-origin server-function call through', async () => {
    expect(await request({ 'sec-fetch-site': 'same-origin' })).toBe('handled');
  });

  test('leaves page requests alone', async () => {
    expect(await request({ 'sec-fetch-site': 'cross-site' }, 'router')).toBe(
      'handled',
    );
  });
});

describe('startInstance function middleware', () => {
  test('a failed server function reaches the caller as the generic error', async () => {
    const { error } = await serve(RPC_PATH, async () => {
      throw new Error(
        'Failed query: select "company_number" from "hmrc_company_mapping"\nparams: ACME LTD',
      );
    });
    expect((error as Error).message).toBe(SERVER_FN_ERROR_MESSAGE);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0]?.[0])).toStartWith(
      '[ServerFn] getCompanyProfile failed: Error: Failed query:',
    );
  });

  test('a slug lookup that fails after its 30-day header answers no-store', async () => {
    const { error, cacheControl } = await serve(RPC_PATH, failsAfterLongHeader);
    expect((error as Error).message).toBe(SERVER_FN_ERROR_MESSAGE);
    expect(cacheControl).toBe('private, no-store');
  });

  test('the same failure in a page render leaves the document header to its loader', async () => {
    const { cacheControl } = await serve('/company/acme', failsAfterLongHeader);
    expect(cacheControl).toBeNull();
  });

  test('a redirect passes through unlogged and adds no cache header', async () => {
    const thrown = redirect({ to: '/privacy' });
    const { error, cacheControl } = await serve(RPC_PATH, async () => {
      throw thrown;
    });
    expect(error).toBe(thrown);
    expect(errorLog).not.toHaveBeenCalled();
    expect(cacheControl).toBeNull();
  });

  test('a result keeps the cache header its handler set', async () => {
    const ctx = { result: { kind: 'found' } };
    const { result, cacheControl } = await serve(RPC_PATH, async () => {
      setRpcCacheControl(LONG_EDGE_CACHE);
      return ctx;
    });
    expect(result).toBe(ctx);
    expect(cacheControl).toBe(LONG_EDGE_CACHE);
  });
});
