import { parse } from 'csv-parse/sync';

const csvPath = './csv/2026-03-31-Worker.csv';
const sqlPath = './drizzle/0008_seed_hmrc_skilled_workers.sql';
const file = await Bun.file(csvPath).text();

const records: Array<{
  'Organisation Name': string;
  'Town/City': string;
  County: string;
  'Type & Rating': string;
  Route: string;
}> = parse(file, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

console.log(`Parsed ${records.length} records`);

function escapeSql(val: string): string {
  return val.replace(/'/g, "''");
}

function clean(val: string | undefined): string {
  if (!val || val === 'NULL') return 'NULL';
  const trimmed = val.trim();
  if (!trimmed) return 'NULL';
  return `'${escapeSql(trimmed)}'`;
}

const BATCH_SIZE = 500;
const lines: string[] = [];

lines.push(
  '-- HMRC Skilled Workers seed data (generated from 2026-03-31-Worker.csv)',
);
lines.push('TRUNCATE TABLE "hmrc_skilled_workers" RESTART IDENTITY;');
lines.push('--> statement-breakpoint');

for (let i = 0; i < records.length; i += BATCH_SIZE) {
  const batch = records.slice(i, i + BATCH_SIZE);
  lines.push(
    'INSERT INTO "hmrc_skilled_workers" ("organisation_name", "town_city", "county", "type_rating", "route") VALUES',
  );

  const values = batch.map((r) => {
    const org = `'${escapeSql(r['Organisation Name'].trim())}'`;
    const city = clean(r['Town/City']);
    const county = clean(r.County);
    const type = `'${escapeSql(r['Type & Rating'].trim())}'`;
    const route = `'${escapeSql(r.Route.trim())}'`;
    return `(${org}, ${city}, ${county}, ${type}, ${route})`;
  });

  lines.push(`${values.join(',\n')};`);
  lines.push('--> statement-breakpoint');
}

await Bun.write(sqlPath, `${lines.join('\n')}\n`);
console.log(`Written ${records.length} rows to ${sqlPath}`);
