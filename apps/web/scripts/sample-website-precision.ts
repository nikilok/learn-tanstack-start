/**
 * Hand-labelled precision measurement for the website evidence tiers.
 *
 * The gate this exists to settle: `registry` rows (a regulator asserting a
 * URL) are 20x more numerous than `crn_on_page` rows (the company publishing
 * its own registration number) but nobody has measured how often they are
 * right. Until that number exists they stay unpublished, so the site shows a
 * few hundred websites while several thousand sit in the table.
 *
 * Two modes:
 *
 *   sample  bun apps/web/scripts/sample-website-precision.ts
 *           Draws a stratified sample and writes a CSV plus a local HTML
 *           sheet for labelling.
 *
 *   score   bun apps/web/scripts/sample-website-precision.ts --score=<csv>
 *           Reads the labelled CSV back and returns promote / hold /
 *           inconclusive per tier.
 *
 * LOCAL ONLY, and the reason is not convenience. Every row is a
 * company-number-to-URL pair, which IS the dataset this whole pipeline exists
 * to produce. The script therefore prints counts and never rows, and writes
 * into a gitignored directory. Do not wire it into a workflow, do not echo the
 * CSV, and do not commit the output. See feedback: CI logs are public.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { neon } from '@ss/db/client';

import { dbFingerprint } from '../src/lib/phase5/db-host.ts';
import {
  PRECISION_FLOOR,
  scoreTier,
  type Verdict,
} from '../src/lib/websites/precision.ts';
import { fromCsv, toCsv } from './lib/csv.ts';
import { loadScriptEnv, parseStrictInt } from './lib/script-utils.ts';

loadScriptEnv(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const OUT_DIR = new URL('../.precision-samples/', import.meta.url).pathname;

/** The tier under test, and a small control drawn from a tier we already trust. */
const SUBJECT_TIER = 'registry';
const CONTROL_TIER = 'crn_on_page';

const COLUMNS = [
  'company_number',
  'company_name',
  'location',
  'evidence',
  'url',
  'verdict',
] as const;

type SampleRow = Record<(typeof COLUMNS)[number], string>;

const args = process.argv.slice(2);
const flag = (name: string) =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

// ─────────────────────────────────────────────────────────────────────────────
// Score mode
// ─────────────────────────────────────────────────────────────────────────────

/** `y` / `n` / `?`, the three things a labeller can write. Anything else is unlabelled. */
function readVerdict(raw: string): Verdict | null {
  const value = raw.trim().toLowerCase();
  if (['y', 'yes', 'correct', '1'].includes(value)) return 'correct';
  if (['n', 'no', 'wrong', '0'].includes(value)) return 'wrong';
  if (['?', 'unsure', 'maybe'].includes(value)) return 'unsure';
  return null;
}

function score(path: string): void {
  const { rows, malformed } = fromCsv(readFileSync(path, 'utf8'));
  if (malformed.length) {
    console.error(
      `  ${malformed.length} malformed row(s) at line(s) ${malformed.join(', ')} — fix the file before trusting the result`,
    );
    process.exit(1);
  }

  const byTier = new Map<string, Verdict[]>();
  let unlabelled = 0;
  for (const row of rows) {
    const verdict = readVerdict(row.verdict ?? '');
    if (!verdict) {
      unlabelled += 1;
      continue;
    }
    const tier = row.evidence || 'unknown';
    byTier.set(tier, [...(byTier.get(tier) ?? []), verdict]);
  }

  console.log(`\nScored ${rows.length - unlabelled}/${rows.length} rows`);
  if (unlabelled) console.log(`  ${unlabelled} still unlabelled`);
  console.log('');

  for (const [tier, verdicts] of [...byTier].sort()) {
    const s = scoreTier(tier, verdicts);
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    console.log(`  ${tier}`);
    console.log(
      `    labelled     : ${s.labelled}  (correct ${s.correct}, wrong ${s.wrong}, unsure ${s.unsure})`,
    );
    console.log(`    precision    : ${pct(s.precision)}`);
    if (s.unsure)
      console.log(`    if all unsure were right: ${pct(s.optimistic)}`);
    console.log(
      `    95% lower    : ${pct(s.lowerBound)}  (floor ${pct(PRECISION_FLOOR)})`,
    );
    if (tier === CONTROL_TIER) {
      // The control is not a promotion candidate — it is already published,
      // and it is here to check the labelling rather than the data. A small
      // control is inconclusive by construction, so printing a verdict for it
      // would read as a failure. What matters is whether any came back wrong.
      console.log(
        s.correct === s.labelled
          ? '    CONTROL      : clean, so the labelling looks sound'
          : `    CONTROL      : ${s.wrong + s.unsure} not marked correct — these carry the company's OWN registration number, so check the labelling before trusting the subject tier`,
      );
      console.log('');
      continue;
    }

    console.log(`    VERDICT      : ${s.verdict.toUpperCase()}`);
    if (s.verdict === 'promote') {
      console.log(`      → add '${tier}' to PUBLISHABLE_EVIDENCE`);
    } else if (s.verdict === 'inconclusive') {
      console.log('      → label more rows, or resolve the unsure ones');
    } else {
      console.log('      → leave it unpublished; the tier is below the floor');
    }
    console.log('');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample mode
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deterministic shuffle key. `ORDER BY random()` would do, but the sample
 * then cannot be reproduced or extended — and `setseed` does not survive
 * Neon's HTTP transport, where every statement is its own session. Hashing the
 * company number with a seed gives a stable order from a stateless connection.
 */
const SHUFFLE = 'md5(company_number || $SEED)';

async function sample(): Promise<void> {
  const sql = neon(process.env.POSTGRES_URL as string);
  const n = parseStrictInt(flag('n') ?? '200', 'n');
  const control = parseStrictInt(flag('control') ?? '20', 'control');
  const seed = flag('seed') ?? '2026-08-01';

  console.log(
    `Website precision sample — db ${dbFingerprint(process.env.POSTGRES_URL)}`,
  );
  console.log(
    `  subject: ${SUBJECT_TIER} (${n})  control: ${CONTROL_TIER} (${control})  seed: ${seed}`,
  );

  const draw = async (tier: string, limit: number) =>
    (await sql.query(
      `SELECT w.company_number, w.url, w.evidence,
              coalesce(p.company_name, '') AS company_name,
              -- Same locality/address_line_2 fallback the detail page shows,
              -- so the labeller sees the location the site claims to serve.
              coalesce(nullif(p.locality, ''), p.address_line_2, '') AS location
       FROM company_websites w
       LEFT JOIN companies_house_profiles p USING (company_number)
       WHERE w.status = 'verified' AND w.checked_at IS NOT NULL
         AND w.url IS NOT NULL AND w.evidence = $1
       ORDER BY ${SHUFFLE.replace('$SEED', '$2')}
       LIMIT $3`,
      [tier, seed, limit],
    )) as Omit<SampleRow, 'verdict'>[];

  const subject = await draw(SUBJECT_TIER, n);
  const controls = await draw(CONTROL_TIER, control);

  if (subject.length < n) {
    console.log(
      `  NOTE: only ${subject.length} ${SUBJECT_TIER} rows are swept so far; the sweep completes around 9 August.`,
    );
  }

  // Interleave so the labeller cannot tell subject from control by position —
  // a control group they can spot is not a control group.
  const rows: SampleRow[] = [...subject, ...controls]
    .map((row) => ({ ...row, verdict: '' }))
    .sort((a, b) => a.company_number.localeCompare(b.company_number));

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = seed.replace(/[^0-9a-z-]/gi, '');
  const csvPath = join(OUT_DIR, `sample-${stamp}.csv`);
  const htmlPath = join(OUT_DIR, `label-${stamp}.html`);
  writeFileSync(csvPath, toCsv([...COLUMNS], rows));
  writeFileSync(htmlPath, labellingSheet(rows, `sample-${stamp}.csv`));

  const needed = n - Math.floor(n * PRECISION_FLOOR);
  console.log('');
  console.log(
    `  ${rows.length} rows written (${subject.length} ${SUBJECT_TIER}, ${controls.length} ${CONTROL_TIER})`,
  );
  console.log(`  csv   : ${csvPath}`);
  console.log(`  label : ${htmlPath}`);
  console.log('');
  console.log(
    '  Open the html, label every row, then Download CSV over the file above and run:',
  );
  console.log(
    `    bun apps/web/scripts/sample-website-precision.ts --score=${csvPath}`,
  );
  console.log('');
  console.log(
    `  At ${n} rows, ${SUBJECT_TIER} promotes on at most 4 wrong-or-unsure (roughly ${needed} would be the naive ${(PRECISION_FLOOR * 100).toFixed(0)}% allowance, which is not enough to be confident).`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Labelling sheet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A self-contained local page: one row per company, the site opening in a new
 * tab, and three keys to judge it. Editing a 220-row CSV by hand is where
 * mislabelling comes from — one misaligned row and the measurement is quietly
 * wrong, which is worse than not measuring.
 */
function labellingSheet(rows: SampleRow[], csvName: string): string {
  const data = JSON.stringify(
    rows.map((r) => ({
      c: r.company_number,
      n: r.company_name,
      l: r.location,
      u: r.url,
      e: r.evidence,
    })),
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Website precision labelling</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 60rem; }
  header { position: sticky; top: 0; padding: .75rem 0; margin-bottom: .5rem;
           background: Canvas; border-bottom: 1px solid var(--line); display: flex;
           gap: 1rem; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  .grow { flex: 1 }
  button { font: inherit; padding: .35rem .8rem; border-radius: 6px;
           border: 1px solid var(--line); background: transparent; cursor: pointer; color: inherit; }
  button.primary { background: #0072f5; color: #fff; border-color: #0072f5; }
  ol { list-style: none; margin: 0; padding: 0 }
  li { display: grid; grid-template-columns: 2.5rem 1fr auto; gap: .75rem;
       align-items: center; padding: .6rem .5rem; border-bottom: 1px solid var(--line); }
  li[data-done="1"] { opacity: .45 }
  .idx { opacity: .5; font-variant-numeric: tabular-nums; font-size: .85em }
  .name { font-weight: 600 }
  .meta { opacity: .65; font-size: .85em }
  a { color: #0072f5 }
  .btns { display: flex; gap: .35rem }
  .btns button[aria-pressed="true"] { background: #0072f5; color: #fff; border-color: #0072f5 }
</style></head><body>
<header>
  <h1>Does the site belong to the company?</h1>
  <span class="grow"></span>
  <span id="progress"></span>
  <button id="download" class="primary">Download CSV</button>
</header>
<p class="meta">Open the link, decide, and pick. Keys work too: <b>y</b> yes, <b>n</b> no, <b>u</b> unsure, on the first unlabelled row. Progress is saved in this browser. Replace <code>${csvName}</code> with the download, then run the score command.</p>
<ol id="list"></ol>
<script>
const ROWS = ${data};
const KEY = 'precision:${csvName}';
const state = JSON.parse(localStorage.getItem(KEY) || '{}');
const list = document.getElementById('list');
const VERDICTS = [['y','Yes'],['n','No'],['?','Unsure']];

function render() {
  list.innerHTML = '';
  ROWS.forEach((r, i) => {
    const li = document.createElement('li');
    li.dataset.done = state[r.c] ? '1' : '0';
    const idx = document.createElement('span');
    idx.className = 'idx'; idx.textContent = i + 1;
    const main = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = r.n || '(no Companies House name)';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const a = document.createElement('a');
    a.href = r.u; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = r.u.replace(/^https?:\\/\\/(www\\.)?/, '');
    meta.append(a);
    if (r.l) meta.append(document.createTextNode(' \\u00b7 ' + r.l));
    main.append(name, meta);
    const btns = document.createElement('div');
    btns.className = 'btns';
    for (const [v, label] of VERDICTS) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(state[r.c] === v));
      b.onclick = () => { state[r.c] = state[r.c] === v ? undefined : v; save(); };
      btns.append(b);
    }
    li.append(idx, main, btns);
    list.append(li);
  });
  const done = ROWS.filter((r) => state[r.c]).length;
  document.getElementById('progress').textContent = done + ' / ' + ROWS.length;
}
function save() { localStorage.setItem(KEY, JSON.stringify(state)); render(); }

addEventListener('keydown', (e) => {
  const map = { y: 'y', n: 'n', u: '?' };
  const v = map[e.key.toLowerCase()];
  if (!v || e.metaKey || e.ctrlKey) return;
  const next = ROWS.find((r) => !state[r.c]);
  if (next) { state[next.c] = v; save(); }
});

document.getElementById('download').onclick = () => {
  const esc = (s) => /[",\\r\\n]/.test(s) ? '"' + s.replaceAll('"','""') + '"' : s;
  const head = 'company_number,company_name,location,evidence,url,verdict';
  const body = ROWS.map((r) => [r.c, r.n, r.l, r.e, r.u, state[r.c] || ''].map((f) => esc(String(f))).join(','));
  const blob = new Blob([head + '\\n' + body.join('\\n') + '\\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = ${JSON.stringify(csvName)}; a.click();
};
render();
</script></body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────

const scorePath = flag('score');
if (scorePath) score(scorePath);
else await sample();
