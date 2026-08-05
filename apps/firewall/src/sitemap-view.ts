// Lays out a SitemapReport as lines, shared by the CLI and the TUI pane.

import { type Line, blank, countRows, line, seg } from './line-model';
import type { SitemapDigest, SitemapReport } from './sitemap-readers';

const ENUMERATION_RATIO = 10; // page fetches per sitemap fetch before it reads as a walk

export type Verdict = {
  label: string;
  tone: 'good' | 'bad' | 'warn' | 'dim';
  note?: string;
};

/** True when the digest went on to walk `/company/` after reading a sitemap. */
function enumerated(d: SitemapDigest): boolean {
  return d.enriched && (d.companyPages ?? 0) > d.fetches * ENUMERATION_RATIO;
}

/**
 * A digest's standing. `shared` is the one that matters: scraper-shaped AND carrying verified
 * agents, because that is the combination a shape-only reading gets wrong, and denying it takes
 * the agents out with it.
 */
export function verdictOf(d: SitemapDigest): Verdict {
  // Imperative first: the side pane truncates, and the instruction must survive the cut.
  if (d.verifiedAs.length && enumerated(d))
    return {
      label: 'shared',
      tone: 'warn',
      note: `DO NOT DENY — shared client fingerprint, not one actor; carries verified ${d.verifiedAs.join(', ')}`,
    };
  if (d.verifiedAs.length)
    return {
      label: 'verified',
      tone: 'good',
      note: d.verifiedOffSitemap
        ? `verified in wider traffic (${d.verifiedAs.join(', ')}), not on the sitemap fetch itself`
        : undefined,
    };
  // Enumeration is evaluated BEFORE the deny label, and `denied` here comes from bare
  // FW_BLOCKED_JA4 membership — it says a digest is LISTED, not that the rule is active and set
  // to deny. Returning early on it dropped a fingerprint that is walking the catalogue right
  // now out of `walked`, and the pane printed the green all-clear over it.
  if (enumerated(d))
    return {
      label: 'ENUMERATED',
      tone: 'bad',
      note: d.denied
        ? 'listed in FW_BLOCKED_JA4 yet still enumerating — check the rule is active and set to deny'
        : undefined,
    };
  if (d.denied) return { label: 'denied', tone: 'dim' };
  return { label: 'unreviewed', tone: 'warn' };
}

function digestLines(d: SitemapDigest, isCursor: boolean): Line[] {
  const v = verdictOf(d);
  const out: Line[] = [
    line(
      seg(isCursor ? '▶ ' : '  ', 'key'),
      seg(v.label.toUpperCase().padEnd(11), v.tone),
      seg(d.ja4, isCursor ? 'bold' : 'key'),
      seg(`  ${d.fetches} sitemap fetch${d.fetches === 1 ? '' : 'es'}`, 'dim'),
    ),
  ];
  const pad = ' '.repeat(15);
  const detail: string[] = [
    `${d.ips.length} IP${d.ips.length === 1 ? '' : 's'}`,
  ];
  if (d.verifiedAs.length)
    detail.push(`verified as ${d.verifiedAs.join(', ')}`);
  if (d.enriched) {
    // The API under-reports groups at high cardinality, so say so rather than print a total that
    // is 200x low. The floors are still enough to convict — they can only understate.
    const ge = d.pathsPartial ? '≥' : '';
    detail.push(
      `${d.totalExact ? '' : ge}${d.total} req total`,
      `${ge}${d.companyPages} /company/`,
      `${ge}${d.subResources} sub-resources`,
      `${ge}${d.distinctPaths} paths`,
    );
    if (d.pathsPartial) detail.push('path sample truncated by the API');
  }
  out.push(line(seg(`${pad}${detail.join(' · ')}`, 'dim')));
  if (d.wafActions?.length)
    out.push(
      line(
        seg(
          `${pad}waf: ${d.wafActions.map(([a, n]) => `${a}=${n}`).join(' ')}`,
          'dim',
        ),
      ),
    );
  if (d.asns.length)
    out.push(line(seg(`${pad}${d.asns.slice(0, 4).join(', ')}`, 'dim')));
  if (v.note) out.push(line(seg(`${pad}${v.note}`, v.tone)));
  return out;
}

/** Full sitemap-reader layout. `cursor` indexes `r.digests`. */
export function sitemapLines(r: SitemapReport, cursor = -1): Line[] {
  const L: Line[] = [
    line(
      seg(`Sitemap readers — ${r.windowLabel}`, 'bold'),
      seg(`  (${r.start.slice(0, 16)}Z → ${r.end.slice(0, 16)}Z)`, 'dim'),
    ),
    line(
      `${r.fetches} fetches from ${r.ips} IPs across ${r.digests.length} TLS fingerprints`,
    ),
  ];

  const walked = r.digests.filter((d) => verdictOf(d).label === 'ENUMERATED');
  const shared = r.digests.filter((d) => verdictOf(d).label === 'shared');
  L.push(
    blank(),
    walked.length
      ? line(
          seg(
            `  ${walked.length} unverified fingerprint(s) read a sitemap then enumerated /company/`,
            'bad',
          ),
        )
      : line(
          seg('  nothing unverified went on to enumerate /company/', 'good'),
        ),
  );
  if (shared.length)
    L.push(
      line(
        seg(
          `  ${shared.length} scraper-shaped fingerprint(s) also carry verified agents — check before denying`,
          'warn',
        ),
      ),
    );

  L.push(
    blank(),
    line(
      seg('FINGERPRINTS', 'bold'),
      seg('   ↑↓ select · enter copies the digest', 'dim'),
    ),
  );
  r.digests.forEach((d, i) => L.push(...digestLines(d, i === cursor), blank()));

  if (r.verified.length) {
    L.push(line(seg('VERIFIED CRAWLERS', 'bold')));
    L.push(...countRows(r.verified, 12));
    L.push(blank());
  }

  L.push(line(seg('SHARDS FETCHED', 'bold')), ...countRows(r.paths, 12));

  if (r.errors.length) {
    L.push(blank(), line(seg('INCOMPLETE', 'bold')));
    L.push(...r.errors.map((e) => line(seg(`  ${e}`, 'warn'))));
  }
  return L;
}
