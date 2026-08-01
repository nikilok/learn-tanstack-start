/**
 * How many company websites could a SEARCH result ever be verified against?
 *
 * This sizes phase 2b before any of it is built, because 2b's verification
 * problem is different in kind from the registry tier's and the difference
 * decides whether it is worth building.
 *
 * A registry candidate arrives with identity already asserted: CQC said "this
 * company's website is X", keyed on the exact company number. Corroborating the
 * name on the page then confirms an independent claim.
 *
 * A search candidate has no such claim. We searched the company's NAME, so
 * finding that name on the result is circular — it is why the result came back.
 * Only two signals survive that objection, because only two are independent of
 * the query:
 *
 *   - the registered company number on the page (Companies Act 2006 s.82)
 *   - the registered office postcode on the page (the same regulations)
 *
 * So 2b's ceiling is the share of real company sites carrying one of those, and
 * this measures it on the corpus we already hold URLs for.
 *
 * CAVEAT, and it is a real one: that corpus is ~83% CQC care providers, and 2b
 * targets the 109k companies with no registry row at all — a different
 * population with possibly different disclosure habits. This is an estimate
 * from the only sites we can currently check, not a measurement of 2b's own.
 *
 * LOCAL ONLY. Prints rates, never rows: every row pairs a company with a URL.
 *
 *   bun apps/web/scripts/measure-verifiable-share.ts [--n=150] [--delay=800]
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import {
  pageHasCompanyNumber,
  pageHasPostcode,
} from '../src/lib/websites/extract.ts';
import { DISCLOSURE_PATHS } from '../src/lib/websites/fetch-policy.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';
import { fetchPage } from './lib/web-fetch.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const n = parseStrictInt(flag('n') ?? '150', 'n');
const delayMs = parseStrictInt(flag('delay') ?? '800', 'delay');

const sql = neon(process.env.POSTGRES_URL as string);

console.log(
  `Verifiable-share probe — db ${dbFingerprint(process.env.POSTGRES_URL)}`,
);
console.log(`  sampling ${n} live registry sites, ${delayMs}ms apart`);

// Deterministic order from a stateless connection, as sample-website-precision.
const rows = (await sql.query(
  `SELECT w.company_number, w.url, coalesce(p.postal_code, '') AS postcode
   FROM company_websites w
   LEFT JOIN companies_house_profiles p USING (company_number)
   WHERE w.status = 'verified' AND w.checked_at IS NOT NULL AND w.url IS NOT NULL
   ORDER BY md5(w.company_number || $1)
   LIMIT $2`,
  ['verifiable-share', n],
)) as { company_number: string; url: string; postcode: string }[];

let answered = 0;
let crnOnly = 0;
let postcodeOnly = 0;
let both = 0;
let neither = 0;
let noPostcodeHeld = 0;

for (const [index, row] of rows.entries()) {
  const base = row.url.replace(/\/$/, '');
  let crn = false;
  let postcode = false;
  let reached = false;

  // Homepage first, then the pages a disclosure conventionally lives on —
  // stopping as soon as both are settled, as the sweep does.
  for (const path of ['', ...DISCLOSURE_PATHS]) {
    // Everything findable has been found. Without the second clause a company
    // we hold no postcode for kept fetching every disclosure path after the
    // number was already confirmed, since `postcode` could never become true.
    if (crn && (postcode || !row.postcode)) break;
    const res = await fetchPage(base + path);
    if (res.ok) {
      reached = true;
      if (!crn) crn = pageHasCompanyNumber(res.html, row.company_number);
      if (!postcode && row.postcode) {
        postcode = pageHasPostcode(res.html, row.postcode);
      }
    }
    // Paced on every path, including failures: a 404 is still a request, and
    // `continue` used to skip the delay entirely on the commonest outcome.
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (!reached) continue;
  answered += 1;
  if (!row.postcode) noPostcodeHeld += 1;
  if (crn && postcode) both += 1;
  else if (crn) crnOnly += 1;
  else if (postcode) postcodeOnly += 1;
  else neither += 1;

  if ((index + 1) % 25 === 0) {
    console.log(`  ${index + 1}/${rows.length} probed (${answered} answered)`);
  }
}

const pct = (count: number) =>
  answered === 0 ? '-' : `${((count / answered) * 100).toFixed(1)}%`;
const verifiable = crnOnly + postcodeOnly + both;

console.log('');
console.log('─── what a search result could be verified against ───');
console.log(`  sites answered      : ${answered}`);
console.log(`  crn only            : ${crnOnly}  ${pct(crnOnly)}`);
console.log(`  postcode only       : ${postcodeOnly}  ${pct(postcodeOnly)}`);
console.log(`  both                : ${both}  ${pct(both)}`);
console.log(`  NEITHER             : ${neither}  ${pct(neither)}`);
console.log('');
console.log(`  VERIFIABLE AT ALL   : ${verifiable}  ${pct(verifiable)}`);
console.log(
  `  (crn alone would be : ${crnOnly + both}  ${pct(crnOnly + both)})`,
);
console.log('');
console.log(
  `  no postcode on file : ${noPostcodeHeld} — these can only ever be verified by crn`,
);
