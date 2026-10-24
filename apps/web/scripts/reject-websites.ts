/**
 * Take sites judged not to be a company's off their rows and out of the rows'
 * banked search results, so no later walk or discovery pass chooses them
 * again. A row holding the site goes back to `none` with its walk marker
 * kept. Search rows only: a registry's row takes its site back on the next
 * import. Every listed row is backed up exactly as stored before anything is
 * written, and every outcome, a write or none, holds only for the row still
 * as it was backed up. Prints counts only.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/reject-websites.ts --list=rejections.json
 *   bun apps/web/scripts/reject-websites.ts --list=rejections.json --backup=backup.json --apply
 *
 * The list: [{ "companyNumber": "01234567", "url": "https://example.co.uk" }]
 *
 * Env: POSTGRES_URL.
 */

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import {
  applyRun,
  makeBackup,
  parseRejections,
  planRun,
} from '../src/lib/websites/rejected-site-run.ts';
import {
  makeReadListed,
  makeRejectSite,
} from '../src/lib/websites/rejected-site-sql.ts';
import { loadScriptEnv } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

/** Every argument this script reads; anything else stops the run. */
const KNOWN_ARG = /^--(?:apply|(?:list|backup)=.*)$/;
const unknownArgs = args.filter((a) => !KNOWN_ARG.test(a));
if (unknownArgs.length > 0) {
  console.error(`  Unknown arguments: ${unknownArgs.join(' ')}`);
  process.exit(1);
}
const listFile = flag('list');
const backupFile = flag('backup');
const apply = args.includes('--apply');
if (!listFile || (apply && !backupFile)) {
  console.error('  --list is required, and --apply needs --backup');
  process.exit(1);
}
// Fails before reading anything; the backup itself is only ever written to a new file.
if (apply && (await Bun.file(backupFile as string).exists())) {
  console.error(`  ${backupFile} already exists; use a new --backup path`);
  process.exit(1);
}

const entries = parseRejections(await Bun.file(listFile).json());
if (typeof entries === 'string') {
  console.error(`  ${entries}`);
  process.exit(1);
}

const sql = neon(process.env.POSTGRES_URL as string);
console.log(`  db: ${dbFingerprint(process.env.POSTGRES_URL as string)}`);
const plan = await planRun(entries, makeReadListed(sql));
console.log(`  listed: ${entries.length}`, plan.planned);
if (plan.refusal) {
  console.error(`  ${plan.refusal}`);
  process.exit(1);
}
if (!apply) process.exit(0);

const { applied, failure } = await applyRun(entries, plan, {
  backup: makeBackup(backupFile as string, new Date()),
  reject: makeRejectSite(sql),
});
if (applied) {
  console.log(`  backed up: ${plan.rows.length} rows`);
  console.log('  applied:', applied);
}
if (failure) {
  console.error(`  ${failure}`);
  process.exitCode = 1;
}
