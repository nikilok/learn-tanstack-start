/**
 * Apply an owner's corrections to sponsor-to-company joins: hold a join with
 * no company, or move it to another company. A corrected join is stored as
 * `manual`, which the sweeps leave alone. Only a join still on the listed
 * company, and still made on the name alone, is corrected; any other is left
 * and counted. Every listed row is backed up exactly as stored before
 * anything is written, and every write holds only for the row still as it
 * was read. A move stores the new company's profile before the join is
 * changed. Prints counts only.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/correct-mappings.ts --list=corrections.json
 *   bun apps/web/scripts/correct-mappings.ts --list=corrections.json --backup=backup.json --apply
 *
 * The list: [{ "organisationName": "Example Bakery", "companyNumber": "01234567",
 *   "newCompanyNumber": null }]
 * `companyNumber` is the company the join holds now; a null `newCompanyNumber`
 * holds the join with no company.
 *
 * Env: POSTGRES_URL, and COMPANIES_HOUSE_SEED_API_KEY when the list moves a join.
 */

import { neon } from '@ss/db/client';
import { companiesHouseProfiles } from '@ss/db/schema';
import { drizzle } from 'drizzle-orm/neon-http';

import { fetchChApi } from '../src/lib/hmrc-ch/ch-lookup.ts';
import { makeReadMappings } from '../src/lib/hmrc-ch/mapping-correction-sql.ts';
import {
  applyCorrections,
  parseMappingCorrections,
  planCorrections,
} from '../src/lib/hmrc-ch/mapping-correction.ts';
import { profileToDbRow } from '../src/lib/hmrc-ch/profile-row.ts';
import type { CHFullProfile } from '../src/lib/phase5/apply-promotion.ts';
import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { makeCommitPromotion } from '../src/lib/phase5/sql.ts';
import { makeBackup } from '../src/lib/websites/rejected-site-run.ts';
import { parseRepointArgs, type RepointArgs } from './lib/repoint-args.ts';
import { loadScriptEnv } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

const CHANGED_BY = 'name_only_guard';
const CH_PAUSE_MS = 1_100;

/** Stop the run with a message, before or after anything was read. */
function stop(message: string): never {
  console.error(`  ${message}`);
  process.exit(1);
}

let args: RepointArgs;
try {
  args = parseRepointArgs(process.argv.slice(2));
} catch (error) {
  stop(error instanceof Error ? error.message : String(error));
}
// Fails before reading anything; the backup itself is only ever written to a new file.
if (args.backup && (await Bun.file(args.backup).exists())) {
  stop(`${args.backup} already exists; use a new --backup path`);
}

const entries = parseMappingCorrections(await Bun.file(args.list).json());
if (typeof entries === 'string') stop(entries);

const sql = neon(process.env.POSTGRES_URL as string);
console.log(`  db: ${dbFingerprint(process.env.POSTGRES_URL as string)}`);
const plan = await planCorrections(entries, makeReadMappings(sql));
console.log(`  listed: ${entries.length}`, plan.planned);
if (!args.apply) process.exit(0);

const chKey = process.env.COMPANIES_HOUSE_SEED_API_KEY;
if (plan.planned.repoint > 0 && !chKey) {
  stop('COMPANIES_HOUSE_SEED_API_KEY not set, and the list moves a join');
}

const db = drizzle({ client: sql });

/** A Companies House call that failed without saying anything about the company, named by its status. */
class ChStatus extends Error {
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = `HTTP ${status}`;
  }
}

/** A company's profile from Companies House, paced; null when it has none (a 404), and a throw when it cannot say. */
async function fetchProfile(
  companyNumber: string,
): Promise<CHFullProfile | null> {
  await Bun.sleep(CH_PAUSE_MS);
  const res = await fetchChApi(`/company/${companyNumber}`, chKey as string);
  if (res.ok) return res.data as CHFullProfile;
  if (res.status === 404) return null;
  throw new ChStatus(res.status);
}

/** Store a company's profile, over any copy already held. */
async function storeProfile(profile: CHFullProfile): Promise<void> {
  const row = profileToDbRow(profile);
  await db.insert(companiesHouseProfiles).values(row).onConflictDoUpdate({
    target: companiesHouseProfiles.companyNumber,
    set: row,
  });
}

const { applied, failure } = await applyCorrections(entries, plan, {
  backup: makeBackup(args.backup as string, new Date()),
  changedBy: CHANGED_BY,
  commit: makeCommitPromotion(sql),
  fetchProfile,
  storeProfile,
});
if (applied) {
  console.log(`  backed up: ${plan.rows.length} rows`);
  console.log('  applied:', applied);
}
if (failure) {
  console.error(`  ${failure}`);
  process.exitCode = 1;
}
