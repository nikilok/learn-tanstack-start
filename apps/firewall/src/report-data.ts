// Data layer for the firewall report: fetches Vercel observability metrics and returns
// structured data, rendered by the TUI's report pane (components.tsx ReportView, opened with 'r').
// Window is the last ~6 days including today so far (the free `observability_chart_free` tier
// caps startTime at 7).

import { errMsg } from './util';

type Row = Record<string, unknown>;
type Ctx = {
  projectId: string;
  teamId: string;
  headers: Record<string, string>;
  qs: string;
  startTime: string;
  endTime: string;
  windowMin: number;
};

type DistRow = { ip: string; perMin: number };
type Distribution = {
  label: string;
  skipped?: string; // query failed / no usable filter
  empty?: boolean; // no traffic
  capped?: boolean; // hit the 500-row API cap, so IPs is partial
  ips?: number;
  max?: number;
  p99?: number;
  p95?: number;
  median?: number;
  rows?: DistRow[]; // top IPs, busiest first
};
export type ReportData = {
  start: string;
  now: string; // actual coverage end (the query end is ceiled into the future for alignment)
  byRule: { label: string; count: number }[];
  byRuleError?: string;
  topPaths: { path: string; count: number }[];
  topPathsError?: string;
  distributions: Distribution[];
  limits: { serverfn: string; search: string; tiles: string };
};

/** POST the dashboard observability endpoint (entitlement-free `observability_chart_free` reason), retrying transient 5xx/429. */
async function metrics(
  ctx: Ctx,
  groupBy: string[],
  opts: { event?: string; filter?: string; limit?: number } = {},
): Promise<{ summary?: Row[] }> {
  const body = JSON.stringify({
    scope: {
      type: 'project',
      ownerId: ctx.teamId,
      projectIds: [ctx.projectId],
    },
    reason: 'observability_chart_free',
    event: opts.event ?? 'incomingRequest',
    rollups: { count_sum: { measure: 'count', aggregation: 'sum' } },
    startTime: ctx.startTime,
    endTime: ctx.endTime,
    granularity: { hours: 1 },
    groupBy,
    ...(opts.filter ? { filter: opts.filter } : {}),
    limit: opts.limit ?? 500, // hard max
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(
      `https://vercel.com/api/observability/metrics?${ctx.qs}`,
      { method: 'POST', headers: ctx.headers, body },
    );
    if (res.ok) return res.json() as Promise<{ summary?: Row[] }>;
    const detail = `metrics ${res.status}: ${(await res.text()).slice(0, 160)}`;
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(detail);
  }
}

/** Map custom firewall rule ids to names via the active firewall config (for the per-rule report). */
async function ruleNames(ctx: Ctx): Promise<Map<string, string>> {
  const res = await fetch(
    `https://api.vercel.com/v1/security/firewall/config/active?${ctx.qs}`,
    { headers: ctx.headers },
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
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0; // a non-numeric scalar must not become NaN (poisons sort + display)
}

/** Sort a response's summary rows by count desc and return the top `n` [key, count] pairs. */
function top(
  resp: { summary?: Row[] },
  key: string,
  n: number,
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

/** Fetch the per-IP volume distribution for one path/route filter; returns a skipped/empty marker instead of throwing. */
async function fetchDist(
  ctx: Ctx,
  label: string,
  filter: string,
): Promise<Distribution> {
  let resp: { summary?: Row[] };
  try {
    resp = await metrics(ctx, ['clientIp'], { filter, limit: 500 });
  } catch (e) {
    return { label, skipped: errMsg(e) };
  }
  const rows = top(resp, 'clientIp', 500); // desc by count
  if (!rows.length) return { label, empty: true };
  const counts = rows.map(([, c]) => c).reverse(); // asc for pct() (rows is already desc)
  return {
    label,
    capped: rows.length >= 500, // tail beyond 500 is dropped by the API
    ips: rows.length,
    max: rows[0][1], // rows is desc, so the first is the max
    p99: pct(counts, 0.99),
    p95: pct(counts, 0.95),
    median: pct(counts, 0.5),
    rows: rows
      .slice(0, 8)
      .map(([ip, c]) => ({ ip, perMin: c / ctx.windowMin })),
  };
}

/** Fetch the full firewall report: actions-by-rule, top paths, and per-IP distributions on the rate-limited paths. Each section degrades to an error/skip marker so one transient failure never blanks the rest. */
export async function fetchReport(creds: {
  projectId: string;
  teamId: string;
  token: string;
}): Promise<ReportData> {
  const now = new Date();
  const end = new Date(now);
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(end.getUTCHours() + 1); // ceil to next whole hour so the API window is aligned
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  const ctx: Ctx = {
    projectId: creds.projectId,
    teamId: creds.teamId,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'Content-Type': 'application/json',
    },
    qs: `teamId=${creds.teamId}&projectId=${creds.projectId}`,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    // Divide rates by ACTUAL elapsed minutes (start→now), not the future-ceiled end, or /min is understated.
    windowMin: Math.round((now.getTime() - start.getTime()) / 60000),
  };

  let byRule: { label: string; count: number }[] = [];
  let byRuleError: string | undefined;
  try {
    const names = await ruleNames(ctx);
    byRule = top(
      await metrics(ctx, ['wafRuleId'], { event: 'firewallAction' }),
      'wafRuleId',
      25,
    ).map(([id, count]) => ({ label: names.get(id) ?? id, count }));
  } catch (e) {
    byRuleError = errMsg(e);
  }

  let topPaths: { path: string; count: number }[] = [];
  let topPathsError: string | undefined;
  try {
    topPaths = top(
      await metrics(ctx, ['requestPath'], { limit: 60 }),
      'requestPath',
      60,
    ).map(([path, count]) => ({ path, count }));
  } catch (e) {
    topPathsError = errMsg(e);
  }

  // The `like` filter is rejected by this API, so /_serverFn uses the busiest fn hash (discovered)
  // as a proxy, and tiles uses the route. The path is interpolated into the filter DSL, so restrict
  // it to safe chars (no quotes/metachars).
  const topServerFn = topPaths.find(
    (p) => p.path.startsWith('/_serverFn/') && /^[\w./-]+$/.test(p.path),
  )?.path;
  const distributions: Distribution[] = [
    topServerFn
      ? await fetchDist(
          ctx,
          `busiest server fn — ${topServerFn}`,
          `requestPath eq '${topServerFn}'`,
        )
      : {
          label: 'busiest server fn',
          skipped:
            'no safe /_serverFn/* path in top paths (the top-paths query may have failed)',
        },
    await fetchDist(
      ctx,
      '/api/tiles',
      "route eq '/api/tiles/[theme]/[z]/[x]/[y]'",
    ),
    await fetchDist(
      ctx,
      '/ home (SSR search upper bound)',
      "requestPath eq '/'",
    ),
  ];

  return {
    start: ctx.startTime,
    now: now.toISOString(),
    byRule,
    byRuleError,
    topPaths,
    topPathsError,
    distributions,
    limits: {
      serverfn: process.env.FW_SERVERFN_LIMIT ?? '?',
      search: process.env.FW_SEARCH_LIMIT ?? '?',
      tiles: process.env.FW_TILES_LIMIT ?? '?',
    },
  };
}
