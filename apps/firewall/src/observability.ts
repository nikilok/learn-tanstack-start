// Client for Vercel's dashboard observability endpoint, shared by the report pane and the IP
// profiler. Window is capped at ~7 days by the `observability_chart_free` reason.

import { type Window, rollingWindow } from './time-window';
import { errMsg } from './util';

export type Row = Record<string, unknown>;
export type Ctx = {
  projectId: string;
  teamId: string;
  headers: Record<string, string>;
  qs: string;
  startTime: string;
  endTime: string;
};

export const MAX_CONCURRENT = 6; // simultaneous observability calls (they 429 if fanned out wide)

/** `fetch` AND the body read under one abort timeout — `await fetch` settles at headers, so timing only the fetch leaves a stalled body with no deadline. */
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

// Global, not per-call-site: nested pools would multiply into 12 in flight and 429.
let inFlight = 0;
const waiting: (() => void)[] = [];

/** Run `fn` with at most MAX_CONCURRENT observability calls in flight process-wide. */
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  // `while`, not `if`: a woken waiter must re-check, or a fresh caller steals the freed slot.
  while (inFlight >= MAX_CONCURRENT)
    await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

/** POST the dashboard observability endpoint, retrying transient 5xx/429. Hourly buckets over the whole window unless overridden. */
export async function metrics(
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
      // Throws before any response, so the status check below can't retry it. Only ONE
      // retry: each attempt costs the full timeout and the report chains these calls.
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
export function top(
  resp: { summary?: Row[] },
  key: string,
  n: number,
): [string, number][] {
  return (resp.summary ?? [])
    .map((r) => [String(r[key] ?? '?'), cnt(r)] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

/** Run tasks with bounded concurrency, so one refresh can't fan out into dozens of simultaneous observability calls (which get 429'd). */
export async function pool<T>(
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

export type Bucket = { t: string; c: number };

/** Group per-bucket rows into a chronological series per group key. The API zero-fills, so each series is contiguous. */
export function seriesBy(
  resp: { data?: Row[] },
  dim = 'clientIp',
): Map<string, Bucket[]> {
  const byIp = new Map<string, Bucket[]>();
  for (const r of resp.data ?? []) {
    const ip = String(r[dim] ?? '?');
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
export function safeIp(ip: string): boolean {
  return /^[0-9a-fA-F.:]{3,45}$/.test(ip);
}

/** Map custom firewall rule ids to names via the active firewall config, so observability results grouped by `wafRuleId` can be labelled. Returns an empty map on failure — a label is never worth failing a report over. */
export async function ruleNames(ctx: Ctx): Promise<Map<string, string>> {
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

/** Build the request context for an explicit window. Callers pass a resolved Window, which has already been hour-aligned and clamped to what the API will serve. */
export function makeCtx(
  creds: { projectId: string; teamId: string; token: string },
  span: { days?: number; hours?: number } | Window,
): { ctx: Ctx; now: Date } {
  const now = new Date();
  const w =
    'fromISO' in span ? span : rollingWindow(span.days ? span.days * 24 : (span.hours ?? 24), now);
  const start = new Date(w.fromISO);
  const end = new Date(w.toISO);
  return {
    now,
    ctx: {
      projectId: creds.projectId,
      teamId: creds.teamId,
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      qs: `teamId=${creds.teamId}&projectId=${creds.projectId}`,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    },
  };
}
