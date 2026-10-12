import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sessionCallId } from './call-ids';
import { SESSION_CALL_PATH, SESSION_CALL_PREFIX, SESSION_CALLS } from './calls';

const APP_ROOT = join(import.meta.dir, '../../..');

/** Server functions any visitor may call: none answers with a company page's data. */
const OPEN_CALLS = [
  'src/api/companyExtras.ts#issueExtrasToken',
  'src/api/filterSearch.ts#searchFiltered',
  'src/api/geocode.ts#getGeocode',
  'src/api/hmrc.ts#getSlugForHash',
  'src/api/hmrc.ts#getSponsorCount',
  // Answers with a company's current slug alone, for the legacy URL's 301.
  'src/api/hmrc.ts#resolveCompanySlug',
  'src/api/hmrc.ts#searchHmrc',
  'src/api/ingestion.ts#getLastIngestion',
  'src/api/logError.ts#logError',
  'src/api/releases.ts#getDesktopReleases',
  'src/api/releases.ts#getOwnerDesktopReleases',
  'src/api/releases.ts#setReleaseVisibility',
];

/** Every server function the app declares, as `file#variable`. */
function serverFunctions(): string[] {
  const found: string[] = [];
  for (const file of new Bun.Glob('src/**/*.{ts,tsx}').scanSync(APP_ROOT)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    for (const m of source.matchAll(/const (\w+) = createServerFn\(/g))
      found.push(`${file}#${m[1]}`);
  }
  return found.sort();
}

describe('SESSION_CALLS', () => {
  test('every server function is placed: a session call, or open', () => {
    expect(serverFunctions()).toEqual([...SESSION_CALLS, ...OPEN_CALLS].sort());
  });

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
      filename: 'src/api/companyPage.ts',
      functionName: 'getCompanyPage_createServerFn_handler',
    });
    expect(id).toStartWith(SESSION_CALL_PREFIX);
    expect(id).toMatch(/^s-[0-9a-f]{64}$/);
    expect(
      sessionCallId({
        filename: 'src/api/companyPage.ts',
        functionName: 'getCompanyPage_createServerFn_handler',
      }),
    ).toBe(id);
    expect(`/_serverFn/${id}`).toStartWith(SESSION_CALL_PATH);
  });

  test('a numbered handler name is the same function', () => {
    expect(
      sessionCallId({
        filename: 'src/api/companyExtras.ts',
        functionName: 'getCompanyExtras_createServerFn_handler_1',
      }),
    ).toStartWith(SESSION_CALL_PREFIX);
  });

  test('every other function keeps the default id', () => {
    for (const [filename, name] of [
      ['src/api/hmrc.ts', 'searchHmrc'],
      ['src/api/hmrc.ts', 'resolveCompanySlug'],
      ['src/api/companyExtras.ts', 'issueExtrasToken'],
      ['src/api/other.ts', 'getCompanyPage'],
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
