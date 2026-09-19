import { describe, expect, test } from 'bun:test';

import { ENGAGED_PATH } from '#/scripts/engagement-init';

import { engagedResponse } from '../api/engaged.post';

// Lives under utils/, not api/: Nitro builds every file in server/api/ into a route, a test
// file included — it shipped as `/api/engaged.post.test` on the first build.

describe('POST /api/engaged', () => {
  test('answers 204 with no body and no caching', async () => {
    const res = engagedResponse();
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });

  // Nitro routes the handler by its file name, and the script addresses it by a string
  // constant. Nothing structural ties the two spellings together, so this does — renaming
  // either half alone would send every ping to a 404 with nothing else failing.
  test('the script pings the path the handler file is routed at', () => {
    expect(ENGAGED_PATH).toBe('/api/engaged');
  });
});
