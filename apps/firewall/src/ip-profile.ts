// Data layer for `firewall:ip` — everything about one client IP that bears on "scraper or human".
// Read-only by design: this reports, it never bans (see the watch-branch post-mortem).

import type { Reach } from './ban-advice';
import { JA4_DENY } from './deny-list';
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
  countOf,
  makeCtx,
  metrics,
  pool,
  ruleNames,
  safeIp,
  seriesBy,
  top,
} from './observability';
import type { Window } from './time-window';
import { errMsg } from './util';

// 10-minute buckets resolve a session; hourly hides it. Past 2 days that is too many rows to read.
const FINE_BUCKET_HOURS = 48;
// The observability API's hard groupBy cap. At it, the tail is silently dropped.
const GROUP_CAP = 500;
/**
 * Reach is ALWAYS measured over at least this long, whatever window the operator picked for the
 * subject. The safety test asks whether a real browser has ever rendered from this identity, and
 * a short window manufactures the absence that clears a blanket deny. Urgency gets a short
 * window; safety never does.
 */
const REACH_MIN_HOURS = 144;

/**
 * Bucket size for the session series. The API needs start/end to be multiples of the bucket, so
 * 10-minute buckets only require the window's own alignment to be a multiple of 10 — an
 * hour-aligned range already is. Taking `max(granularity, …)` instead pinned every window over 2h
 * to 60-minute buckets and inflated the pacing tell: over 6h that is 6 buckets, so a person
 * touching the site in 4 separate hours reads as busy 67% of the time, which is one of the two
 * independent axes a ban needs.
 */
export function bucketMinutesFor(
  hours: number,
  granularityMinutes: number,
): number {
  return hours <= FINE_BUCKET_HOURS && granularityMinutes % 10 === 0 ? 10 : 60;
}

/** What is being profiled. A JA4 digest is the handle that survives IP rotation, so it gets the same view. */
export type Subject = { kind: 'ip' | 'ja4'; value: string };

/** The observability dimension and filter for a subject. */
export function subjectDim(s: Subject): string {
  return s.kind === 'ip' ? 'clientIp' : 'clientJa4Digest';
}
export function subjectFilter(s: Subject): string {
  return `${subjectDim(s)} eq '${s.value}'`;
}

export type IpProfile = {
  subject: Subject;
  ip: string; // the subject's value, kept for the header and tab label
  start: string;
  end: string;
  windowHours: number;
  windowLabel: string;
  /** When this snapshot was taken. A profile is a still, even when the window says "live". */
  fetchedAt: string;
  total: number;
  byStatus: [string, number][];
  byUserAgent: [string, number][];
  byJa4: [string, number][];
  byIp: [string, number][]; // the interesting axis when the subject IS a fingerprint
  byAsn: [string, number][];
  byCountry: [string, number][];
  byBot: [string, number][]; // botVerified|botName|botCategory, for display
  byBotVerified: [string, number][]; // botVerified alone — the field that overrides other tells
  byWafAction: [string, number][];
  byWafRule: [string, number][];
  byPath: [string, number][];
  byReferrer: [string, number][];
  mix: Mix;
  /** True when byPath hit the 500-group cap, so every count in `mix` is a floor. The rendering
   * counts are the ones that matter: a dropped /assets or /_serverFn tail reads as an affirmative
   * zero, which is the absence-of-evidence error the reach `complete` flag exists to prevent. */
  mixPartial: boolean;
  shape: Shape;
  buckets: { t: string; c: number }[]; // zero-filled series behind `shape`
  tells: Tell[];
  // What the dominant fingerprint and network do BEYOND this IP. Without these a deny
  // recommendation cannot tell a single automated host from a shared identity that real
  // browsers, verified agents or our own services also use.
  digestReach?: Reach;
  asnReach?: Reach;
  /** Hours the reach queries covered — never shorter than REACH_MIN_HOURS. */
  reachHours: number;
  errors: string[];
  /** Labels of the queries that degraded to []. The advisory needs these by name: a blocker fed
   * by a failed lookup is silently absent, which reads as "this client is clean". */
  failedQueries: string[];
};

/** One grouped query, degraded to [] plus an error note rather than failing the whole profile. */
async function group(
  ctx: Ctx,
  errors: string[],
  label: string,
  dims: string[],
  filter: string,
  event?: string,
  failed?: string[],
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
        return [key || '(none)', countOf(r)] as [string, number];
      })
      .sort((a, b) => b[1] - a[1]);
  } catch (e) {
    errors.push(`${label}: ${errMsg(e)}`);
    failed?.push(label);
    return [];
  }
}

/** Profile one IP over the last `hours`. Fans out one grouped query per dimension plus a bucket series, then scores the result with the pure tells. */
export async function fetchIpProfile(
  creds: { projectId: string; teamId: string; token: string },
  subject: Subject,
  window: Window,
): Promise<IpProfile> {
  const ip = subject.value;
  if (subject.kind === 'ip' && !safeIp(ip))
    throw new Error(`"${ip}" is not a valid IP address`);
  if (subject.kind === 'ja4' && !JA4_DENY.valid(ip.toLowerCase()))
    throw new Error(`"${ip}" is not a JA4 digest`);
  const hours = window.hours;
  const { ctx } = makeCtx(creds, window);
  const dim = subjectDim(subject);
  const filter = subjectFilter(subject);
  // Separate context: the subject's behaviour is a "what is happening now" question, its
  // identity's character is not.
  const { ctx: reachCtx } = makeCtx(
    creds,
    hours >= REACH_MIN_HOURS ? window : { hours: REACH_MIN_HOURS },
  );
  const errors: string[] = [];
  const failedQueries: string[] = [];
  const g = (label: string, dims: string[], event?: string) => () =>
    group(ctx, errors, label, dims, filter, event, failedQueries);

  const [
    byStatus,
    byUserAgent,
    byJa4,
    byIp,
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
      g('ips', ['clientIp']),
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

  const bucketMinutes = bucketMinutesFor(hours, window.granularityMinutes);
  let buckets: { t: string; c: number }[] = [];
  try {
    buckets =
      seriesBy(
        await metrics(ctx, [dim], {
          filter,
          limit: 500,
          granularity: { minutes: bucketMinutes },
        }),
        dim,
      ).get(ip) ?? [];
  } catch (e) {
    errors.push(`series: ${errMsg(e)}`);
    failedQueries.push('series');
  }

  // Rule ids are opaque; label them, but never fail the profile over a missing label.
  // The first-party blocker keys on rule NAMES, so a failed lookup silently deletes it. Say so
  // rather than leaving opaque ids that quietly match nothing.
  let byWafRule = wafRuleRows;
  if (wafRuleRows.length) {
    try {
      const names = await ruleNames(ctx);
      const labelled = wafRuleRows.map(
        ([id, c]) => [names.get(id) ?? id, c] as [string, number],
      );
      if (!names.size || labelled.some(([n]) => n.startsWith('rule_'))) {
        errors.push(
          'waf rule names: lookup failed — rules show as opaque ids, so the first-party allow-rule check cannot run',
        );
        failedQueries.push('waf rule names');
      }
      byWafRule = labelled;
    } catch (e) {
      errors.push(`waf rule names: ${errMsg(e)}`);
      failedQueries.push('waf rule names');
    }
  }

  // What an identity does BEYOND this IP. Both levers need it: a deny is only safe when nothing
  // else riding the same handle has ever rendered a page.
  const reachOf = async (
    label: string,
    filter: string,
  ): Promise<Reach | undefined> => {
    // Tracked per query: group() degrades a failure to [], which is indistinguishable from a
    // genuine zero. A safety test that clears a blanket deny must never read absence as measured.
    const failed: string[] = [];
    const run = async (what: string, dims: string[]) => {
      const before = errors.length;
      const rows = await group(
        reachCtx,
        errors,
        `reach ${what} ${label}`,
        dims,
        filter,
      );
      if (errors.length > before) failed.push(what);
      return rows;
    };
    const [ips, countries, bots, paths] = await pool(
      [
        () => run('ips', ['clientIp']),
        () => run('geo', ['clientIpCountry']),
        () => run('bots', ['botVerified', 'botName']),
        () => run('paths', ['requestPath']),
      ],
      4,
    );
    // Undefined reach already refuses a lever (qualifyLever calls it "reach unknown"), but the
    // reason matters: "this identity has no traffic" and "the lookup for it failed" are
    // different facts and only one of them is about the client.
    if (!ips.length) {
      if (failed.length) failedQueries.push(`reach ${label}`);
      return undefined;
    }
    const kinds = mixOf(paths);
    const total = ips.reduce((s, [, c]) => s + c, 0);
    // The path grouping is capped at 500 groups, so a busy identity's tail — including its
    // /assets, /fonts and /_vercel/insights rows — is silently dropped. Detect it the same way
    // sitemap-readers does, by comparing the sample against the exact per-IP total.
    const pathsTruncated = paths.length >= GROUP_CAP || kinds.total < total;
    return {
      label,
      ips: ips.length,
      countries: countries.length,
      total,
      subResources: kinds.asset,
      beacons: kinds.beacon,
      tiles: kinds.tile,
      rpcs: kinds.rpc,
      complete: failed.length === 0 && !pathsTruncated,
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
  // Same detection reachOf and the sitemap pane already do. byStatus is low-cardinality and so
  // exact; byPath is not, so a busy identity's low-count sub-resource rows fall off the tail.
  const mixPartial = byPath.length >= GROUP_CAP || mix.total < total;
  // Vercel leaves botVerified blank for everything it has not verified; only `pass` counts.
  const byBotVerified = byBotVerifiedRaw.filter(
    ([v]) => v && v !== '(none)' && v !== 'undefined',
  );

  return {
    subject,
    ip,
    start: ctx.startTime,
    end: ctx.endTime,
    windowHours: hours,
    windowLabel: window.label,
    fetchedAt: new Date().toISOString(),
    total,
    byStatus,
    byUserAgent,
    byJa4,
    byIp,
    byAsn,
    byCountry,
    byBot,
    byBotVerified,
    byWafAction,
    byWafRule,
    byPath,
    byReferrer,
    mix,
    mixPartial,
    shape,
    buckets,
    digestReach,
    asnReach,
    reachHours: Math.max(hours, REACH_MIN_HOURS),
    failedQueries,
    tells: tellsFor({
      total,
      mix,
      shape,
      ja4: byJa4,
      userAgents: byUserAgent,
      asns: byAsn,
      countries: byCountry,
      botVerified: byBotVerified,
      distinctPaths: byPath.length,
      windowMinutes: hours * 60,
    }),
    errors,
  };
}

/** Top JA4 digests by volume — the entry point when the fingerprint is the handle, which it usually is. */
export async function topJa4(
  creds: { projectId: string; teamId: string; token: string },
  window: Window,
  limit: number,
): Promise<{ rows: [string, number][]; error?: string }> {
  const { ctx } = makeCtx(creds, window);
  try {
    return {
      rows: top(
        await metrics(ctx, ['clientJa4Digest'], { limit: 500 }),
        'clientJa4Digest',
        limit,
      ).filter(([d]) => d && d !== '?'),
    };
  } catch (e) {
    return { rows: [], error: errMsg(e) };
  }
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
      rows: top(
        await metrics(ctx, ['clientIp'], { limit: 500 }),
        'clientIp',
        limit,
      ),
    };
  } catch (e) {
    return { rows: [], error: errMsg(e) };
  }
}
