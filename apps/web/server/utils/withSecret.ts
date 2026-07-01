import { timingSafeEqual } from 'node:crypto';

import { type H3Event, defineEventHandler } from 'h3';

/** JSON Response helper — h3 handlers may return a Response directly. */
export function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Timing-safe shared-secret comparison, shared by every secret-gated endpoint.
 * Returns false when the expected secret is empty/unset so a missing env var can
 * never authorize a request. Constant-time for equal-length inputs.
 */
export function secretMatches(
  provided: string | null | undefined,
  expected: string | undefined,
): boolean {
  const exp = expected ?? '';
  if (exp.length === 0) return false;
  const a = Buffer.from(provided ?? '');
  const b = Buffer.from(exp);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Wraps a handler behind a timing-safe shared-secret check on `header` vs
 * `secret`. Runs `handler` (returning its Response) only on a match; on a
 * mismatch it returns the SAME neutral 202 an accepted request gets —
 * deliberately no 401/403, so an attacker probing secrets can't tell a wrong one
 * from a right one (the timing-safe compare blocks guessing; this hides the
 * outcome too). Each caller passes its own header name + secret.
 */
export function withSecret(
  header: string,
  secret: string | undefined,
  handler: (event: H3Event) => Response | Promise<Response>,
): ReturnType<typeof defineEventHandler> {
  return defineEventHandler((event) => {
    if (!secretMatches(event.req.headers.get(header), secret)) {
      return json({ accepted: true }, 202);
    }
    return handler(event);
  });
}
