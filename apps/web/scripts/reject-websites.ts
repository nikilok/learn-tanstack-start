/**
 * Take sites judged not to be a company's off their rows and out of the rows'
 * banked search results, so no later walk or discovery pass chooses them
 * again. A row holding the site goes back to `none` with its walk marker
 * kept. Every listed row is backed up before anything is written, and every
 * outcome, a write or none, holds only for the row still as it was backed up.
 * Prints counts only.
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
  makeRejectSite,
  type RejectOutcome,
} from '../src/lib/websites/rejected-site-sql.ts';
import { rejectSite } from '../src/lib/websites/rejected-site.ts';
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
// A re-run's backup would hold rows the first run already changed.
if (apply && (await Bun.file(backupFile as string).exists())) {
  console.error(`  ${backupFile} already exists; use a new --backup path`);
  process.exit(1);
}

type Rejection = { companyNumber: string; url: string };
const list = (await Bun.file(listFile).json()) as Rejection[];
if (
  !Array.isArray(list) ||
  !list.every(
    (r) => typeof r.companyNumber === 'string' && typeof r.url === 'string',
  )
) {
  console.error('  the list must be [{ companyNumber, url }]');
  process.exit(1);
}
// Each write is guarded on one snapshot, so a second site for a company needs a run of its own.
if (new Set(list.map((r) => r.companyNumber)).size < list.length) {
  console.error(
    '  a company is listed twice; list its other site in a second run',
  );
  process.exit(1);
}

const sql = neon(process.env.POSTGRES_URL as string);
console.log(`  db: ${dbFingerprint(process.env.POSTGRES_URL as string)}`);
const numbers = list.map((r) => r.companyNumber);
// The hash is of the row as backed up; each write is guarded on it.
const rows = (await sql`
  SELECT w.*, md5(w::text) AS row_hash FROM company_websites w
  WHERE w.company_number = ANY(${numbers}::text[])
`) as {
  company_number: string;
  url: string | null;
  candidates: unknown;
  row_hash: string;
}[];
const byNumber = new Map(rows.map((r) => [r.company_number, r]));

const planned: Record<string, number> = {
  reset: 0,
  stripped: 0,
  unchanged: 0,
  missing: 0,
};
for (const r of list) {
  const row = byNumber.get(r.companyNumber);
  const change = row ? rejectSite(row, r.url) : null;
  planned[
    !row
      ? 'missing'
      : !change
        ? 'unchanged'
        : change.reset
          ? 'reset'
          : 'stripped'
  ] += 1;
}
console.log(`  listed: ${list.length}`, planned);
if (!apply) process.exit(0);

await Bun.write(
  backupFile as string,
  JSON.stringify({ at: new Date().toISOString(), rows }, null, 1),
);
console.log(`  backed up: ${rows.length} rows`);
const reject = makeRejectSite(sql);
const done: Record<RejectOutcome | 'missing', number> = {
  reset: 0,
  stripped: 0,
  unchanged: 0,
  missing: 0,
  moved: 0,
};
for (const r of list) {
  const row = byNumber.get(r.companyNumber);
  done[
    row
      ? await reject(
          {
            companyNumber: row.company_number,
            url: row.url,
            candidates: row.candidates,
            rowHash: row.row_hash,
          },
          r.url,
        )
      : 'missing'
  ] += 1;
}
console.log('  applied:', done);
// A moved or missing row's rejection was not applied: what runs next must not take it as done.
if (done.moved > 0 || done.missing > 0) {
  console.error(
    '  rows missing, or changed since the backup, were left; plan again and apply with a new --backup',
  );
  process.exitCode = 1;
}
