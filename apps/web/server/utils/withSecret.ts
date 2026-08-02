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
 * mismatch it returns a neutral 202 {accepted:true} — deliberately not a
 * 401/403, so probing gets no explicit auth signal. The neutrality is only as
 * strong as the wrapped handler's own responses: revalidate's trail drain
 * answers 202 either way, while its ?purge mode and /api/releases return
 * 200/400/500 once authenticated — a deliberate trade so CI callers can
 * verify success (the timing-safe compare only closes the timing
 * side-channel; the secret's entropy is what stops guessing). Each caller
 * passes its own header name + secret.
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
