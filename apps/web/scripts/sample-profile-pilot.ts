/**
 * Stratified pilot sample for the profiles pipeline: ~N origins drawn across
 * evidence tier × source × incorporation era with a seeded PRNG — never the
 * population head (the cron-slice sampling trap). Origins already carrying
 * snapshots are excluded: they were the mechanics-validation set, chosen
 * alphabetically, and re-crawling them again today buys nothing.
 *
 * Prints the strata table and writes one company number per line (every
 * company of a sampled origin, so shared domains stay whole) for
 * profile-company.ts --companies-file.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/sample-profile-pilot.ts --size=200 --out=/tmp/pilot.txt
 *
 * Env: POSTGRES_URL.
 */

import { createClient } from '@ss/db/client';
import { companiesHouseProfiles, companyWebsites } from '@ss/db/schema';
import { eq } from 'drizzle-orm';

import { snapshotOrigin } from '../src/lib/profiles/crawl.ts';
import { makeSelectSnapshotOrigins } from '../src/lib/profiles/sql.ts';
import { allocateQuotas } from '../src/lib/profiles/stratify.ts';
import { publishableWebsiteGate } from '../src/lib/websites/publishable.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const size = parseStrictInt(flag('size') ?? '200', 'size');
const out = flag('out');
/** Fixed so the sample is reproducible; change it to draw a fresh sample. */
const seed = parseStrictInt(flag('seed') ?? '20260810', 'seed');
if (!out) {
  console.error('  pass --out=<file> for the company list');
  process.exit(1);
}

/** Seeded LCG in [0,1) — reproducible across runs and machines. */
function makeRand(initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const rand = makeRand(seed);

/** Incorporation era bucket for stratification. */
function era(dateOfCreation: string | null): string {
  if (!dateOfCreation) return 'unknown';
  const year = Number(dateOfCreation.slice(0, 4));
  if (!Number.isFinite(year)) return 'unknown';
  if (year < 2010) return 'pre2010';
  if (year < 2020) return '2010s';
  return '2020s';
}

const db = createClient(process.env.POSTGRES_URL as string);
const rows = await db
  .select({
    companyNumber: companyWebsites.companyNumber,
    url: companyWebsites.url,
    evidence: companyWebsites.evidence,
    source: companyWebsites.source,
    incorporated: companiesHouseProfiles.dateOfCreation,
  })
  .from(companyWebsites)
  .leftJoin(
    companiesHouseProfiles,
    eq(companiesHouseProfiles.companyNumber, companyWebsites.companyNumber),
  )
  .where(publishableWebsiteGate())
  // Postgres guarantees no row order without one; the seeded shuffle is only
  // a pure function of the seed if its input order is pinned too.
  .orderBy(companyWebsites.companyNumber);

const touched = await makeSelectSnapshotOrigins(db)();

/** One entry per origin: its stratum and every company number it serves. */
type OriginEntry = { origin: string; stratum: string; companies: string[] };
const byOrigin = new Map<string, OriginEntry>();
for (const row of rows) {
  if (!row.url) continue;
  let origin: string;
  try {
    origin = snapshotOrigin(row.url);
  } catch {
    continue;
  }
  if (touched.has(origin)) continue;
  const entry = byOrigin.get(origin) ?? {
    origin,
    // The first company's stratum stands for the origin; shared domains are
    // rare and stay whole either way.
    stratum: `${row.evidence} × ${row.source} × ${era(row.incorporated)}`,
    companies: [],
  };
  entry.companies.push(row.companyNumber);
  byOrigin.set(origin, entry);
}

const cells = new Map<string, OriginEntry[]>();
for (const entry of byOrigin.values()) {
  const cell = cells.get(entry.stratum) ?? [];
  cell.push(entry);
  cells.set(entry.stratum, cell);
}

// The steady state once the corpus is crawled: nothing left to sample is a
// clean report, not a TypeError out of the allocation loop.
if (byOrigin.size === 0) {
  console.error(
    '  no eligible origins to sample; every candidate already has snapshots',
  );
  process.exit(1);
}

const total = byOrigin.size;
const quotas = allocateQuotas(
  new Map(
    [...cells.entries()].map(([stratum, cell]) => [stratum, cell.length]),
  ),
  size,
);

/** Seeded Fisher-Yates, so the draw is a pure function of the seed. */
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const sampled: OriginEntry[] = [];
console.log(`Pilot sample — seed ${seed}, ${total} eligible origins`);
for (const [stratum, cell] of [...cells.entries()].sort()) {
  const quota = Math.min(quotas.get(stratum) as number, cell.length);
  const picked = shuffle(cell).slice(0, quota);
  sampled.push(...picked);
  console.log(
    `  ${stratum}: ${cell.length} origins → ${picked.length} sampled`,
  );
}

const lines = [
  `# profiles pilot sample — seed ${seed}, ${sampled.length} origins, ${sampled.reduce((sum, entry) => sum + entry.companies.length, 0)} companies`,
  ...sampled.flatMap((entry) => entry.companies),
];
await Bun.write(out, `${lines.join('\n')}\n`);
console.log(`  wrote ${out}`);
