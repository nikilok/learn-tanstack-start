/**
 * Move sponsors joined to an overseas company onto its UK establishment.
 * Every join on the overseas record moves and is stored as `manual`, which
 * the sweeps leave alone; the record's website row and answers go with it.
 * A company is left when one of its joins was made on less than the sponsor's
 * full name, to be read by eye first, or when its website is shown on a proof
 * read against the overseas record, which would not follow it.
 *
 * Each company is one write. It asks the register again that the listed
 * establishment is still the company's one open establishment, stores that
 * establishment's own profile, then locks the rows it moves and writes only
 * while each is as it was planned on. The joins, website row and answers of
 * every planned move are backed up exactly as stored before anything is
 * written. Prints counts only.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/move-to-uk-establishments.ts --find --list=moves.json
 *   bun apps/web/scripts/move-to-uk-establishments.ts --list=moves.json
 *   bun apps/web/scripts/move-to-uk-establishments.ts --list=moves.json --backup=backup.json --apply
 *
 * `--find` writes the list and nothing else: each overseas company a sponsor
 * is joined to that has exactly one open UK establishment at Companies House.
 * It exits 1 when a company could not be asked, as the list is then incomplete.
 * The list: [{ "companyNumber": "FC012345", "establishmentNumber": "BR012345" }]
 *
 * Env: POSTGRES_URL, and COMPANIES_HOUSE_SEED_API_KEY to find or to apply.
 */

import { writeFileSync } from 'node:fs';

import { neon } from '@ss/db/client';
import { companiesHouseProfiles } from '@ss/db/schema';
import { drizzle } from 'drizzle-orm/neon-http';

import { type ChFetch, fetchChApi } from '../src/lib/hmrc-ch/ch-lookup.ts';
import { withChRetries } from '../src/lib/hmrc-ch/ch-retry.ts';
import {
  makeCommitMove,
  makeReadMoveStates,
  makeReadOverseasCompanies,
} from '../src/lib/hmrc-ch/establishment-move-sql.ts';
import {
  applyMoves,
  findMoves,
  type ListedEstablishment,
  parseEstablishmentMoves,
  planMoves,
} from '../src/lib/hmrc-ch/establishment-move.ts';
import { profileToDbRow } from '../src/lib/hmrc-ch/profile-row.ts';
import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import type { CHFullProfile } from '../src/lib/phase5/decide.ts';
import { makeBackup } from '../src/lib/websites/rejected-site-run.ts';
import {
  type EstablishmentMoveArgs,
  parseEstablishmentMoveArgs,
} from './lib/establishment-move-args.ts';
import { loadScriptEnv } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

const CHANGED_BY = 'uk_establishment_move';
const CH_PAUSE_MS = 1_100;
const CH_RETRIES = 3;
const CH_RETRY_PAUSE_MS = 60_000;

/** Stop the run with a message, before or after anything was read. */
function stop(message: string): never {
  console.error(`  ${message}`);
  process.exit(1);
}

let args: EstablishmentMoveArgs;
try {
  args = parseEstablishmentMoveArgs(process.argv.slice(2));
} catch (error) {
  stop(error instanceof Error ? error.message : String(error));
}
// Fails before reading anything; either file is only ever written new.
if (args.find && (await Bun.file(args.list).exists())) {
  stop(`${args.list} already exists; use a new --list path`);
}
if (args.backup && (await Bun.file(args.backup).exists())) {
  stop(`${args.backup} already exists; use a new --backup path`);
}

const sql = neon(process.env.POSTGRES_URL as string);
console.log(`  db: ${dbFingerprint(process.env.POSTGRES_URL as string)}`);
const chKey = process.env.COMPANIES_HOUSE_SEED_API_KEY;

/** A paced Companies House call, tried again while that can help. */
const askCh: ChFetch = withChRetries(
  async (path) => {
    await Bun.sleep(CH_PAUSE_MS);
    return fetchChApi(path, chKey as string);
  },
  { retries: CH_RETRIES, pauseMs: CH_RETRY_PAUSE_MS },
);

/** A Companies House call that failed without saying anything about the company, named by its status. */
class ChStatus extends Error {
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = `HTTP ${status}`;
  }
}

/** The establishments Companies House lists under a company; none for a 404, and a throw when it cannot say. */
async function fetchEstablishments(
  companyNumber: string,
): Promise<ListedEstablishment[]> {
  const res = await askCh(`/company/${companyNumber}/uk-establishments`);
  if (res.ok) {
    return (res.data as { items?: ListedEstablishment[] }).items ?? [];
  }
  if (res.status === 404) return [];
  throw new ChStatus(res.status);
}

if (args.find) {
  if (!chKey) stop('COMPANIES_HOUSE_SEED_API_KEY not set');
  const companies = await makeReadOverseasCompanies(sql)();
  const { moves, found } = await findMoves(companies, fetchEstablishments);
  writeFileSync(args.list, JSON.stringify(moves, null, 1), { flag: 'wx' });
  console.log(`  overseas companies with joins: ${companies.length}`, found);
  if (found.failed > 0) {
    stop(
      `${found.failed} companies could not be asked; the list is incomplete`,
    );
  }
  process.exit(0);
}

const entries = parseEstablishmentMoves(await Bun.file(args.list).json());
if (typeof entries === 'string') stop(entries);

const plan = await planMoves(entries, makeReadMoveStates(sql));
console.log(`  listed: ${entries.length}`, plan.planned);
console.log('  the planned moves carry:', plan.carried);
if (!args.apply) process.exit(0);

if (plan.planned.move > 0 && !chKey) {
  stop('COMPANIES_HOUSE_SEED_API_KEY not set, and the list moves a join');
}

const db = drizzle({ client: sql });

/** A company's profile from Companies House; null when it has none (a 404), and a throw when it cannot say. */
async function fetchProfile(
  companyNumber: string,
): Promise<CHFullProfile | null> {
  const res = await askCh(`/company/${companyNumber}`);
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

const { applied, written, failure } = await applyMoves(entries, plan, {
  backup: makeBackup(args.backup as string, new Date()),
  changedBy: CHANGED_BY,
  commit: makeCommitMove(sql),
  fetchEstablishments,
  fetchProfile,
  storeProfile,
});
if (applied) {
  console.log('  applied:', applied);
  console.log('  rows written:', written);
}
if (failure) {
  console.error(`  ${failure}`);
  process.exitCode = 1;
}
