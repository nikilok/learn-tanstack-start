/**
 * A test double for the neon tagged-template client: records each call's
 * text and params, and resolves with canned rows. For tests only.
 */

import type { NeonQueryFunction } from '@ss/db/client';

/** One recorded call: the text with $n placeholders, and the bound values. */
export type FakeSqlCall = { text: string; params: unknown[] };

/** A raw fragment as `unsafe` hands it back, the driver's own shape. */
type Raw = { sql: string };

/** Whether an interpolated value is a raw fragment rather than a value to bind. */
function isRaw(value: unknown): value is Raw {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Raw).sql === 'string'
  );
}

/** A fake client: raw fragments are spliced in as text and the rest bound as $n, as the driver does. */
export function makeFakeSql(result: Record<string, unknown>[] = []) {
  const calls: FakeSqlCall[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    const params: unknown[] = [];
    values.forEach((value, i) => {
      text += isRaw(value) ? value.sql : `$${params.push(value)}`;
      text += strings[i + 1];
    });
    calls.push({ text, params });
    return Promise.resolve(result);
  }) as unknown as NeonQueryFunction<false, false>;
  sql.unsafe = (raw: string) =>
    ({ sql: raw }) as unknown as ReturnType<typeof sql.unsafe>;
  return { sql, calls };
}
