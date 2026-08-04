// Data layer for `firewall:ip` — everything about one client IP that bears on "scraper or human".
// Read-only by design: this reports, it never bans (see the watch-branch post-mortem).

import type { Reach } from './ban-advice';
import {
  type Mix,
  type Shape,
  type Tell,
  mixOf,
  shapeOf,
  tellsFor,
} from './ip-signals';
import {
  type Ctx,
  makeCtx,
  metrics,
  pool,
  ruleNames,
  safeIp,
  seriesByIp,
  top,
} from './observability';
import type { Window } from './time-window';
import { errMsg } from './util';

// 10-minute buckets resolve a session; hourly hides it. Past 2 days that is too many rows to read.
const FINE_BUCKET_HOURS = 48;

export type IpProfile = {
  ip: string;
  start: string;
  end: string;
  windowHours: number;
  windowLabel: string;
  total: number;
  byStatus: [string, number][];
  byUserAgent: [string, number][];
  byJa4: [string, number][];
  byAsn: [string, number][];
  byCountry: [string, number][];
  byBot: [string, number][]; // botVerified|botName|botCategory, for display
  byBotVerified: [string, number][]; // botVerified alone — the field that overrides other tells
  byWafAction: [string, number][];
  byWafRule: [string, number][];
  byPath: [string, number][];
  byReferrer: [string, number][];
  mix: Mix;
  shape: Shape;
  buckets: { t: string; c: number }[]; // zero-filled series behind `shape`
  tells: Tell[];
  // What the dominant fingerprint and network do BEYOND this IP. Without these a deny
  // recommendation cannot tell a single automated host from a shared identity that real
  // browsers, verified agents or our own services also use.
  digestReach?: Reach;
  asnReach?: Reach;
  errors: string[];
};

/** One grouped query, degraded to [] plus an error note rather than failing the whole profile. */
async function group(
  ctx: Ctx,
  errors: string[],
  label: string,
  dims: string[],
  filter: string,
  event?: string,
): Promise<[string, number][]> {
  try {
    const resp = await metrics(ctx, dims, { filter, event, limit: 500 });
    // Join multi-dimension keys so one row reads as one line.
    return (resp.summary ?? [])
      .map((r) => {
        const key = dims
          .map((d) => String(r[d] ?? '').trim())
          .filter(Boolean)
          .join(' | ');
        const v = r.count_sum as unknown;
        const n =
          v && typeof v === 'object'
            ? ((v as { value?: number; sum?: number }).value ??
              (v as { sum?: number }).sum ??
              0)
            : Number(v ?? 0);
        return [key || '(none)', Number.isFinite(n) ? n : 0] as [string, number];
      })
      .sort((a, b) => b[1] - a[1]);
  } catch (e) {
    errors.push(`${label}: ${errMsg(e)}`);
    return [];
  }
}

/** Profile one IP over the last `hours`. Fans out one grouped query per dimension plus a bucket series, then scores the result with the pure tells. */
export async function fetchIpProfile(
  creds: { projectId: string; teamId: string; token: string },
  ip: string,
  window: Window,
): Promise<IpProfile> {
  if (!safeIp(ip)) throw new Error(`"${ip}" is not a valid IP address`);
  const hours = window.hours;
  const { ctx } = makeCtx(creds, window);
  const filter = `clientIp eq '${ip}'`;
  const errors: string[] = [];
  const g = (label: string, dims: string[], event?: string) => () =>
    group(ctx, errors, label, dims, filter, event);

  const [
    byStatus,
    byUserAgent,
    byJa4,
    byAsn,
    byCountry,
    byBot,
    byBotVerifiedRaw,
    byWafAction,
    wafRuleRows,
    byPath,
    byReferrer,
  ] = await pool(
    [
      g('status', ['httpStatus']),
      g('user agents', ['clientUserAgent']),
      g('ja4', ['clientJa4Digest']),
      g('asn', ['asnName']),
      g('country', ['clientIpCountry']),
      g('bot', ['botVerified', 'botName', 'botCategory']),
      // Its own query: in the joined row above, a blank botVerified collapses out and a mere
      // botCategory reads as a verified bot — which inverts the tell it is meant to override.
      g('bot verified', ['botVerified']),
      g('waf action', ['wafAction']),
      g('waf rule', ['wafRuleId'], 'firewallAction'),
      g('paths', ['requestPath']),
      g('referrer', ['referrerUrl']),
    ],
    4,
  );

  const bucketMinutes = hours <= FINE_BUCKET_HOURS ? 10 : 60;
  let buckets: { t: string; c: number }[] = [];
  try {
    buckets =
      seriesByIp(
        await metrics(ctx, ['clientIp'], {
          filter,
          limit: 500,
          granularity: { minutes: bucketMinutes },
        }),
      ).get(ip) ?? [];
  } catch (e) {
    errors.push(`series: ${errMsg(e)}`);
  }

  // Rule ids are opaque; label them, but never fail the profile over a missing label.
  let byWafRule = wafRuleRows;
  if (wafRuleRows.length) {
    try {
      const names = await ruleNames(ctx);
      byWafRule = wafRuleRows.map(([id, c]) => [names.get(id) ?? id, c]);
    } catch {
      // keep the raw ids
    }
  }

  // What an identity does BEYOND this IP. Both levers need it: a deny is only safe when nothing
  // else riding the same handle has ever rendered a page.
  const reachOf = async (
    label: string,
    filter: string,
  ): Promise<Reach | undefined> => {
    const [ips, countries, bots, paths] = await pool(
      [
        () => group(ctx, errors, `reach ips ${label}`, ['clientIp'], filter),
        () =>
          group(ctx, errors, `reach geo ${label}`, ['clientIpCountry'], filter),
        () =>
          group(
            ctx,
            errors,
            `reach bots ${label}`,
            ['botVerified', 'botName'],
            filter,
          ),
        () => group(ctx, errors, `reach paths ${label}`, ['requestPath'], filter),
      ],
      4,
    );
    if (!ips.length) return undefined;
    const kinds = mixOf(paths);
    return {
      label,
      ips: ips.length,
      countries: countries.length,
      total: ips.reduce((s, [, c]) => s + c, 0),
      subResources: kinds.asset,
      beacons: kinds.beacon,
      verifiedNames: bots
        .filter(([k]) => k.startsWith('pass'))
        .map(([k]) => k.split(' | ')[1] ?? 'verified')
        .filter((n, i, a) => a.indexOf(n) === i),
    };
  };

  const topDigest = byJa4[0]?.[0];
  const topAsn = byAsn[0]?.[0];
  const [digestReach, asnReach] = await pool(
    [
      () =>
        topDigest && topDigest !== '(none)'
          ? reachOf(topDigest, `clientJa4Digest eq '${topDigest}'`)
          : Promise.resolve(undefined),
      // Interpolated into the filter DSL and the API has no escape syntax, so an ASN name
      // containing a quote is skipped rather than sent.
      () =>
        topAsn && topAsn !== '(none)' && !topAsn.includes("'")
          ? reachOf(topAsn, `asnName eq '${topAsn}'`)
          : Promise.resolve(undefined),
    ],
    2,
  );

  const mix = mixOf(byPath);
  const shape = shapeOf(buckets, bucketMinutes);
  const total = byStatus.reduce((s, [, c]) => s + c, 0) || mix.total;
  // Vercel leaves botVerified blank for everything it has not verified; only `pass` counts.
  const byBotVerified = byBotVerifiedRaw.filter(
    ([v]) => v && v !== '(none)' && v !== 'undefined',
  );

  return {
    ip,
    start: ctx.startTime,
    end: ctx.endTime,
    windowHours: hours,
    windowLabel: window.label,
    total,
    byStatus,
    byUserAgent,
    byJa4,
    byAsn,
    byCountry,
    byBot,
    byBotVerified,
    byWafAction,
    byWafRule,
    byPath,
    byReferrer,
    mix,
    shape,
    buckets,
    digestReach,
    asnReach,
    tells: tellsFor({
      total,
      mix,
      shape,
      ja4: byJa4,
      userAgents: byUserAgent,
      asns: byAsn,
      countries: byCountry,
      botVerified: byBotVerified,
      windowMinutes: hours * 60,
    }),
    errors,
  };
}

/** Top IPs by volume over the window — the entry point when you do not yet have an IP to profile. */
export async function topIps(
  creds: { projectId: string; teamId: string; token: string },
  window: Window,
  limit: number,
): Promise<{ rows: [string, number][]; error?: string }> {
  const { ctx } = makeCtx(creds, window);
  try {
    return {
      rows: top(await metrics(ctx, ['clientIp'], { limit: 500 }), 'clientIp', limit),
    };
  } catch (e) {
    return { rows: [], error: errMsg(e) };
  }
}
