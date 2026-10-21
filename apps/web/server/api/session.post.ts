/**
 * POST /api/session
 *
 * Issues the browser a session bound to its address and device, or confirms the one it holds
 * (`src/lib/session/issue.server.ts`). The page calls it once per load, from the root, naming its
 * device key in a JSON body (`{ key }`) when it has one; the browser check stands in front of it
 * (`CHECKED_CALLS`), and the edge middleware passes it through (`API_EXACT`). Answers
 * `{ session }` as JSON, never cached.
 */
import { defineEventHandler, readBody } from 'h3';

import { deviceOf, sessionResponse } from '#/lib/session/issue.server';

export default defineEventHandler(async (event) =>
  sessionResponse(
    event.req.headers,
    // A body that is absent or does not read names no device.
    deviceOf(await readBody(event).catch(() => null)),
  ),
);
