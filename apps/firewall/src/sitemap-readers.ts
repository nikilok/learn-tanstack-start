// Who reads the sitemaps, and what they did next. A sitemap fetch is how an enumeration run
// starts, so this is the cheapest tripwire we have — but most readers are search engines, so the
// answer is only useful once verified bots and already-denied fingerprints are separated out.

import { readdirSync } from 'node:fs';

import { JA4_DENY, envMatching } from './deny-list';
import {
  type Ctx,
  makeCtx,
  metrics,
  pool,
} from './observability';
import { errMsg } from './util';

// Enriching every digest would be one query each; the tail is single-fetch noise.
const MAX_ENRICHED = 10;
const SHARD_FALLBACK = 10; // used only when the public dir cannot be read

export type SitemapDigest = {
  ja4: string;
  fetches: number; // sitemap fetches in the window
  ips: string[]; // IPs seen fetching a sitemap on this digest
  asns: string[];
  denied: boolean; // listed in FW_BLOCKED_JA4
  verifiedAs: string[]; // verified bot names carried on this digest
  // True when verification was found only in the digest's WIDER traffic, not its sitemap fetches.
  // A digest can be scraper-shaped and still carry verified agents; denying it takes them out too.
  verifiedOffSitemap: boolean;
  enriched: boolean; // false when the follow-up query was skipped or failed
  // From the low-cardinality wafAction grouping, which is exact. The per-path grouping is NOT:
  // above a few hundred groups the API under-reports, so path-derived counts are floors.
  total?: number;
  companyPages?: number; // floor when pathsPartial
  subResources?: number; // floor when pathsPartial
  distinctPaths?: number; // floor when pathsPartial
  pathsPartial?: boolean; // path sample covers less than `total`
  wafActions?: [string, number][]; // so a denied digest reads as attempts, not successes
};

export type SitemapReport = {
  start: string;
  end: string;
  windowHours: number;
  fetches: number;
  ips: number;
  paths: [string, number][]; // which sitemap shards were fetched
  verified: [string, number][]; // botName -> fetches, the benign majority
  digests: SitemapDigest[]; // ranked: unreviewed first, then denied, then verified
  errors: string[];
};

/** The sitemap URLs to watch. Read from the web app's public dir so a new shard is picked up automatically; falls back to a fixed range when that is not readable (CI, fresh clone). */
export function sitemapPaths(): string[] {
  try {
    const dir = new URL('../../web/public/', import.meta.url);
    const found = readdirSync(dir)
      .filter((f) => /^sitemap[\w-]*\.xml$/.test(f))
      .map((f) => `/${f}`);
    if (found.length) return found.sort();
  } catch {
    // fall through to the fixed range
  }
  return [
    '/sitemap.xml',
    ...Array.from({ length: SHARD_FALLBACK }, (_, i) => `/sitemap-${i}.xml`),
  ];
}

type Row = [string[], number];

/** Grouped query returning [dimension values, count] rows sorted desc. */
async function group(
  ctx: Ctx,
  errors: string[],
  label: string,
  dims: string[],
  filter: string,
): Promise<Row[]> {
  try {
    const resp = await metrics(ctx, dims, { filter, limit: 500 });
    return (resp.summary ?? [])
      .map((r) => {
        const v = r.count_sum as unknown;
        const n =
          v && typeof v === 'object'
            ? ((v as { value?: number; sum?: number }).value ??
              (v as { sum?: number }).sum ??
              0)
            : Number(v ?? 0);
        return [
          dims.map((d) => String(r[d] ?? '').trim()),
          Number.isFinite(n) ? n : 0,
        ] as Row;
      })
      .sort((a, b) => b[1] - a[1]);
  } catch (e) {
    errors.push(`${label}: ${errMsg(e)}`);
    return [];
  }
}

/** Sitemap readers over the last `hours`, split by verified status and enriched with what each unverified fingerprint did across the whole window. */
export async function fetchSitemapReport(
  creds: { projectId: string; teamId: string; token: string },
  hours: number,
): Promise<SitemapReport> {
  const { ctx } = makeCtx(creds, { hours });
  const errors: string[] = [];
  const paths = sitemapPaths();
  const filter = `requestPath in (${paths.map((p) => `'${p}'`).join(',')})`;

  // Not required: a missing denylist just means nothing is marked as already-denied.
  let denied = new Set<string>();
  try {
    denied = new Set(envMatching('FW_BLOCKED_JA4', JA4_DENY, false));
  } catch (e) {
    errors.push(`denylist: ${errMsg(e)}`);
  }

  const [shardRows, ipRows, verifiedRows] = await pool(
    [
      () => group(ctx, errors, 'shards', ['requestPath'], filter),
      () =>
        group(
          ctx,
          errors,
          'readers',
          ['clientJa4Digest', 'clientIp', 'asnName', 'botVerified', 'botName'],
          filter,
        ),
      () => group(ctx, errors, 'verified', ['botName'], filter),
    ],
    3,
  );

  const byDigest = new Map<string, SitemapDigest>();
  let fetches = 0;
  const allIps = new Set<string>();
  for (const [[ja4, ip, asn, botVerified, botName], count] of ipRows) {
    fetches += count;
    allIps.add(ip);
    const key = ja4 || '(none)';
    const d = byDigest.get(key) ?? {
      ja4: key,
      fetches: 0,
      ips: [],
      asns: [],
      denied: denied.has(key),
      verifiedAs: [],
      verifiedOffSitemap: false,
      enriched: false,
    };
    d.fetches += count;
    if (!d.ips.includes(ip)) d.ips.push(ip);
    if (asn && !d.asns.includes(asn)) d.asns.push(asn);
    if (botVerified === 'pass' && botName && !d.verifiedAs.includes(botName))
      d.verifiedAs.push(botName);
    byDigest.set(key, d);
  }

  // Unreviewed first — a digest carrying no verified bot and no deny is the only one that needs
  // a decision. Denied ones rank next so a ban that stopped holding is still visible.
  const rank = (d: SitemapDigest) =>
    d.verifiedAs.length ? 2 : d.denied ? 1 : 0;
  const digests = [...byDigest.values()].sort(
    (a, b) => rank(a) - rank(b) || b.fetches - a.fetches,
  );

  // Enrich the ones a decision might hinge on. Verified digests are skipped: their behaviour is
  // not in question, and each enrichment is another query.
  const toEnrich = digests
    .filter((d) => !d.verifiedAs.length && d.ja4 !== '(none)')
    .slice(0, MAX_ENRICHED);
  await pool(
    toEnrich.map((d) => async () => {
      const f = `clientJa4Digest eq '${d.ja4}'`;
      const tag = d.ja4.slice(0, 12);
      // Nested pool is safe: observability.gated caps concurrency process-wide, not per call site.
      const [rows, botRows, wafRows] = await pool(
        [
          () => group(ctx, errors, `paths ${tag}`, ['requestPath'], f),
          () => group(ctx, errors, `bots ${tag}`, ['botVerified', 'botName'], f),
          () => group(ctx, errors, `waf ${tag}`, ['wafAction'], f),
        ],
        3,
      );
      // Checked across ALL of the digest's traffic, not just its sitemap fetches: a shared
      // client fingerprint can look like a scraper here and still be carrying verified agents.
      for (const [[verified, name]] of botRows)
        if (verified === 'pass' && name && !d.verifiedAs.includes(name)) {
          d.verifiedAs.push(name);
          d.verifiedOffSitemap = true;
        }
      if (wafRows.length)
        d.wafActions = wafRows.map(([[a], n]) => [a || 'none', n]);
      if (!rows.length) return;
      d.enriched = true;
      const pathSum = rows.reduce((s, [, n]) => s + n, 0);
      const wafSum = wafRows.reduce((s, [, n]) => s + n, 0);
      d.total = wafSum || pathSum;
      d.pathsPartial = pathSum < d.total;
      d.distinctPaths = rows.length;
      d.companyPages = rows
        .filter(([[p]]) => p.startsWith('/company/'))
        .reduce((s, [, n]) => s + n, 0);
      d.subResources = rows
        .filter(([[p]]) =>
          p.startsWith('/assets/') ||
          p.startsWith('/fonts/') ||
          p.startsWith('/_vercel/'),
        )
        .reduce((s, [, n]) => s + n, 0);
    }),
    4,
  );

  // Re-rank: enrichment can move a digest into the verified bucket, and the ordering above ran
  // before that was known.
  digests.sort((a, b) => rank(a) - rank(b) || b.fetches - a.fetches);

  return {
    start: ctx.startTime,
    end: ctx.endTime,
    windowHours: hours,
    fetches,
    ips: allIps.size,
    paths: shardRows.map(([[p], n]) => [p, n]),
    verified: verifiedRows
      .filter(([[name]]) => name)
      .map(([[name], n]) => [name, n]),
    digests,
    errors,
  };
}
