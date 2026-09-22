import { describe, expect, test } from 'bun:test';

import {
  engagedPingPath,
  presentPingPath,
  viewPingPath,
} from '#/lib/device/key';

import { devicePingResponse } from './devicePing';

// Lives under utils/, not api/: Nitro builds every file in server/api/ into a route
// (see engaged.test.ts).

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';

describe('POST /api/p/:hash, /api/v/:hash and /api/e/:hash', () => {
  test('answers 204 with no body and no caching for a well-formed key', async () => {
    const res = devicePingResponse(KEY);
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });

  test('answers 404, uncached, for anything else', () => {
    for (const bad of [undefined, '', 'abc', KEY.toUpperCase(), `${KEY}0`]) {
      const res = devicePingResponse(bad);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  // Nitro routes the handlers by their file names, and the client builds the paths from
  // string constants. Nothing structural ties the spellings together, so this does —
  // renaming either half alone would send every ping to a 404 with nothing else failing.
  test('the client pings the paths the handler files are routed at', () => {
    expect(presentPingPath(KEY)).toBe(`/api/p/${KEY}`);
    expect(viewPingPath(KEY)).toBe(`/api/v/${KEY}`);
    expect(engagedPingPath(KEY)).toBe(`/api/e/${KEY}`);
  });
});
