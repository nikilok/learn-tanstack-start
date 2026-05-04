import { timingSafeEqual } from 'node:crypto';
import { defineEventHandler } from 'h3';

export function withSecret(
  handler: () => void,
): ReturnType<typeof defineEventHandler> {
  return defineEventHandler((event) => {
    event.res.status = 202;
    const secret = event.req.headers.get('x-revalidate-secret') ?? '';
    const expected = process.env.REVALIDATE_SECRET ?? '';
    const a = Buffer.from(secret);
    const b = Buffer.from(expected);
    const equal = a.length === b.length && timingSafeEqual(a, b);
    if (equal && expected.length > 0) {
      handler();
    }
    return { accepted: true };
  });
}
