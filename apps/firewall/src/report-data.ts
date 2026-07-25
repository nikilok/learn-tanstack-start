// Data layer for the firewall report: fetches Vercel observability metrics and returns
// structured data, rendered by the TUI's report pane (components.tsx ReportView, opened with 'r').
// Window is the last ~6 days including today so far (the free `observability_chart_free` tier
// caps startTime at 7).
//
// Peaks, not averages. A rate limit is a ceiling on a 60s (or 600s) window, so dividing a
// 6-day total by the window is meaningless — it reported ~0.1/min for an IP whose real peak
// was 99/min, which is how a 100/min ceiling came to look safe while it was blocking humans.
// Instead: one hourly query yields every IP's hourly series (the API returns all buckets for
// all returned groups), then the busiest hours are re-queried at minute granularity to get a
// true peak/min and peak/10min. Peaks are therefore a FLOOR — only the sampled hours are
// examined — which the pane states rather than implying exactness.

import { errMsg } from './util';

type Row = Record<string, unknown>;
type Ctx = {
  projectId: string;
  teamId: string;
  headers: Record<string, string>;
  qs: string;
  startTime: string;
  endTime: string;
};

// Bursts are located with 10-MINUTE buckets, not hourly ones: hourly volume does not reveal
// a one-minute spike (an IP whose true peak was 108/min sat in an unremarkable hour and read
// as 61/min), whereas a 108-request minute necessarily puts >=108 in its 10-minute bucket.
// That bound also makes the search EXACT rather than a sample — see refinePeaks.
const PEAK_IPS = 6; // IPs measured — matches the 6 rows the pane renders
const PEAK_WINDOWS = 8; // most windows zoomed in one round (a round is one parallel batch)
const ZOOM_ROUNDS = 5; // refinement rounds before settling for the best found so far
const MAX_CONCURRENT = 6; // simultaneous observability calls (they 429 if fanned out wide)

export type DistRow = {
  ip: string;
  total: number; // requests over the whole report window
  sampled: boolean; // false when no series covered this IP at all, so peaks are unknown
  peakMin: number; // busiest single 60s bucket found
  peakMinExact: boolean; // false when refinement stopped early — peakMin is then only a floor
  peakMinBound: number; // proven upper bound on peak/min; equals peakMin when exact
  peak10m: number; // busiest rolling 10-minute span found
};
type Distribution = {
  label: string;
  limit?: number; // 60s burst ceiling (FW_*_LIMIT), if configured — bars render against it
  sustainedLimit?: number; // 600s sustained ceiling (FW_*_SUSTAINED_LIMIT), if configured
  skipped?: string; // query failed / no usable filter
  empty?: boolean; // no traffic
  capped?: boolean; // hit the 500-group API cap, so IPs is partial
  sampledWindows?: number; // 10-min windows zoomed to minute granularity
  exact?: boolean; // peak/min proven maximal ACROSS THE MEASURED IPs; false = a floor
  ips?: number; // distinct IPs on this path in the window
  measuredIps?: number; // how many of them had peaks resolved (the top PEAK_IPS by volume)
  maxPeakMin?: number; // busiest IP's peak 60s burst
  maxPeak10m?: number; // busiest IP's peak 10-minute volume
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
};

/** `fetch` AND the body read bounded by one abort timeout, so a stalled connection surfaces as an error instead of hanging the report pane on "Loading…" forever. The body must be consumed inside the timeout: `await fetch` settles at response HEADERS, so clearing the timer around the fetch alone leaves a stalled body stream with no deadline at all — the pane would hang on "Loading…" with the refresh key inert. Generous by design: a 6-day grouped query normally takes ~3-5s but spikes while other report queries are in flight, and aborting one drops a whole panel. */
async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = 30000,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

// One shared gate for every observability call. The limiter has to be global: fetchDist runs
// several at a time AND each refinePeaks fans out its own batch, so a per-call-site cap
// multiplies (2 x 6 = 12 in flight) past what the API tolerates — and the resulting 429s used
// to surface as unmeasured buckets rather than as errors.
let inFlight = 0;
const waiting: (() => void)[] = [];

/** Run `fn` with at most MAX_CONCURRENT observability calls in flight process-wide. */
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT)
    await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/** POST the dashboard observability endpoint (entitlement-free `observability_chart_free` reason), retrying transient 5xx/429. Defaults to hourly buckets over the whole report window; `granularity`/`startTime`/`endTime` override that for minute-level zooms. */
async function metrics(
  ctx: Ctx,
  groupBy: string[],
  opts: {
    event?: string;
    filter?: string;
    limit?: number;
    granularity?: Record<string, number>;
    startTime?: string;
    endTime?: string;
  } = {},
): Promise<{ data?: Row[]; summary?: Row[] }> {
  const body = JSON.stringify({
    scope: {
      type: 'project',
      ownerId: ctx.teamId,
      projectIds: [ctx.projectId],
    },
    reason: 'observability_chart_free',
    event: opts.event ?? 'incomingRequest',
    rollups: { count_sum: { measure: 'count', aggregation: 'sum' } },
    startTime: opts.startTime ?? ctx.startTime,
    endTime: opts.endTime ?? ctx.endTime,
    granularity: opts.granularity ?? { hours: 1 },
    groupBy,
    ...(opts.filter ? { filter: opts.filter } : {}),
    limit: opts.limit ?? 500, // hard max
  });
  for (let attempt = 1; ; attempt++) {
    let res: { ok: boolean; status: number; text: string };
    try {
      res = await gated(() =>
        fetchWithTimeout(
          `https://vercel.com/api/observability/metrics?${ctx.qs}`,
          { method: 'POST', headers: ctx.headers, body },
        ),
      );
    } catch (e) {
      // A timeout/network failure throws before any response, so it can't be handled by
      // the status check below — retry it too, or one slow query silently drops a panel.
      // Only ONE such retry: a hung connection costs the full timeout each time, and the
      // report chains these calls, so extra attempts turn a bad link into a pane that
      // sits on "Loading…" for many minutes with no way to cancel.
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw new Error(`metrics request failed: ${errMsg(e)}`);
    }
    if (res.ok)
      return JSON.parse(res.text) as { data?: Row[]; summary?: Row[] };
    const detail = `metrics ${res.status}: ${res.text.slice(0, 160)}`;
    if ((res.status >= 500 || res.status === 429) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(detail);
  }
}

/** Map custom firewall rule ids to names via the active firewall config (for the per-rule report). */
async function ruleNames(ctx: Ctx): Promise<Map<string, string>> {
  const res = await fetchWithTimeout(
    `https://api.vercel.com/v1/security/firewall/config/active?${ctx.qs}`,
    { headers: ctx.headers },
  );
  if (!res.ok) return new Map();
  const cfg = JSON.parse(res.text) as {
    rules?: { id: string; name: string }[];
  };
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

/** Run tasks with bounded concurrency, so one report refresh can't fan out into dozens of simultaneous observability calls (which get 429'd). */
async function pool<T>(
  tasks: (() => Promise<T>)[],
  size: number,
): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

type Bucket = { t: string; c: number };

/** Group per-bucket rows into a chronological series per IP. The API returns every bucket (zeros included) for every group it returns, so each series is contiguous and safe to run a rolling window over. */
function seriesByIp(resp: { data?: Row[] }): Map<string, Bucket[]> {
  const byIp = new Map<string, Bucket[]>();
  for (const r of resp.data ?? []) {
    const ip = String(r.clientIp ?? '?');
    const t = String(r.timestamp ?? '');
    if (!t) continue;
    const list = byIp.get(ip);
    if (list) list.push({ t, c: cnt(r) });
    else byIp.set(ip, [{ t, c: cnt(r) }]);
  }
  for (const list of byIp.values()) list.sort((a, b) => a.t.localeCompare(b.t)); // ISO strings sort chronologically
  return byIp;
}

/** An IP is interpolated into the filter DSL, so accept only literal v4/v6 characters. */
function safeIp(ip: string): boolean {
  return /^[0-9a-fA-F.:]{3,45}$/.test(ip);
}

type Peaks = {
  peakMin: Map<string, number>;
  peak10m: Map<string, number>;
  bound: Map<string, number>; // proven upper bound on peak/min (equals peakMin once resolved)
  windows: number; // 10-min windows actually zoomed
};

/** Resolve the true peak/min by zooming 10-minute buckets in descending order. A bucket of C requests cannot contain a minute above C, so a bucket is only worth opening if C beats both that IP's best so far AND the best found across all IPs — the latter is what makes this cheap, since a flat crawler's buckets (high volume, low per-minute) are dismissed outright instead of being refined toward a number nobody acts on. The reported maximum is therefore proven, while quieter IPs may resolve only to an upper bound, which they report as such. Rounds are batched (one query serves every listed IP in that window) and capped so a pathological profile still terminates. */
async function refinePeaks(
  ctx: Ctx,
  ipFilter: string,
  tenMin: Map<string, Bucket[]>,
  listed: string[],
): Promise<Peaks> {
  const peakMin = new Map(listed.map((ip) => [ip, 0]));
  // peak10m is the max ALIGNED 10-minute bucket, full stop — it covers the whole window
  // (so it is exact, not a sample) and matches how a fixed_window rule counts. Mixing in a
  // rolling span from the zoomed windows would report two different numbers for the same
  // traffic depending on whether that bucket happened to win a zoom nomination, and would
  // compare a rolling figure against a ceiling the WAF applies to aligned windows.
  const peak10m = new Map(
    listed.map((ip) => [
      ip,
      Math.max(0, ...(tenMin.get(ip) ?? []).map((b) => b.c)),
    ]),
  );
  // `zoomed` = buckets actually MEASURED. A bucket whose query failed goes only into
  // `attempted`, so it is never re-nominated but still counts against the upper bound —
  // marking it examined would let a 429 masquerade as proof and report a peak from a
  // bucket nobody ever opened.
  const zoomed = new Set<string>();
  const attempted = new Set<string>();
  let windows = 0;

  /** Biggest unmeasured bucket left for an IP — the ceiling on any minute still unexamined. */
  const remaining = (ip: string) =>
    Math.max(
      0,
      ...(tenMin.get(ip) ?? []).filter((b) => !zoomed.has(b.t)).map((b) => b.c),
    );

  for (let round = 0; round < ZOOM_ROUNDS; round++) {
    const globalBest = Math.max(0, ...peakMin.values());
    // Each IP nominates its biggest un-attempted bucket that could still beat both its own
    // best and the global best; no nominations means the maximum is proven.
    const want: string[] = [];
    for (const ip of listed) {
      const bar = Math.max(peakMin.get(ip) ?? 0, globalBest);
      let pick: Bucket | undefined;
      for (const b of tenMin.get(ip) ?? [])
        if (!attempted.has(b.t) && b.c > bar && (!pick || b.c > pick.c))
          pick = b;
      if (pick && !want.includes(pick.t)) want.push(pick.t);
    }
    if (!want.length) break;
    const stamps = want.slice(0, PEAK_WINDOWS);
    const results = await pool(
      stamps.map((stamp) => async () => {
        const w = new Date(stamp);
        if (Number.isNaN(w.getTime())) return null;
        // Exactly the bucket: a 1-minute bucket never straddles a 10-minute boundary, so
        // padding would only enlarge the response without tightening any bound.
        const from = w;
        const to = new Date(w.getTime() + 10 * 60_000);
        try {
          return seriesByIp(
            await metrics(ctx, ['clientIp'], {
              filter: ipFilter,
              limit: 500,
              granularity: { minutes: 1 },
              startTime: from.toISOString(),
              endTime: to.toISOString(),
            }),
          );
        } catch {
          return null; // one failed zoom just narrows the sample; the rest still report
        }
      }),
      MAX_CONCURRENT,
    );
    // pool() preserves order, so results[i] is the outcome of stamps[i].
    stamps.forEach((stamp, i) => {
      attempted.add(stamp);
      if (results[i]) {
        zoomed.add(stamp);
        windows++;
      }
    });
    for (const res of results) {
      if (!res) continue;
      for (const [ip, series] of res) {
        if (!peakMin.has(ip)) continue;
        peakMin.set(
          ip,
          Math.max(peakMin.get(ip) ?? 0, ...series.map((b) => b.c)),
        );
      }
    }
  }
  const bound = new Map(
    listed.map((ip) => [
      ip,
      Math.max(peakMin.get(ip) ?? 0, remaining(ip)), // resolved IPs have nothing left above their best
    ]),
  );
  return { peakMin, peak10m, bound, windows };
}

/** Fetch one path's per-IP peak burst profile. Three stages: hourly totals to rank IPs, a full-window 10-minute series for those IPs (exact sustained-tier volume, and the map used to locate bursts), then minute-granularity zooms into the busiest 10-minute windows for the true peak/min. Returns a skipped/empty marker instead of throwing. */
async function fetchDist(
  ctx: Ctx,
  label: string,
  filter: string,
  limit?: number,
  sustainedLimit?: number,
): Promise<Distribution> {
  const base = { label, limit, sustainedLimit };
  let resp: { data?: Row[]; summary?: Row[] };
  try {
    resp = await metrics(ctx, ['clientIp'], { filter, limit: 500 });
  } catch (e) {
    return { ...base, skipped: errMsg(e) };
  }
  const totals = top(resp, 'clientIp', 500); // desc by count
  if (!totals.length) return { ...base, empty: true };

  const listed = totals
    .slice(0, PEAK_IPS)
    .map(([ip]) => ip)
    .filter(safeIp);
  if (!listed.length)
    return { ...base, ips: totals.length, sampledWindows: 0, rows: [] };
  // Narrowing to the listed IPs is what makes fine granularity affordable: 10-minute
  // buckets across the whole window are ~860 per IP, versus hundreds of thousands if
  // every IP came back.
  const ipFilter = `${filter} and clientIp in (${listed.map((ip) => `'${ip}'`).join(',')})`;

  let tenMin: Map<string, Bucket[]>;
  try {
    tenMin = seriesByIp(
      await metrics(ctx, ['clientIp'], {
        filter: ipFilter,
        limit: 500,
        granularity: { minutes: 10 },
      }),
    );
  } catch (e) {
    // Every peak derives from this series, so its failure must surface as a skip. Falling
    // through with an empty map would leave nothing to nominate, and the all-zero result
    // would then satisfy the exactness test — rendering a confident "peak 0/min · exact"
    // for a path that was never measured at all.
    return { ...base, ips: totals.length, skipped: `peaks: ${errMsg(e)}` };
  }

  const peaks = await refinePeaks(ctx, ipFilter, tenMin, listed);

  const rows: DistRow[] = totals.slice(0, PEAK_IPS).map(([ip, total]) => {
    const peakMin = peaks.peakMin.get(ip) ?? 0;
    const peakMinBound = peaks.bound.get(ip) ?? peakMin;
    return {
      ip,
      total,
      // Measured iff the 10-minute series covered this IP; without it peaks are unknown
      // rather than zero, and the pane shows a dash instead of an innocent-looking 0.
      sampled: (tenMin.get(ip)?.length ?? 0) > 0,
      peakMin,
      peakMinExact: peakMinBound <= peakMin,
      peakMinBound,
      peak10m: peaks.peak10m.get(ip) ?? 0,
    };
  });
  // Rank by whichever ceiling the IP is closest to, so a steady heavy user (high 10-minute
  // volume, unremarkable per-minute) isn't buried under a spikier but harmless one. Ranks on
  // the MEASURED burst, not the upper bound, so the order matches the column as displayed;
  // an IP left unresolved was, by construction, one that could not beat the leader anyway.
  const pressure = (r: DistRow) =>
    limit || sustainedLimit
      ? Math.max(
          limit ? r.peakMin / limit : 0,
          sustainedLimit ? r.peak10m / sustainedLimit : 0,
        )
      : r.peakMin;
  rows.sort((a, b) => pressure(b) - pressure(a) || b.total - a.total);

  const maxPeakMin = Math.max(0, ...rows.map((r) => r.peakMin));
  return {
    ...base,
    capped: totals.length >= 500, // tail beyond 500 groups is dropped by the API
    ips: totals.length,
    // Only the top PEAK_IPS by whole-window volume are measured, so `exact` is a claim about
    // THEM, not about every IP on the path — a low-volume client that burst once and went
    // quiet is outside the measured set entirely. The pane names the measured count so the
    // headline is not read as a site-wide maximum.
    measuredIps: rows.length,
    sampledWindows: peaks.windows,
    // The headline is the maximum across measured IPs when nothing left unresolved among
    // them could have exceeded it.
    exact: rows.every((r) => r.peakMinExact || r.peakMinBound <= maxPeakMin),
    maxPeakMin,
    maxPeak10m: Math.max(0, ...rows.map((r) => r.peak10m)),
    rows,
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

  // Fetched deep (not just the ~60 shown) because the /_serverFn distribution below builds
  // its filter from this list: a truncated list silently drops the quieter fn paths from
  // every IP's measured rate, understating them against a ceiling that counts all of them.
  let allPaths: { path: string; count: number }[] = [];
  let topPathsError: string | undefined;
  try {
    allPaths = top(
      await metrics(ctx, ['requestPath'], { limit: 500 }),
      'requestPath',
      500,
    ).map(([path, count]) => ({ path, count }));
  } catch (e) {
    topPathsError = errMsg(e);
  }
  const topPaths = allPaths.slice(0, 60); // the pane's list stays a top-60 view

  // Each rate-limited path's ceilings (FW_*_LIMIT = 60s burst, FW_*_SUSTAINED_LIMIT = 600s)
  // — the bars and percentages in the report compare measured peaks against these.
  const ceiling = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const serverfnLimit = ceiling(process.env.FW_SERVERFN_LIMIT);
  const serverfnSustained = ceiling(process.env.FW_SERVERFN_SUSTAINED_LIMIT);
  const tilesLimit = ceiling(process.env.FW_TILES_LIMIT);
  const searchLimit = ceiling(process.env.FW_SEARCH_LIMIT);
  const searchSustained = ceiling(process.env.FW_SEARCH_SUSTAINED_LIMIT);
  const downloadsLimit = ceiling(process.env.FW_DOWNLOADS_LIMIT);

  // The `like` filter is rejected by this API and route '/__server' lumps every SSR page in
  // with the RPCs, so /_serverFn is matched as an explicit `in (…)` set of the fn paths seen
  // in this window. It must be ALL of them, not just the busiest: rl-serverfn-ip counts the
  // whole /_serverFn prefix, so sampling one hash would understate every IP against its
  // ceiling. Paths are interpolated into the filter DSL, so restrict to safe chars.
  const serverFnPaths = allPaths
    .map((p) => p.path)
    .filter((p) => p.startsWith('/_serverFn/') && /^[\w./-]+$/.test(p));
  // 500 groups is the API's hard cap, so a site with more distinct paths than that (every
  // /company/<slug> competes for a slot) can push quieter fn hashes out of the list
  // entirely. Say so rather than letting "(N fns)" imply the set is complete — a missing
  // hash understates every IP against a ceiling that counts the whole prefix.
  const pathsTruncated = allPaths.length >= 500;
  const serverFnDist = (): Promise<Distribution> =>
    serverFnPaths.length
      ? fetchDist(
          ctx,
          `/_serverFn (${serverFnPaths.length} fns${pathsTruncated ? ', path list truncated' : ''})`,
          `requestPath in (${serverFnPaths.map((p) => `'${p}'`).join(',')})`,
          serverfnLimit,
          serverfnSustained,
        )
      : Promise.resolve({
          label: '/_serverFn',
          limit: serverfnLimit,
          sustainedLimit: serverfnSustained,
          skipped:
            'no safe /_serverFn/* path in top paths (the top-paths query may have failed)',
        });

  // Concurrent: each distribution costs an hourly query plus a handful of minute-level zooms,
  // so serialising all four would make the pane take ~4x as long to first render.
  const distributions = await pool<Distribution>(
    [
      serverFnDist,
      () =>
        fetchDist(
          ctx,
          '/api/tiles',
          "route eq '/api/tiles/[theme]/[z]/[x]/[y]'",
          tilesLimit,
        ),
      // There is no query-string dimension in this API, so `/` is the closest available
      // proxy for the rule's `/` AND ?search= condition — it is a strict SUPERSET. Plain
      // homepage views inflate the 10-minute figure far more than the per-minute one
      // (they accumulate steadily across 600s, which is exactly the level-rate shape the
      // sustained tier discriminates on), so the label warns against sizing the sustained
      // ceiling from it directly.
      () =>
        fetchDist(
          ctx,
          '/ home — ALL home traffic, rule sees only ?search= (10m over-reads)',
          "requestPath eq '/'",
          searchLimit,
          searchSustained,
        ),
      // rl-downloads-ip calibration bar. Catch-all Nitro route; if this shows no
      // data once real installer traffic exists, adjust to how Vercel reports the
      // /downloads/[...path] catch-all.
      () =>
        fetchDist(
          ctx,
          '/downloads (versioned installers)',
          "route eq '/downloads/[...path]'",
          downloadsLimit,
        ),
    ],
    2, // each fetchDist already fans out internally, so keep the outer width small
  );

  return {
    start: ctx.startTime,
    now: now.toISOString(),
    byRule,
    byRuleError,
    topPaths,
    topPathsError,
    distributions,
  };
}
