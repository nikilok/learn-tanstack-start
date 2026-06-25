import { resolveVercelCredentials } from './vercel-credentials';

// Read-only firewall monitoring report. Pulls Vercel observability data for the last
// ~6 days including today so far (free tier caps startTime at 7) and prints:
//   1. firewall actions per rule — your rl-* rules appearing here means a rate-limit fired
//   2. top request paths — overall traffic scale
//   3. per-IP distribution on the rate-limited paths — to (re)calibrate the limits
// Run from the repo root so bun auto-loads .env.local for VERCEL_TOKEN:
//   bun apps/web/scripts/firewall-report.ts

const { projectId, teamId, token } = resolveVercelCredentials();

// Hour-aligned rolling window so "today so far" is included; ~6 days stays inside the 7-day cap.
const now = new Date();
const end = new Date(now);
end.setUTCMinutes(0, 0, 0);
end.setUTCHours(end.getUTCHours() + 1); // ceil to next whole hour so the API window is aligned
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - 6);
const START = start.toISOString();
const END = end.toISOString();
const NOW = now.toISOString(); // actual coverage end — END is ceiled into the future only for query alignment
// Divide rates by the ACTUAL elapsed minutes (start→now), not the future-ceiled END, or /min is understated.
const WINDOW_MIN = Math.round((now.getTime() - start.getTime()) / 60000);

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};
const qs = `teamId=${teamId}&projectId=${projectId}`;

type Row = Record<string, unknown>;

/** POST the dashboard observability endpoint (entitlement-free `observability_chart_free` reason), retrying transient 5xx/429. */
async function metrics(
  groupBy: string[],
  opts: { event?: string; filter?: string; limit?: number } = {},
): Promise<{ summary?: Row[] }> {
  const body = JSON.stringify({
    scope: { type: 'project', ownerId: teamId, projectIds: [projectId] },
    reason: 'observability_chart_free',
    event: opts.event ?? 'incomingRequest',
    rollups: { count_sum: { measure: 'count', aggregation: 'sum' } },
    startTime: START,
    endTime: END,
    granularity: { hours: 1 },
    groupBy,
    ...(opts.filter ? { filter: opts.filter } : {}),
    limit: opts.limit ?? 500, // hard max
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(
      `https://vercel.com/api/observability/metrics?${qs}`,
      { method: 'POST', headers, body },
    );
    if (res.ok) return res.json();
    const detail = `metrics ${res.status}: ${(await res.text()).slice(0, 160)}`;
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(detail);
  }
}

/** Map custom firewall rule ids to names via the active firewall config (for the per-rule report). */
async function ruleNames(): Promise<Map<string, string>> {
  const res = await fetch(
    `https://api.vercel.com/v1/security/firewall/config/active?${qs}`,
    { headers },
  );
  if (!res.ok) return new Map();
  const cfg = (await res.json()) as { rules?: { id: string; name: string }[] };
  return new Map((cfg.rules ?? []).map((r) => [r.id, r.name]));
}

/** Extract the summed count from an observability summary row (scalar or {value|sum}). */
function cnt(row: Row): number {
  const v = (row.count_sum ?? row.count) as unknown;
  if (v && typeof v === 'object') {
    const o = v as { value?: number; sum?: number };
    return o.value ?? o.sum ?? 0;
  }
  return Number(v ?? 0);
}

/** Sort a response's summary rows by count desc and return the top `n` [key, count] pairs. */
function top(
  resp: { summary?: Row[] },
  key: string,
  n = 30,
): [string, number][] {
  return (resp.summary ?? [])
    .map((r) => [String(r[key] ?? '?'), cnt(r)] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

/** Percentile over an ascending-sorted array (p in [0,1]); indexes over length-1 so p<1 doesn't return the max on small samples. */
function pct(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : 0;
}

/** Print the per-IP volume distribution for one path/route filter; skips (doesn't abort) on query error. */
async function distribution(label: string, filter: string) {
  console.log(`\n— per-IP on ${label}`);
  let resp: { summary?: Row[] };
  try {
    resp = await metrics(['clientIp'], { filter, limit: 500 });
  } catch (e) {
    console.log(`  (skipped — ${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  const rows = top(resp, 'clientIp', 500);
  const counts = rows.map(([, c]) => c).sort((a, b) => a - b);
  if (!counts.length) {
    console.log('  (no traffic)');
    return;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const capped = rows.length >= 500; // observability API caps grouped rows at 500 — tail beyond is dropped
  console.log(
    `  total=${total}${capped ? '+' : ''}  IPs=${rows.length}${capped ? '+ (top 500 only)' : ''}  ` +
      `per-IP: max=${Math.max(...counts)} ` +
      `p99=${pct(counts, 0.99)} p95=${pct(counts, 0.95)} median=${pct(counts, 0.5)}`,
  );
  for (const [ip, c] of rows.slice(0, 8)) {
    console.log(
      `    ${String(c).padStart(7)}  ${(c / WINDOW_MIN).toFixed(2)}/min  ${ip}`,
    );
  }
}

/** Fetch + print the three report sections; each degrades to a skip line on error so one transient failure never blanks the whole report. */
async function main() {
  console.log(`firewall report — ${START} → ${NOW}`);

  console.log(
    '\n=== firewall actions by rule — rl-* here = a rate-limit fired ===',
  );
  try {
    const names = await ruleNames();
    const byRule = top(
      await metrics(['wafRuleId'], { event: 'firewallAction' }),
      'wafRuleId',
      25,
    );
    if (!byRule.length) console.log('  (no firewall actions)');
    for (const [id, c] of byRule) {
      console.log(`  ${String(c).padStart(8)}  ${names.get(id) ?? id}`);
    }
  } catch (e) {
    console.log(`  (skipped — ${e instanceof Error ? e.message : String(e)})`);
  }

  console.log('\n=== top request paths ===');
  let paths: [string, number][] = [];
  try {
    paths = top(
      await metrics(['requestPath'], { limit: 60 }),
      'requestPath',
      60,
    );
    for (const [p, c] of paths.slice(0, 20)) {
      console.log(`  ${String(c).padStart(8)}  ${p}`);
    }
  } catch (e) {
    console.log(`  (skipped — ${e instanceof Error ? e.message : String(e)})`);
  }

  // Per-IP distributions on the rate-limited paths. The `like` filter is rejected by this
  // API, so /_serverFn uses the busiest fn hash (discovered) as a proxy, and tiles uses the route.
  // The path is interpolated into the filter DSL, so restrict it to safe chars (no quotes/metachars).
  const topServerFn = paths.find(
    ([p]) => p.startsWith('/_serverFn/') && /^[\w./-]+$/.test(p),
  )?.[0];
  if (topServerFn) {
    await distribution(
      `busiest server fn — ${topServerFn}`,
      `requestPath eq '${topServerFn}'`,
    );
  } else {
    console.log('\n— per-IP on busiest server fn');
    console.log(
      '  (skipped — no safe /_serverFn/* path in top paths; the top-paths query above may have failed)',
    );
  }
  await distribution('/api/tiles', "route eq '/api/tiles/[theme]/[z]/[x]/[y]'");
  await distribution('/ home (SSR search upper bound)', "requestPath eq '/'");

  const limits = `serverfn ${process.env.FW_SERVERFN_LIMIT ?? '?'}, search ${process.env.FW_SEARCH_LIMIT ?? '?'}, tiles ${process.env.FW_TILES_LIMIT ?? '?'}`;
  console.log(
    `\nCompare top per-IP /min above to your configured limits (${limits}).`,
  );
  console.log(
    'Heaviest legit IP is usually Googlebot (66.249.x) — keep it well under any limit.',
  );
}

main().catch((error) => {
  console.error('report failed:', error);
  process.exit(1);
});
