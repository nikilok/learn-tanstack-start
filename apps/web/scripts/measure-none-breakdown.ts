/**
 * Why did a searched company produce NOTHING?
 *
 * Decomposes the `none` rows of the most recent search-discovery writes using
 * the candidates those runs banked, so it costs no Serper credits: only polite
 * re-fetches. The reconstruction mirrors production probing exactly — every
 * origin up to five is fetched and aggregator status is judged on the
 * POST-redirect host, as probeOrigin does — so what is classified is what the
 * pipeline actually saw.
 *
 * THE COHORT IS POSITIONAL: the latest --limit rows by discovered_at. Run it
 * before any further discovery writes, or the window silently shifts to a
 * different population. The printed discovered_at range and evidence split are
 * there to verify the cohort is the run you mean. Undecided rows (banked,
 * status still `pending`) are reported and excluded — they are not `none`.
 *
 * Buckets, in decision order per row:
 *   no_candidates   search returned nothing usable at all
 *   all_aggregator  every reachable candidate is a directory or parked page
 *   all_dead        no candidate would fetch at all
 *   own_no_signals  a page that LOOKS like the company's own site was the one
 *                   production walked, and carries neither statutory signal
 *   own_lower_rank  an own-looking site sat below the candidate prod walked;
 *                   the five production walk paths are checked here for the
 *                   number, measuring the true cost of walking rank-1 only
 *   no_ownership    pages fetched fine but nothing looks like the company —
 *                   no site, a site search missed, or a JS shell (flagged)
 *
 * Ownership is estimated with Gemma owner-extraction plus name overlap against
 * current AND previous names — diagnostic only, never written anywhere. This
 * script never writes to the database. Run from monorepo root:
 *
 *   bun apps/web/scripts/measure-none-breakdown.ts
 *   bun apps/web/scripts/measure-none-breakdown.ts --limit=60 --no-gemma
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { candidateOrigins } from '../src/lib/websites/discover.ts';
import {
  companyNumberVariants,
  pageHasCompanyNumber,
  visibleText,
} from '../src/lib/websites/extract.ts';
import { DISCLOSURE_PATHS } from '../src/lib/websites/fetch-policy.ts';
import {
  isAggregatorHost,
  looksParked,
} from '../src/lib/websites/page-signals.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';
import { fetchSite } from './lib/web-fetch.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const useGemma = !args.includes('--no-gemma');
const limit = parseStrictInt(flag('limit') ?? '40', 'limit');
const DELAY_MS = 250;
/** Mirrors production: probeOrigin fetches every origin in the top five. */
const MAX_ORIGINS = 5;
/** Mirrors production's walk cap in discover-websites-search.ts. */
const WALK_PATHS = DISCLOSURE_PATHS.slice(0, 5);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const sql = neon(process.env.POSTGRES_URL as string);

/** Generic UK postcode shape — ANY postcode, not the registered one. */
const ANY_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;
/** A registration disclosure and the number it carries. */
const CRN_DISCLOSURE =
  /\b(?:COMPANY|REGISTERED|REG)\.?\s*(?:NO|NUMBER)\.?:?\s*#?\s*((?:SC|NI|OC)?\d{6,8})\b/g;

/**
 * The own number with MORE zeros dropped than the detector tolerates.
 * pageHasCompanyNumber accepts one dropped zero; a match on these forms is a
 * disclosure the pipeline structurally cannot see — a real recoverable miss,
 * which must not be reported as another company's number.
 */
function depaddedBlindForms(companyNumber: string): string[] {
  if (!/^\d{8}$/.test(companyNumber)) return [];
  const stripped = companyNumber.replace(/^0+/, '');
  return stripped.length === 6 ? [stripped] : [];
}

const STOP = new Set([
  'the',
  'and',
  'of',
  'for',
  'a',
  'an',
  'in',
  'to',
  'ltd',
  'limited',
  'plc',
  'llp',
  'company',
  'companies',
  'group',
  'holdings',
  'uk',
  'services',
  'service',
]);
const words = (s: string): Set<string> =>
  new Set(
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
const overlap = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const w of small) if (big.has(w)) hit += 1;
  return hit / small.size;
};

type NoneRow = {
  companyNumber: string;
  companyName: string;
  prevNames: string[];
  candidates: string[];
};

const raw = (await sql`
  SELECT x.company_number, x.candidates, x.status, x.evidence, x.discovered_at,
         coalesce(p.company_name, '') AS company_name,
         p.previous_company_names
  FROM (
    SELECT company_number, candidates, status, evidence, discovered_at
    FROM company_websites WHERE source = 'search'
    ORDER BY discovered_at DESC LIMIT ${limit}
  ) x
  JOIN companies_house_profiles p USING (company_number)
  ORDER BY x.company_number
`) as {
  company_number: string;
  candidates: unknown;
  status: string;
  evidence: string;
  discovered_at: Date;
  company_name: string;
  previous_company_names: string[] | null;
}[];

const stamps = raw.map((r) => new Date(r.discovered_at).getTime());
const windowFrom = new Date(Math.min(...stamps)).toISOString();
const windowTo = new Date(Math.max(...stamps)).toISOString();
const split = new Map<string, number>();
for (const r of raw) {
  const key = r.status === 'pending' ? 'pending (excluded)' : r.evidence;
  split.set(key, (split.get(key) ?? 0) + 1);
}

// Decided `none` only. A banked row still at `pending` was never settled —
// production retries it for free, and counting it here would report a
// retryable outage as permanent absence.
const cohort: NoneRow[] = raw
  .filter((r) => r.evidence === 'none' && r.status === 'none')
  .map((r) => ({
    companyNumber: r.company_number,
    companyName: r.company_name,
    prevNames: r.previous_company_names ?? [],
    candidates: Array.isArray(r.candidates) ? (r.candidates as string[]) : [],
  }));

console.log(
  `Decomposing the none bucket — db ${dbFingerprint(process.env.POSTGRES_URL)}`,
);
console.log(
  `  cohort: latest ${raw.length} search rows, discovered ${windowFrom} → ${windowTo}`,
);
console.log(
  `  split : ${[...split.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`,
);
console.log(
  `  none rows: ${cohort.length}  gemma: ${useGemma ? 'on' : 'off'}\n`,
);

type PageLook = {
  origin: string;
  ok: boolean;
  /** Judged on the POST-redirect host, exactly as production probeOrigin does. */
  aggregator: boolean;
  parked: boolean;
  /** Big HTML, almost no visible text: a client-rendered shell. */
  shellish: boolean;
  text: string;
  anyPostcode: boolean;
  crnNumbers: string[];
};

async function look(origin: string): Promise<PageLook> {
  const fetched = await fetchSite(origin);
  if (!fetched.ok) {
    return {
      origin,
      ok: false,
      aggregator: false,
      parked: false,
      shellish: false,
      text: '',
      anyPostcode: false,
      crnNumbers: [],
    };
  }
  const host = (() => {
    try {
      return new URL(fetched.url).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  const text = visibleText(fetched.html);
  const upper = text.toUpperCase();
  return {
    origin,
    ok: true,
    aggregator: isAggregatorHost(host),
    parked: looksParked(text),
    shellish: text.length < 300 && fetched.html.length > 30_000,
    text:
      text.length > 2800
        ? `${text.slice(0, 1500)}\n…\n${text.slice(-1300)}`
        : text,
    anyPostcode: ANY_POSTCODE.test(upper),
    crnNumbers: [...upper.matchAll(CRN_DISCLOSURE)].map((m) => m[1]),
  };
}

// Gemma is loaded lazily so --no-gemma never touches Playwright.
let gemma: {
  ask(p: string, s: string): Promise<{ text: string }>;
  stop(): Promise<void>;
} | null = null;
if (useGemma) {
  const { createPlaywrightGemmaClient } =
    await import('./lib/gemma-host-playwright.ts');
  gemma = await createPlaywrightGemmaClient();
}
const OWNER_SYSTEM = `You read a web page and report what it says about itself.
Return JSON only: {"owner":"<organisation whose website this is>"}
"owner" is whose site this is, not who the page talks about.`;

/** Best estimate of whether this page belongs to the company. */
async function ownScore(row: NoneRow, page: PageLook): Promise<number> {
  const names = [row.companyName, ...row.prevNames].map(words);
  let extracted = '';
  if (gemma) {
    try {
      const a = await gemma.ask(
        `Page URL: ${page.origin}\n\nPage text:\n${page.text}`,
        OWNER_SYSTEM,
      );
      const m = a.text.match(/\{[\s\S]*\}/);
      extracted = m ? String(JSON.parse(m[0]).owner ?? '') : '';
    } catch {
      extracted = '';
    }
  }
  const source = extracted || page.text.slice(0, 600);
  const sourceWords = words(source);
  return Math.max(...names.map((n) => overlap(sourceWords, n)));
}

/** Disclosure flags for one page, separating the padding-blind own number. */
function crnFlags(row: NoneRow, page: PageLook): string[] {
  if (page.crnNumbers.length === 0) return [];
  const own = new Set(companyNumberVariants(row.companyNumber));
  const blind = new Set(depaddedBlindForms(row.companyNumber));
  const flags: string[] = [];
  if (page.crnNumbers.some((c) => blind.has(c))) {
    flags.push('OWN-CRN-DEPADDED-MISS');
  }
  if (page.crnNumbers.some((c) => !own.has(c) && !blind.has(c))) {
    flags.push('other-crn');
  }
  return flags;
}

type Verdict = { row: NoneRow; bucket: string; detail: string };
const verdicts: Verdict[] = [];

for (const row of cohort) {
  const origins = candidateOrigins(row.candidates).slice(0, MAX_ORIGINS);
  if (origins.length === 0) {
    verdicts.push({ row, bucket: 'no_candidates', detail: '' });
    continue;
  }

  const pages: PageLook[] = [];
  for (const origin of origins) {
    await sleep(DELAY_MS);
    pages.push(await look(origin));
  }
  const reachable = pages.filter((p) => p.ok);
  if (reachable.length === 0) {
    verdicts.push({
      row,
      bucket: 'all_dead',
      detail: `${pages.length} candidates, none fetch`,
    });
    continue;
  }
  const usable = reachable.filter((p) => !p.aggregator && !p.parked);
  if (usable.length === 0) {
    const agg = reachable.filter((p) => p.aggregator).length;
    const parked = reachable.filter((p) => p.parked).length;
    verdicts.push({
      row,
      bucket: 'all_aggregator',
      detail: `${agg} directories, ${parked} parked, ${pages.length - reachable.length} dead`,
    });
    continue;
  }

  // The candidate production's walk ran on: the first usable one, in rank order.
  const walked = usable[0];
  let best: { page: PageLook; score: number } | null = null;
  for (const page of usable) {
    const score = await ownScore(row, page);
    if (!best || score > best.score) best = { page, score };
  }

  if (!best || best.score < 0.5) {
    const shells = usable.filter((p) => p.shellish).map((p) => p.origin);
    verdicts.push({
      row,
      bucket: 'no_ownership',
      detail: `best own-score ${best ? best.score.toFixed(2) : '-'}${
        shells.length ? `  [js-shell: ${shells.join(' ')}]` : ''
      }`,
    });
    continue;
  }

  if (best.page.origin === walked.origin) {
    const flags = [
      best.page.shellish ? 'js-shell' : '',
      best.page.anyPostcode ? 'other-postcode' : '',
      ...crnFlags(row, best.page),
    ]
      .filter(Boolean)
      .join(',');
    verdicts.push({
      row,
      bucket: 'own_no_signals',
      detail: `${best.page.origin}${flags ? `  [${flags}]` : ''}`,
    });
    continue;
  }

  // Own-looking site below the walked candidate. Check the SAME five paths a
  // production walk would have, so 0 hits genuinely means escalation buys
  // nothing rather than "the two paths we tried were bare".
  let crnAt: string | null = null;
  for (const path of WALK_PATHS) {
    await sleep(DELAY_MS);
    const fetched = await fetchSite(`${best.page.origin}${path}`);
    if (fetched.ok && pageHasCompanyNumber(fetched.html, row.companyNumber)) {
      crnAt = fetched.url;
      break;
    }
  }
  verdicts.push({
    row,
    bucket: crnAt ? 'own_lower_rank_CRN_MISSED' : 'own_lower_rank',
    detail: crnAt ?? best.page.origin,
  });
}

if (gemma) await gemma.stop().catch(() => {});

console.log(`${'bucket'.padEnd(26)} company / detail`);
console.log('-'.repeat(100));
for (const v of verdicts) {
  console.log(
    `${v.bucket.padEnd(26)} ${v.row.companyName.slice(0, 40).padEnd(42)} ${v.detail}`,
  );
}

console.log(`\n─── decomposition of ${verdicts.length} none rows ───`);
const buckets = [...new Set(verdicts.map((v) => v.bucket))].sort();
for (const b of buckets) {
  const count = verdicts.filter((v) => v.bucket === b).length;
  console.log(
    `  ${b.padEnd(26)} ${String(count).padStart(3)}  ${((count / verdicts.length) * 100).toFixed(0)}%`,
  );
}
