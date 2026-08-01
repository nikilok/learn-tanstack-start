/**
 * Can a search engine actually find a UK company's website?
 *
 * This is the question search discovery lives or dies on, and it is answerable
 * without building any of it, because we already hold ground truth: every
 * `crn_on_page` row is a company whose website we confirmed by finding its own
 * Companies House registration number on the page. If a search for the company
 * name does not surface that URL, no amount of infrastructure helps.
 *
 * Recall is a property of the RESULT SET, not of whatever fetched it, so
 * evaluating a provider means running this same ground truth and this same
 * matcher against it. A figure measured on one provider says nothing about
 * another, which is why this exists rather than a number in a document.
 *
 * Serper was chosen on it: 60.0% at rank 1, 76.0% at 3, 80.7% at 5 and 80.7%
 * at 10 over 150 companies. The alternative evaluated was a self-hosted
 * SearXNG, which reached 70% at rank 10 with three of its four general engines
 * blocked mid-run; that option is gone, and re-adding a provider branch here
 * is how the next one gets evaluated rather than argued about.
 *
 * Recall@k matters more than raw recall: the verification chain fetches every
 * candidate, so a correct answer at rank 40 costs forty fetches and is not
 * worth having. Identical recall at 5 and at 10 is why MAX_CANDIDATES is 5.
 *
 * LOCAL ONLY. Prints rates and ranks, never company/URL pairs. Needs
 * SERPER_API_KEY in .env.local. One credit per query at ten results; asking
 * for more than ten costs two, so `num` stays at 10.
 *
 *   bun apps/web/scripts/measure-search-recall.ts --n=150
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
const delayMs = parseStrictInt(flag('delay') ?? '300', 'delay');

if (!process.env.SERPER_API_KEY) {
  console.error('  SERPER_API_KEY is not set — add it to .env.local');
  process.exit(1);
}

const sql = neon(process.env.POSTGRES_URL as string);

console.log(
  `Search recall probe — db ${dbFingerprint(process.env.POSTGRES_URL)}`,
);
console.log(`  ground truth: ${n} crn_on_page rows`);
console.log('  provider: serper');

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
 * whose stored URL is www.brendoncare.org.uk, and comparing whole URLs calls
 * those different — which understated recall to zero the first time this ran.
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

/**
 * One query, returning result URLs in rank order.
 *
 * `gl: 'gb'` matters: every company here is UK-registered, and an unlocalised
 * query surfaces the US namesake ahead of the right one.
 */
async function search(query: string): Promise<string[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY as string,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ q: query, gl: 'gb', hl: 'en', num: 10 }),
    signal: AbortSignal.timeout(30_000),
  });
  // Throw rather than return nothing. A recall probe that silently counts an
  // exhausted balance or a provider outage as "did not find it" reports a
  // false recall rate, which is the one number this script exists to produce.
  if (!res.ok) {
    throw new Error(`serper returned ${res.status}`);
  }
  const body = (await res.json()) as { organic?: { link?: string }[] };
  if (!Array.isArray(body.organic)) {
    throw new Error('serper returned an unparsable body');
  }
  return body.organic.map((r) => r.link ?? '').filter(Boolean);
}

const ranks: (number | null)[] = [];
let emptyQueries = 0;

for (const [index, row] of rows.entries()) {
  // Deliberately unguarded: a provider failure ends the run rather than
  // quietly becoming a miss in the denominator.
  const urls = await search(queryFor(row.company_name, row.town));
  if (urls.length === 0) emptyQueries += 1;
  const want = siteOf(row.url);
  const hit = urls.findIndex((u) => siteOf(u) === want);
  ranks.push(hit === -1 ? null : hit + 1);
  if ((index + 1) % 25 === 0) {
    const found = ranks.filter((r) => r !== null).length;
    console.log(`  ${index + 1}/${rows.length} searched (${found} found)`);
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const recallAt = (k: number) =>
  ranks.filter((r) => r !== null && r <= k).length;
const pct = (count: number) =>
  ranks.length === 0 ? '-' : `${((count / ranks.length) * 100).toFixed(1)}%`;

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
console.log(`  credits spent       : ${ranks.length}`);
