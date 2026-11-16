/**
 * Move a company's website row to the address the owner chose, and pin it
 * there so no later import moves it. A row already on the new address is only
 * pinned. What was learned about the old address goes with it: the row is
 * fetched and walked again at the new one, and does not render until the
 * sweep has read it, unless the list says the owner already has. Every listed
 * row is backed up exactly as stored before anything is written, and every
 * write holds only for the row still as it was backed up. Prints counts only.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/repoint-websites.ts --list=repoints.json
 *   bun apps/web/scripts/repoint-websites.ts --list=repoints.json --backup=backup.json --apply
 *
 * The list: [{ "companyNumber": "01234567", "url": "https://old.example",
 *   "newUrl": "https://example.co.uk", "newEvidenceUrl": null, "keepLive": false }]
 * `url` is the address the row holds now; the same address as `newUrl` pins
 * the row where it is.
 *
 * Env: POSTGRES_URL.
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { makeBackup } from '../src/lib/websites/rejected-site-run.ts';
import { makeReadListed } from '../src/lib/websites/rejected-site-sql.ts';
import {
  applyRepoints,
  planRepoints,
} from '../src/lib/websites/repoint-run.ts';
import { makeRepoint } from '../src/lib/websites/repoint-sql.ts';
import { parseRepoints } from '../src/lib/websites/repoint.ts';
import { parseRepointArgs, type RepointArgs } from './lib/repoint-args.ts';
import { loadScriptEnv } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

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

const entries = parseRepoints(await Bun.file(args.list).json());
if (typeof entries === 'string') stop(entries);

const sql = neon(process.env.POSTGRES_URL as string);
console.log(`  db: ${dbFingerprint(process.env.POSTGRES_URL as string)}`);
const plan = await planRepoints(entries, makeReadListed(sql));
console.log(`  listed: ${entries.length}`, plan.planned);
if (plan.refusal) stop(plan.refusal);
if (!args.apply) process.exit(0);

const { applied, failure } = await applyRepoints(entries, plan, {
  backup: makeBackup(args.backup as string, new Date()),
  repoint: makeRepoint(sql),
});
if (applied) {
  console.log(`  backed up: ${plan.rows.length} rows`);
  console.log('  applied:', applied);
}
if (failure) {
  console.error(`  ${failure}`);
  process.exitCode = 1;
}
