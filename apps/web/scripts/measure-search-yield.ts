/**
 * What does a credit actually buy on a TYPICAL sponsor?
 *
 * The production selector walks company_number ascending, so early runs sample
 * the oldest, largest, most institutional companies on the register — the ones
 * least likely to print a registration number in a footer. Every yield figure
 * measured so far comes from that head, and the handoff doc says not to trust
 * it. This draws a deterministic RANDOM sample instead and reports the outcome
 * by incorporation decade, which is the axis the bias runs along.
 *
 * Runs the real discoverWebsites orchestrator with only selectRows swapped, so
 * what is measured is what ships. Rows are written exactly as production writes
 * them: the credit is spent either way, and banking the answer means these
 * companies are not searched again.
 *
 * COSTS MONEY. One Serper credit per company.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/measure-search-yield.ts --n=40
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { evidenceConfidence } from '../src/lib/websites/decide.ts';
import {
  makeBankCandidates,
  makeMarkAttempt,
  makeWriteOutcome,
} from '../src/lib/websites/discover-sql.ts';
import type { DiscoveryRow } from '../src/lib/websites/discover-sweep.ts';
import { discoverWebsites } from '../src/lib/websites/discover-sweep.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';
import { searchCompany } from './lib/serper.ts';
import { probeOrigin, walkDisclosure } from './lib/website-probe.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const n = parseStrictInt(flag('n') ?? '40', 'n');
const delayMs = parseStrictInt(flag('delay') ?? '400', 'delay');
const maxDisclosure = parseStrictInt(
  flag('max-disclosure') ?? '5',
  'max-disclosure',
);
/** Fixed, so the same sample can be redrawn without paying twice by accident. */
const seed = flag('seed') ?? 'yield-2026-08-01';

const apiKey = process.env.SERPER_API_KEY;
if (!apiKey) {
  console.error('  SERPER_API_KEY is not set');
  process.exit(1);
}

const sql = neon(process.env.POSTGRES_URL as string);

/**
 * Undiscovered sponsors, drawn at random rather than from the head.
 *
 * The random order must be applied AFTER the DISTINCT ON, not inside it.
 * DISTINCT ON forces its ORDER BY to lead with the distinct key, so ordering
 * and limiting in one pass takes the lowest company numbers and only then
 * shuffles them — a random sample of the oldest companies, which is precisely
 * the bias this script exists to remove.
 */
async function selectRandom(maxRows: number): Promise<DiscoveryRow[]> {
  const rows = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (m.company_number)
        m.company_number,
        coalesce(p.company_name, '') AS company_name,
        coalesce(nullif(p.locality, ''), p.address_line_2, '') AS town,
        p.postal_code
      FROM hmrc_company_mapping m
      JOIN companies_house_profiles p ON p.company_number = m.company_number
      LEFT JOIN company_websites w ON w.company_number = m.company_number
      WHERE m.company_number IS NOT NULL
        AND w.company_number IS NULL
        AND coalesce(p.company_name, '') <> ''
      ORDER BY m.company_number
    ) x
    ORDER BY md5(x.company_number || ${seed})
    LIMIT ${maxRows}
  `;
  return rows.map((r) => ({
    companyNumber: r.company_number as string,
    companyName: (r.company_name as string | null) ?? '',
    town: (r.town as string | null) ?? '',
    postcode: (r.postal_code as string | null) ?? null,
    bankedCandidates: null,
  }));
}

const decadeOf = new Map<string, string>();
const outcomeOf = new Map<string, string>();

console.log(
  `Search yield on a random sample — db ${dbFingerprint(process.env.POSTGRES_URL)}`,
);
console.log(`  n: ${n}  seed: ${seed}  (${n} credits)`);

const writeOutcome = makeWriteOutcome(sql);
let disclosureFetches = 0;

const summary = await discoverWebsites(
  { maxRows: n, maxSearches: n, delayMs, dryRun: false },
  {
    selectRows: selectRandom,
    search: async (query) => {
      const result = await searchCompany(query, apiKey);
      return result.ok ? { ok: true, urls: result.urls } : result;
    },
    bankCandidates: makeBankCandidates(sql),
    markAttempt: makeMarkAttempt(sql),
    probe: probeOrigin,
    walkDisclosure: (row, base) =>
      walkDisclosure(row, base, {
        maxPaths: maxDisclosure,
        delayMs,
        onFetch: () => {
          disclosureFetches += 1;
        },
      }),
    write: async (row, outcome) => {
      outcomeOf.set(row.companyNumber, outcome.evidence);
      return writeOutcome(row, outcome, evidenceConfidence(outcome.evidence));
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  },
);

// Decades are read back after the run so the sample is described by what was
// actually processed, not by what was selected.
const numbers = [...outcomeOf.keys()];
if (numbers.length > 0) {
  const ages = (await sql`
    SELECT company_number, date_of_creation
    FROM companies_house_profiles WHERE company_number = ANY(${numbers})
  `) as { company_number: string; date_of_creation: Date | null }[];
  for (const a of ages) {
    const y = a.date_of_creation
      ? new Date(a.date_of_creation).getUTCFullYear()
      : 0;
    decadeOf.set(
      a.company_number,
      y ? `${Math.floor(y / 10) * 10}s` : 'unknown',
    );
  }
}

const found = summary.foundByNumber + summary.foundByAddress;
const decided =
  summary.foundByNumber + summary.foundByAddress + summary.foundNothing;

console.log('\n─── yield ───');
console.log(`  searched            : ${summary.searched}`);
console.log(`  crn_on_page         : ${summary.foundByNumber}  ← publishable`);
console.log(`  postcode_on_page    : ${summary.foundByAddress}`);
console.log(`  none                : ${summary.foundNothing}`);
console.log(
  `  publishable rate    : ${decided === 0 ? '-' : ((summary.foundByNumber / decided) * 100).toFixed(1)}%`,
);
console.log(
  `  any evidence        : ${decided === 0 ? '-' : ((found / decided) * 100).toFixed(1)}%`,
);
console.log(`  candidate_fetches   : ${summary.candidateFetches}`);
console.log(`  disclosure_fetches  : ${disclosureFetches}`);
console.log(`  unreadable          : ${summary.unreadable}`);
console.log(`  errored             : ${summary.errored}`);

console.log('\n─── by incorporation decade ───');
const decades = [...new Set([...decadeOf.values()])].sort();
console.log(
  `  ${'decade'.padEnd(10)} ${'n'.padEnd(4)} ${'crn'.padEnd(5)} pcode  none`,
);
for (const d of decades) {
  const members = numbers.filter((cn) => decadeOf.get(cn) === d);
  const c = members.filter((cn) => outcomeOf.get(cn) === 'crn_on_page').length;
  const p = members.filter(
    (cn) => outcomeOf.get(cn) === 'postcode_on_page',
  ).length;
  console.log(
    `  ${d.padEnd(10)} ${String(members.length).padEnd(4)} ${String(c).padEnd(5)} ${String(p).padEnd(6)} ${members.length - c - p}`,
  );
}
