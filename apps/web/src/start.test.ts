import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { redirect } from '@tanstack/react-router';

import { SERVER_FN_ERROR_MESSAGE } from './lib/server-fn-errors';
import { startInstance } from './start';

const options = await startInstance.getOptions();
const [serverFnErrors] = options.functionMiddleware ?? [];
const [csrf] = options.requestMiddleware ?? [];

/** Runs the registered server-function middleware around `next`, as getCompanyProfile. */
function run(next: () => Promise<unknown>) {
  const server = serverFnErrors?.options.server as unknown as (ctx: {
    next: () => Promise<unknown>;
    serverFnMeta: { id: string; name: string; filename: string };
  }) => Promise<unknown>;
  return server({
    next,
    serverFnMeta: {
      id: 'test',
      name: 'getCompanyProfile',
      filename: 'src/api/companiesHouse.ts',
    },
  });
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
    request: new Request('https://sponsorsearch.co.uk/_serverFn/test', {
      headers,
    }),
    pathname: '/_serverFn/test',
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
    const failure = run(async () => {
      throw new Error(
        'Failed query: select "company_number" from "hmrc_company_mapping"\nparams: ACME LTD',
      );
    });
    await expect(failure).rejects.toThrow(SERVER_FN_ERROR_MESSAGE);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0]?.[0])).toStartWith(
      '[ServerFn] getCompanyProfile failed: Error: Failed query:',
    );
  });

  test('an error next() resolves with, instead of throwing, is replaced too', async () => {
    // The framework rethrows only truthy errors, so a falsy throw resolves.
    await expect(run(async () => ({ error: '' }))).rejects.toThrow(
      SERVER_FN_ERROR_MESSAGE,
    );
    await expect(
      run(async () => ({ error: new Error('Failed query: select 1') })),
    ).rejects.toThrow(SERVER_FN_ERROR_MESSAGE);
    expect(errorLog).toHaveBeenCalledTimes(2);
  });

  test('a redirect passes through unlogged', async () => {
    const thrown = redirect({ to: '/privacy' });
    await expect(
      run(async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(errorLog).not.toHaveBeenCalled();
  });

  test('a result passes through untouched', async () => {
    const ctx = { result: { kind: 'found' } };
    expect(await run(async () => ctx)).toBe(ctx);
  });
});
