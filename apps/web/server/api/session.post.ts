/**
 * POST /api/session
 *
 * Issues the browser a session bound to its address, or confirms the one it holds
 * (`src/lib/session/issue.server.ts`). The page calls it once per load, from the root; the browser
 * check stands in front of it (`CHECKED_CALLS`), and the edge middleware passes it through
 * (`API_EXACT`). Answers `{ session }` as JSON, never cached.
 */
import { defineEventHandler } from 'h3';

import { sessionResponse } from '#/lib/session/issue.server';

export default defineEventHandler((event) =>
  sessionResponse(event.req.headers),
);
