/**
 * Can a search engine actually find a UK company's website?
 *
 * This is the question phase 2b lives or dies on, and it is answerable before
 * any of 2b is built, because we already hold ground truth: every
 * `crn_on_page` row is a company whose website we confirmed by finding its own
 * Companies House registration number on the page. If a search for the company
 * name does not surface that URL, no amount of infrastructure helps.
 *
 * Reports recall at 1, 3, 5 and 10, plus how often the correct site appears at
 * all. Recall@k matters more than raw recall: the verification chain has to
 * fetch every candidate, so a correct answer at rank 40 costs forty fetches and
 * is not worth having.
 *
 * Provider-agnostic on purpose: recall is a property of the RESULT SET, not of
 * the software that fetched it, so comparing providers means running the same
 * ground truth and the same matcher against each. A recall figure measured on
 * one provider says nothing about another.
 *
 * LOCAL ONLY. Prints rates and ranks, never company/URL pairs.
 *
 *   bun apps/web/scripts/measure-search-recall.ts --provider=searxng [--endpoint=...]
 *   bun apps/web/scripts/measure-search-recall.ts --provider=serper --n=150
 *
 * Serper needs SERPER_API_KEY in .env.local. One credit per query at ten
 * results; asking for more than ten costs two, so `num` stays at 10.
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const n = parseStrictInt(flag('n') ?? '40', 'n');
const provider = flag('provider') ?? 'searxng';
const endpoint = flag('endpoint') ?? 'http://localhost:8888';
const delayMs = parseStrictInt(flag('delay') ?? '1500', 'delay');

if (!['searxng', 'serper'].includes(provider)) {
  console.error(`  unknown --provider="${provider}" (searxng | serper)`);
  process.exit(1);
}
if (provider === 'serper' && !process.env.SERPER_API_KEY) {
  console.error('  SERPER_API_KEY is not set — add it to .env.local');
  process.exit(1);
}

/**
 * One query, one provider, returning result URLs in rank order.
 *
 * `gl: 'gb'` matters: every company here is UK-registered, and an unlocalised
 * query surfaces the US namesake ahead of the right one.
 */
async function search(
  query: string,
): Promise<{ urls: string[]; errored: string[] }> {
  if (provider === 'serper') {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY as string,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'gb', hl: 'en', num: 10 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { urls: [], errored: [`http_${res.status}`] };
    const body = (await res.json()) as { organic?: { link?: string }[] };
    return {
      urls: (body.organic ?? []).map((r) => r.link ?? '').filter(Boolean),
      errored: [],
    };
  }

  const res = await fetch(
    `${endpoint}/search?q=${encodeURIComponent(query)}&format=json`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) return { urls: [], errored: [`http_${res.status}`] };
  const body = (await res.json()) as {
    results?: { url?: string }[];
    unresponsive_engines?: unknown[];
  };
  return {
    urls: (body.results ?? []).map((r) => r.url ?? '').filter(Boolean),
    errored: (body.unresponsive_engines ?? []).map((e) =>
      Array.isArray(e) ? String(e[0]) : String(e),
    ),
  };
}

const sql = neon(process.env.POSTGRES_URL as string);

console.log(
  `Search recall probe — db ${dbFingerprint(process.env.POSTGRES_URL)}`,
);
console.log(
  `  ground truth: ${n} crn_on_page rows (websites confirmed by the company's own number)`,
);
console.log(
  `  provider: ${provider}${provider === 'searxng' ? ` (${endpoint})` : ''}`,
);

const rows = (await sql.query(
  `SELECT w.company_number, w.url, coalesce(p.company_name, '') AS company_name,
          coalesce(nullif(p.locality, ''), p.address_line_2, '') AS town
   FROM company_websites w
   LEFT JOIN companies_house_profiles p USING (company_number)
   WHERE w.evidence = 'crn_on_page' AND w.status = 'verified'
     AND w.url IS NOT NULL AND coalesce(p.company_name, '') <> ''
   ORDER BY md5(w.company_number || $1)
   LIMIT $2`,
  ['search-recall', n],
)) as {
  company_number: string;
  url: string;
  company_name: string;
  town: string;
}[];

/**
 * Host, minus `www.`. Recall is a question about SITES, not URLs: a result at
 * brendoncare.org.uk/care-home-in-hampshire is the right site for a company
 * whose stored URL is www.brendoncare.org.uk, and isSameSite (which compares
 * whole normalised URLs, path included) correctly calls those different.
 */
function siteOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Strip the legal suffix: nobody's website ranks for "LIMITED". */
function queryFor(name: string, town: string): string {
  const clean = name
    .replace(/\b(limited|ltd|llp|plc|cic)\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return town ? `${clean} ${town}` : clean;
}

const ranks: (number | null)[] = [];
const engineFailures = new Map<string, number>();
let emptyQueries = 0;

for (const [index, row] of rows.entries()) {
  const query = queryFor(row.company_name, row.town);
  let rank: number | null = null;
  try {
    const { urls, errored } = await search(query);
    if (urls.length === 0) emptyQueries += 1;
    for (const name of errored) {
      engineFailures.set(name, (engineFailures.get(name) ?? 0) + 1);
    }
    const want = siteOf(row.url);
    const hit = urls.findIndex((u) => siteOf(u) === want);
    rank = hit === -1 ? null : hit + 1;
  } catch {
    rank = null;
  }
  ranks.push(rank);
  if ((index + 1) % 25 === 0) {
    const found = ranks.filter((r) => r !== null).length;
    console.log(
      `  ${index + 1}/${rows.length} searched (${found} found so far)`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const recallAt = (k: number) =>
  ranks.filter((r) => r !== null && r <= k).length;
const pct = (count: number) => `${((count / ranks.length) * 100).toFixed(1)}%`;

console.log('');
console.log('─── can search find a website we already know the answer for ───');
for (const k of [1, 3, 5, 10]) {
  console.log(
    `  recall@${String(k).padEnd(2)}          : ${recallAt(k)}/${ranks.length}  ${pct(recallAt(k))}`,
  );
}
const anywhere = ranks.filter((r) => r !== null).length;
console.log(
  `  found anywhere      : ${anywhere}/${ranks.length}  ${pct(anywhere)}`,
);
console.log(`  queries with 0 hits : ${emptyQueries}`);
if (engineFailures.size > 0) {
  console.log('');
  console.log('  unresponsive engines (count of queries affected):');
  for (const [name, count] of [...engineFailures].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${name.padEnd(24)} ${count}`);
  }
}
