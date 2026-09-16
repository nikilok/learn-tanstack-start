/**
 * How many distinct company pages a visitor session sees — the distribution the
 * session_visits table exists to measure. Prints, over the last N days (default 7):
 *
 *   - per session per UTC hour: p50 / p90 / p95 / p99 / max distinct slugs, and how many
 *     session-hours that is over;
 *   - per session over the whole window: the same percentiles.
 *
 * Usage: bun scripts/session-visits-report.ts [days]
 */
import { createClient } from '@ss/db';
import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';

dotenv.config({ path: '../../.env.local' });

const days = Math.max(1, Number(process.argv[2] ?? 7) || 7);
const db = createClient(process.env.POSTGRES_URL as string);

type Row = {
  scope: string;
  groups: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
};

const percentiles = (inner: string, scope: string) =>
  sql.raw(`
  SELECT '${scope}' AS scope,
         count(*)::int AS groups,
         percentile_cont(0.5)  WITHIN GROUP (ORDER BY n)::float AS p50,
         percentile_cont(0.9)  WITHIN GROUP (ORDER BY n)::float AS p90,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY n)::float AS p95,
         percentile_cont(0.99) WITHIN GROUP (ORDER BY n)::float AS p99,
         max(n)::int AS max
  FROM (${inner}) t
`);

const since = `now() - interval '${days} days'`;
const perHour = `SELECT count(DISTINCT slug) AS n FROM session_visits WHERE hour >= ${since} GROUP BY session_id, hour`;
const perSession = `SELECT count(DISTINCT slug) AS n FROM session_visits WHERE hour >= ${since} GROUP BY session_id`;

const rows: Row[] = [];
for (const [inner, scope] of [
  [perHour, 'session-hour'],
  [perSession, `session (${days}d)`],
] as const) {
  const r = await db.execute(percentiles(inner, scope));
  rows.push(...(r.rows as unknown as Row[]));
}

console.log(`session_visits — last ${days} day(s)\n`);
console.log('scope            groups     p50    p90    p95    p99    max');
for (const r of rows)
  console.log(
    `${r.scope.padEnd(16)} ${String(r.groups).padStart(6)}  ${r.p50.toFixed(1).padStart(6)} ${r.p90.toFixed(1).padStart(6)} ${r.p95.toFixed(1).padStart(6)} ${r.p99.toFixed(1).padStart(6)} ${String(r.max).padStart(6)}`,
  );
