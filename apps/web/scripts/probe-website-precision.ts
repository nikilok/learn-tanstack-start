/**
 * Gathers the evidence a labeller needs for the precision sample, so the
 * judgement is made from what the pages actually say rather than from opening
 * 220 tabs.
 *
 * It deliberately does NOT decide anything. Every signal here is weak on its
 * own — a company name absent from its own homepage is common (trading names,
 * brand sites), and a name present proves little on an aggregator page. The
 * output is material for a human (or an assistant) to judge; turning these
 * signals into an automatic verdict would just be measuring the heuristic
 * instead of the data, which is the thing this whole exercise is trying to
 * avoid.
 *
 * LOCAL ONLY. Same reason as sample-website-precision.ts: every line pairs a
 * company with a URL. Prints counts, writes to a gitignored directory.
 *
 *   bun apps/web/scripts/probe-website-precision.ts --sample=<csv> [--delay=1200]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { pageHasCompanyNumber, visibleText } from '../src/lib/websites/extract.ts';
import {
  isAggregatorHost,
  looksParked,
  nameCorroboration,
} from '../src/lib/websites/page-signals.ts';
import { fromCsv } from './lib/csv.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';
import { fetchSite } from './lib/web-fetch.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const samplePath = flag('sample');
if (!samplePath) {
  console.error('  --sample=<csv> is required');
  process.exit(1);
}
const delayMs = parseStrictInt(flag('delay') ?? '1200', 'delay');

type Evidence = {
  n: number;
  company: string;
  name: string;
  town: string;
  tier: string;
  url: string;
  finalUrl?: string;
  status?: number | string;
  title?: string;
  /** Distinctive name tokens found in the page text. */
  hits?: string[];
  /** Distinctive name tokens found in the final hostname. */
  domainHits?: string[];
  crn?: boolean;
  townOnPage?: boolean;
  aggregator?: boolean;
  parked?: boolean;
  /** The rule under test: name in BOTH host and page. */
  corroborated?: boolean;
  /** A short readable slice, for the rows the signals do not settle. */
  snippet?: string;
};

const { rows, malformed } = fromCsv(readFileSync(samplePath, 'utf8'));
if (malformed.length) {
  console.error(`  malformed rows at ${malformed.join(', ')}`);
  process.exit(1);
}

console.log(`Probing ${rows.length} sampled sites at ${delayMs}ms spacing`);

const out: Evidence[] = [];
let reachable = 0;

for (const [index, row] of rows.entries()) {
  const evidence: Evidence = {
    n: index + 1,
    company: row.company_number,
    name: row.company_name,
    town: row.location,
    tier: row.evidence,
    url: row.url,
  };

  const result = await fetchSite(row.url);
  if (!result.ok) {
    evidence.status = result.reason;
  } else {
    reachable += 1;
    const text = visibleText(result.html);
    const flat = text.toLowerCase().replace(/\s+/g, ' ');
    const host = (() => {
      try {
        return new URL(result.url).host.toLowerCase();
      } catch {
        return '';
      }
    })();

    evidence.status = result.status;
    evidence.finalUrl = result.url;
    evidence.title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(result.html)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const corr = nameCorroboration(row.company_name ?? '', host, flat);
    evidence.hits = corr.inText;
    evidence.domainHits = corr.inHost;
    evidence.corroborated = corr.corroborated;
    evidence.crn = pageHasCompanyNumber(result.html, row.company_number);
    evidence.townOnPage = Boolean(
      row.location && flat.includes(row.location.toLowerCase()),
    );
    evidence.aggregator = isAggregatorHost(host);
    evidence.parked = looksParked(text);
    evidence.snippet = flat.replace(/[^\x20-\x7e]/g, '').slice(0, 260);
  }

  out.push(evidence);
  if ((index + 1) % 25 === 0) {
    console.log(`  ${index + 1}/${rows.length} probed (${reachable} answered)`);
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const outPath = samplePath.replace(/\.csv$/, '.evidence.json');
writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`);

console.log('');
console.log(`  probed      : ${out.length}`);
console.log(`  answered    : ${reachable}`);
console.log(`  unreachable : ${out.length - reachable}`);
console.log(`  aggregators : ${out.filter((e) => e.aggregator).length}`);
console.log(`  parked      : ${out.filter((e) => e.parked).length}`);
console.log(`  crn on page : ${out.filter((e) => e.crn).length}`);
console.log(`  corroborated: ${out.filter((e) => e.corroborated).length}`);
console.log(`  not corrob. : ${out.filter((e) => e.status && typeof e.status === 'number' && !e.corroborated).length}`);
console.log(`  evidence    : ${outPath}`);
