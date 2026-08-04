// Data layer for the firewall report: per-path peak per-IP traffic, rendered by report-view.
// Reports measured PEAKS, never window averages — a rate limit is a ceiling on a 60s/600s
// window. Window is the last ~6 days (`observability_chart_free` caps startTime at 7).

import {
  type Bucket,
  type Ctx,
  MAX_CONCURRENT,
  type Row,
  makeCtx,
  metrics,
  pool,
  ruleNames,
  safeIp,
  seriesByIp,
  top,
} from './observability';
import { envCeiling, errMsg } from './util';

// Bursts are located with 10-minute buckets, not hourly: hourly volume hides a one-minute spike.
const PEAK_IPS = 6; // IPs measured — matches the 6 rows the pane renders
const PEAK_WINDOWS = 8; // most windows zoomed in one round (a round is one parallel batch)
const ZOOM_ROUNDS = 5; // refinement rounds before settling for the best found so far

export type DistRow = {
  ip: string;
  total: number; // requests over the whole report window
  sampled: boolean; // false when no series covered this IP at all, so peaks are unknown
  peakMin: number; // busiest single 60s bucket found
  peakMinExact: boolean; // false when refinement stopped early — peakMin is then only a floor
  peakMinBound: number; // proven upper bound on peak/min; equals peakMin when exact
  peak10m: number; // busiest ALIGNED 10-minute bucket (whole window, so exact — not rolling)
};
export type Distribution = {
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

type Peaks = {
  peakMin: Map<string, number>;
  peak10m: Map<string, number>;
  bound: Map<string, number>; // proven upper bound on peak/min (equals peakMin once resolved)
  windows: number; // 10-min windows actually zoomed
};

/** Resolve the true peak/min by opening 10-minute buckets in descending order. A bucket of C cannot hold a minute above C, so one is only worth opening if C beats that IP's best AND the global best — which prunes flat crawlers outright. Quieter IPs may resolve only to an upper bound. */
async function refinePeaks(
  ctx: Ctx,
  ipFilter: string,
  tenMin: Map<string, Bucket[]>,
  listed: string[],
): Promise<Peaks> {
  const peakMin = new Map(listed.map((ip) => [ip, 0]));
  // Max ALIGNED 10-min bucket — whole-window, and the unit a fixed_window rule counts in.
  const peak10m = new Map(
    listed.map((ip) => [
      ip,
      Math.max(0, ...(tenMin.get(ip) ?? []).map((b) => b.c)),
    ]),
  );
  // `zoomed` = measured; a failed zoom lands only in `attempted` so it still bounds the peak.
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
    // No nominations = every remaining bucket is too small to beat the best, so it is proven.
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
        // No padding: a 1-minute bucket never straddles a 10-minute boundary.
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

/** One path's per-IP peak profile: hourly totals rank the IPs, a 10-minute series gives sustained volume and locates bursts, then minute zooms resolve peak/min. Returns a skip marker instead of throwing. */
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
  // Narrowing to these IPs is what makes whole-window 10-minute granularity affordable.
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
    // Must skip, not fall through: all-zero peaks would otherwise render as a confident "exact".
    return { ...base, ips: totals.length, skipped: `peaks: ${errMsg(e)}` };
  }

  const peaks = await refinePeaks(ctx, ipFilter, tenMin, listed);

  const rows: DistRow[] = totals.slice(0, PEAK_IPS).map(([ip, total]) => {
    const peakMin = peaks.peakMin.get(ip) ?? 0;
    const peakMinBound = peaks.bound.get(ip) ?? peakMin;
    return {
      ip,
      total,
      // Unknown, not zero — the pane dashes these rather than showing an innocent 0.
      sampled: (tenMin.get(ip)?.length ?? 0) > 0,
      peakMin,
      peakMinExact: peakMinBound <= peakMin,
      peakMinBound,
      peak10m: peaks.peak10m.get(ip) ?? 0,
    };
  });
  // Rank by the nearest ceiling, so a steady heavy user isn't buried under a spikier one.
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
    // Only measured IPs count — an unknown peak defaulting to 0 would pass the exactness test.
    measuredIps: rows.filter((r) => r.sampled).length,
    sampledWindows: peaks.windows,
    // True maximum only if nothing unresolved could have exceeded it.
    exact: rows.every(
      (r) => r.sampled && (r.peakMinExact || r.peakMinBound <= maxPeakMin),
    ),
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
  const { ctx, now } = makeCtx(creds, { days: 6 });

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

  // Fetched deep, not just the ~60 shown: the /_serverFn filter below is built from this list.
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

  // Ceilings the bars compare against; same envCeiling the rule builder uses, so they agree.
  const serverfnLimit = envCeiling('FW_SERVERFN_LIMIT');
  const serverfnSustained = envCeiling('FW_SERVERFN_SUSTAINED_LIMIT');
  const tilesLimit = envCeiling('FW_TILES_LIMIT');
  const searchLimit = envCeiling('FW_SEARCH_LIMIT');
  const searchSustained = envCeiling('FW_SEARCH_SUSTAINED_LIMIT');
  const downloadsLimit = envCeiling('FW_DOWNLOADS_LIMIT');

  // No `like` filter and '/__server' lumps in every SSR page, so match an explicit path set —
  // ALL fn paths, since the rule counts the whole prefix. Interpolated, so safe chars only.
  const serverFnPaths = allPaths
    .map((p) => p.path)
    .filter((p) => p.startsWith('/_serverFn/') && /^[\w./-]+$/.test(p));
  // 500 groups is the API cap, so /company/<slug> paths can crowd out fn hashes — say so.
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

  // Concurrent, or the pane takes ~4x as long to first render.
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
      // No query-string dimension exists, so `/` is a strict SUPERSET of what the rule counts;
      // the label warns that its 10-minute figure over-reads.
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
