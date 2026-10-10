/**
 * Re-marks company_answers prose rows whose stored answer reports on the page
 * instead of the company ("The provided text does not state what the company
 * does.") as insufficient_content. The extract's parser now reads such a
 * reply as "the page does not say" (isNonAnswer in lib/profiles/extract), but
 * the ok-preservation guard keeps an ok row from being overwritten, so rows
 * written before the rule need this one pass. The predicate is the parser's
 * own, so the two cannot drift. Dry run by default: lists the rows it would
 * change and changes nothing.
 *
 * Run from monorepo root:
 *   bun apps/web/scripts/remark-non-answers.ts            # list
 *   bun apps/web/scripts/remark-non-answers.ts --apply    # re-mark
 *
 * Env (root .env.local): POSTGRES_URL
 */

import { neon } from '@ss/db/client';

import { isNonAnswer } from '../src/lib/profiles/extract.ts';
import { loadScriptEnv } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

let APPLY = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--apply') APPLY = true;
  else throw new Error(`Unknown argument "${arg}"`);
}

const sql = neon(process.env.POSTGRES_URL as string);

const rows = (await sql.query(
  `SELECT a.id, a.company_number, a.question_slug, a.answer
   FROM company_answers a
   JOIN profile_questions q ON q.slug = a.question_slug
   WHERE q.kind = 'prose' AND a.status = 'ok' AND a.answer IS NOT NULL
   ORDER BY a.company_number, a.question_slug`,
)) as {
  id: number;
  company_number: string;
  question_slug: string;
  answer: string;
}[];

const stale = rows.filter((row) => isNonAnswer(row.answer));
console.log(
  `${rows.length} ok prose answers, ${stale.length} read as non-answers`,
);
for (const row of stale) {
  console.log(
    `  ${row.company_number} ${row.question_slug}: ${JSON.stringify(row.answer)}`,
  );
}

if (!APPLY) {
  console.log(
    '\nDry run: nothing changed. Re-run with --apply to re-mark them.',
  );
} else if (stale.length) {
  // Keyed by id AND answer: an extraction can land a fresh answer on a row
  // between the read above and this write, and that one must stay.
  const updated = (await sql.query(
    `UPDATE company_answers AS a
     SET status = 'insufficient_content', answer = NULL, source_urls = '[]'::jsonb
     FROM unnest($1::int[], $2::text[]) AS selected(id, answer)
     WHERE a.id = selected.id AND a.answer = selected.answer AND a.status = 'ok'
     RETURNING a.id`,
    [stale.map((row) => row.id), stale.map((row) => row.answer)],
  )) as { id: number }[];
  console.log(`\nRe-marked ${updated.length} rows.`);
}
