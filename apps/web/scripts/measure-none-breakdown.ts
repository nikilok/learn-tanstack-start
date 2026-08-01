/**
 * Why did a searched company produce NOTHING?
 *
 * On the first representative yield sample, 70% of rows (28/40) ended at
 * `none` — far more than the ~19% that search recall (80.7%@5) can explain.
 * This script decomposes that bucket using the candidates the run already
 * banked, so it costs no Serper credits: only polite re-fetches.
 *
 * Buckets, in decision order per row:
 *   no_candidates   search returned nothing usable at all
 *   all_aggregator  every candidate is a directory/profile — the classic
 *                   signature of a company with no website
 *   all_dead        candidate sites exist but none would fetch
 *   own_no_signals  a page that LOOKS like the company's own site was probed
 *                   and walked, and carries neither statutory signal — the
 *                   "unverifiable third" measured at 35.3% of live sites
 *   own_lower_rank  an own-looking site sat below the candidate prod walked;
 *                   its privacy pages are checked here for the number, which
 *                   measures the cost of walking rank-1 only
 *   no_ownership    pages fetched fine but nothing looks like the company
 *
 * Ownership is estimated with Gemma owner-extraction (measured 15/16) plus
 * name overlap against current AND previous names — diagnostic only, never
 * written anywhere. Run from monorepo root:
 *
 *   bun apps/web/scripts/measure-none-breakdown.ts
 *   bun apps/web/scripts/measure-none-breakdown.ts --no-gemma
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { candidateOrigins } from '../src/lib/websites/discover.ts';
import {
  pageHasCompanyNumber,
  visibleText,
} from '../src/lib/websites/extract.ts';
import {
  isAggregatorHost,
  looksParked,
} from '../src/lib/websites/page-signals.ts';
import { loadScriptEnv } from './lib/script-utils.ts';
import { fetchSite } from './lib/web-fetch.ts';

loadScriptEnv(import.meta.url);

const useGemma = !process.argv.includes('--no-gemma');
const DELAY_MS = 250;
const MAX_NON_AGG = 3;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const sql = neon(process.env.POSTGRES_URL as string);

/** Generic UK postcode shape — ANY postcode, not the registered one. */
const ANY_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;
/** A registration disclosure carrying some OTHER number. */
const OTHER_CRN =
  /\b(?:COMPANY|REGISTERED|REG)\.?\s*(?:NO|NUMBER)\.?:?\s*#?\s*(?:SC|NI|OC)?\d{6,8}\b/;

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

const rows = (await sql`
  SELECT x.company_number, x.candidates,
         coalesce(p.company_name, '') AS company_name,
         p.previous_company_names
  FROM (
    SELECT company_number, candidates, evidence
    FROM company_websites WHERE source = 'search'
    ORDER BY discovered_at DESC LIMIT 40
  ) x
  JOIN companies_house_profiles p USING (company_number)
  WHERE x.evidence = 'none'
  ORDER BY x.company_number
`) as {
  company_number: string;
  candidates: unknown;
  company_name: string;
  previous_company_names: string[] | null;
}[];

const cohort: NoneRow[] = rows.map((r) => ({
  companyNumber: r.company_number,
  companyName: r.company_name,
  prevNames: r.previous_company_names ?? [],
  candidates: Array.isArray(r.candidates) ? (r.candidates as string[]) : [],
}));

console.log(
  `Decomposing the none bucket — db ${dbFingerprint(process.env.POSTGRES_URL)}`,
);
console.log(`  rows: ${cohort.length}  gemma: ${useGemma ? 'on' : 'off'}\n`);

type PageLook = {
  origin: string;
  ok: boolean;
  parked: boolean;
  /** Big HTML, almost no visible text: a client-rendered shell. */
  shellish: boolean;
  text: string;
  anyPostcode: boolean;
  otherCrn: boolean;
};

async function look(origin: string): Promise<PageLook> {
  const fetched = await fetchSite(origin);
  if (!fetched.ok) {
    return {
      origin,
      ok: false,
      parked: false,
      shellish: false,
      text: '',
      anyPostcode: false,
      otherCrn: false,
    };
  }
  const text = visibleText(fetched.html);
  const upper = text.toUpperCase();
  return {
    origin,
    ok: true,
    parked: looksParked(text),
    shellish: text.length < 300 && fetched.html.length > 30_000,
    text:
      text.length > 2800
        ? `${text.slice(0, 1500)}\n…\n${text.slice(-1300)}`
        : text,
    anyPostcode: ANY_POSTCODE.test(upper),
    otherCrn: OTHER_CRN.test(upper),
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

type Verdict = {
  row: NoneRow;
  bucket: string;
  detail: string;
};

const verdicts: Verdict[] = [];

for (const row of cohort) {
  const origins = candidateOrigins(row.candidates).slice(0, 5);
  if (origins.length === 0) {
    verdicts.push({ row, bucket: 'no_candidates', detail: '' });
    continue;
  }
  const nonAgg = origins.filter((o) => {
    try {
      return !isAggregatorHost(new URL(o).host.toLowerCase());
    } catch {
      return false;
    }
  });
  if (nonAgg.length === 0) {
    verdicts.push({
      row,
      bucket: 'all_aggregator',
      detail: `${origins.length} candidates, all directories`,
    });
    continue;
  }

  const pages: PageLook[] = [];
  for (const origin of nonAgg.slice(0, MAX_NON_AGG)) {
    await sleep(DELAY_MS);
    pages.push(await look(origin));
  }
  const usable = pages.filter((p) => p.ok && !p.parked);
  if (usable.length === 0) {
    verdicts.push({
      row,
      bucket: 'all_dead',
      detail: pages.map((p) => (p.ok ? 'parked' : 'dead')).join(','),
    });
    continue;
  }

  // The candidate prod's walk actually ran on: the first usable one.
  const walked = usable[0];
  let best: { page: PageLook; score: number } | null = null;
  for (const page of usable) {
    const score = await ownScore(row, page);
    if (!best || score > best.score) best = { page, score };
  }

  if (!best || best.score < 0.5) {
    verdicts.push({
      row,
      bucket: 'no_ownership',
      detail: `best own-score ${best ? best.score.toFixed(2) : '-'}`,
    });
    continue;
  }

  if (best.page.origin === walked.origin) {
    const flags = [
      best.page.shellish ? 'js-shell' : '',
      best.page.anyPostcode ? 'other-postcode' : '',
      best.page.otherCrn ? 'other-crn' : '',
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

  // Own-looking site below the walked candidate: was the number one click away?
  let crnAt: string | null = null;
  for (const path of ['/privacy', '/privacy-policy']) {
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
  const n = verdicts.filter((v) => v.bucket === b).length;
  console.log(
    `  ${b.padEnd(26)} ${String(n).padStart(3)}  ${((n / verdicts.length) * 100).toFixed(0)}%`,
  );
}
