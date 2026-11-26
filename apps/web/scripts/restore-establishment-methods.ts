/**
 * Give the joins the establishment move stored as `manual` their match method
 * back, so the sweeps check them again. Each join is read from its audit row
 * (`changed_by = 'uk_establishment_move'`): only one still `manual`, still on
 * the establishment the move put it on, and not written since is restored, to
 * the method that row records and the score that method fixes. Its company
 * number and check time stay as they are.
 *
 * Each join is one write, which holds only while the join is as it was read
 * and nothing has been recorded for the sponsor since the move; it leaves an
 * audit row of its own. The joins of every planned restore are backed up
 * exactly as stored before anything is written. Prints counts only.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/restore-establishment-methods.ts
 *   bun apps/web/scripts/restore-establishment-methods.ts --backup=backup.json --apply
 *
 * Env: POSTGRES_URL.
 */

import { neon } from '@ss/db/client';

import {
  makeCommitRestore,
  makeReadMovedJoins,
} from '../src/lib/hmrc-ch/method-restore-sql.ts';
import {
  applyRestores,
  MOVED_BY,
  planRestores,
  RESTORED_BY,
} from '../src/lib/hmrc-ch/method-restore.ts';
import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import { makeBackup } from '../src/lib/websites/rejected-site-run.ts';
import {
  type MethodRestoreArgs,
  parseMethodRestoreArgs,
} from './lib/method-restore-args.ts';
import { loadScriptEnv } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

/** Stop the run with a message, before or after anything was read. */
function stop(message: string): never {
  console.error(`  ${message}`);
  process.exit(1);
}

let args: MethodRestoreArgs;
try {
  args = parseMethodRestoreArgs(process.argv.slice(2));
} catch (error) {
  stop(error instanceof Error ? error.message : String(error));
}
// Fails before reading anything; the backup is only ever written to a new file.
if (args.backup && (await Bun.file(args.backup).exists())) {
  stop(`${args.backup} already exists; use a new --backup path`);
}

const sql = neon(process.env.POSTGRES_URL as string);
console.log(`  db: ${dbFingerprint(process.env.POSTGRES_URL as string)}`);

const plan = await planRestores(makeReadMovedJoins(sql, MOVED_BY));
console.log(
  `  joins the move stored as manual: ${plan.rows.length}`,
  plan.planned,
);
if (!args.apply) process.exit(0);

const { applied, failure } = await applyRestores(plan, {
  backup: makeBackup(args.backup as string, new Date()),
  changedBy: RESTORED_BY,
  commit: makeCommitRestore(sql),
});
if (applied) console.log('  applied:', applied);
if (failure) {
  console.error(`  ${failure}`);
  process.exitCode = 1;
}
