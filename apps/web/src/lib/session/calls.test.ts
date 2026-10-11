import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sessionCallId } from './call-ids';
import { SESSION_CALL_PATH, SESSION_CALL_PREFIX, SESSION_CALLS } from './calls';

const APP_ROOT = join(import.meta.dir, '../../..');

describe('SESSION_CALLS', () => {
  test.each(SESSION_CALLS.map((call) => [call]))(
    '%s is still a server function where the list says',
    (call) => {
      const [file, variable] = call.split('#') as [string, string];
      const source = readFileSync(join(APP_ROOT, file), 'utf8');
      expect(source).toMatch(
        new RegExp(`const ${variable} = createServerFn\\(`),
      );
    },
  );
});

describe('sessionCallId', () => {
  test('a session call gets a prefixed id, stable for its place', () => {
    const id = sessionCallId({
      filename: 'src/api/hmrc.ts',
      functionName: 'getHmrcCompanyBySlug_createServerFn_handler',
    });
    expect(id).toStartWith(SESSION_CALL_PREFIX);
    expect(id).toMatch(/^s-[0-9a-f]{64}$/);
    expect(
      sessionCallId({
        filename: 'src/api/hmrc.ts',
        functionName: 'getHmrcCompanyBySlug_createServerFn_handler',
      }),
    ).toBe(id);
    expect(`/_serverFn/${id}`).toStartWith(SESSION_CALL_PATH);
  });

  test('a numbered handler name is the same function', () => {
    expect(
      sessionCallId({
        filename: 'src/api/companyTimeline.ts',
        functionName: 'getCompanyTimeline_createServerFn_handler_1',
      }),
    ).toStartWith(SESSION_CALL_PREFIX);
  });

  test('every other function keeps the default id', () => {
    for (const [filename, name] of [
      ['src/api/hmrc.ts', 'searchHmrc'],
      ['src/api/companyExtras.ts', 'getCompanyExtras'],
      ['src/api/other.ts', 'getHmrcCompanyBySlug'],
    ] as const)
      expect(
        sessionCallId({
          filename,
          functionName: `${name}_createServerFn_handler`,
        }),
      ).toBeUndefined();
  });

  test('a default id can never be taken for one: it is plain hex', () => {
    expect(/^[0-9a-f]+$/.test(SESSION_CALL_PREFIX)).toBe(false);
  });
});
