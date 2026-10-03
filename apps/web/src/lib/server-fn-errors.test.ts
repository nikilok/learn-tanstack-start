import { describe, expect, test } from 'bun:test';

import { notFound, redirect } from '@tanstack/react-router';

import {
  clientSafeError,
  failureLogLine,
  SERVER_FN_ERROR_MESSAGE,
} from './server-fn-errors';

/** getCompanyProfile's mapping read failing, in the shape Drizzle throws it. */
const failedMappingQuery = () =>
  new Error(
    'Failed query: select "organisation_name", "company_number" from "hmrc_company_mapping" where "hmrc_company_mapping"."organisation_name" = $1 limit $2\nparams: ACME LTD,1',
    { cause: new Error('Error connecting to database: fetch failed') },
  );

describe('clientSafeError', () => {
  test("getCompanyProfile's failed mapping query reaches the caller as the generic message", () => {
    const safe = clientSafeError(failedMappingQuery());
    expect(safe).toBeInstanceOf(Error);
    expect(safe).toHaveProperty('message', SERVER_FN_ERROR_MESSAGE);
  });

  test('a missing API key is replaced too', () => {
    const safe = clientSafeError(
      new Error('COMPANIES_HOUSE_API_KEY is not set'),
    );
    expect(safe).toHaveProperty('message', SERVER_FN_ERROR_MESSAGE);
  });

  test('a thrown non-Error is replaced', () => {
    expect(clientSafeError('boom')).toHaveProperty(
      'message',
      SERVER_FN_ERROR_MESSAGE,
    );
  });

  test('a redirect is control flow and passes through', () => {
    const thrown = redirect({ to: '/privacy' });
    expect(clientSafeError(thrown)).toBe(thrown);
  });

  test('a not-found is control flow and passes through', () => {
    const thrown = notFound();
    expect(clientSafeError(thrown)).toBe(thrown);
  });

  test('a thrown Response passes through', () => {
    const thrown = new Response('Too many requests', { status: 429 });
    expect(clientSafeError(thrown)).toBe(thrown);
  });
});

describe('failureLogLine', () => {
  test('names the function, the error and its cause on one line', () => {
    const line = failureLogLine('getCompanyProfile', failedMappingQuery());
    expect(line).toStartWith(
      '[ServerFn] getCompanyProfile failed: Error: Failed query:',
    );
    expect(line).toContain(
      '(cause: Error: Error connecting to database: fetch failed)',
    );
    expect(line).not.toContain('\n');
  });

  test('stays bounded however long the message is', () => {
    const line = failureLogLine('searchHmrc', new Error('x'.repeat(10_000)));
    expect(line.length).toBeLessThan(400);
  });

  test('describes a thrown non-Error', () => {
    expect(failureLogLine('logError', 'boom')).toBe(
      '[ServerFn] logError failed: boom',
    );
  });

  test('blanks control characters a caller put in the message', () => {
    const line = failureLogLine(
      'getSlugForHash',
      new Error('params: \u0000\u001b]8;;x\u0007\u0085,1'),
    );
    expect(line).not.toMatch(/\p{Cc}/u);
  });

  test('never throws, whatever was thrown', () => {
    const unprintable = Object.create(null);
    const badGetter = new Error('x');
    Object.defineProperty(badGetter, 'message', {
      get() {
        throw new Error('getter');
      },
    });
    expect(failureLogLine('searchHmrc', unprintable)).toBe(
      '[ServerFn] searchHmrc failed: [unprintable error]',
    );
    expect(failureLogLine('searchHmrc', badGetter)).toBe(
      '[ServerFn] searchHmrc failed: [unprintable error]',
    );
  });
});
