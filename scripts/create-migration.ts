export {};

const name = process.argv[2];
if (!name) {
  console.error('Usage: bun scripts/create-migration.ts <migration-name>');
  process.exit(1);
}

const journalPath = './drizzle/meta/_journal.json';
const journal = await Bun.file(journalPath).json();

const nextIdx = journal.entries.length;
const tag = `${String(nextIdx).padStart(4, '0')}_${name}`;
const sqlPath = `./drizzle/${tag}.sql`;

await Bun.write(sqlPath, '-- Write your SQL here\n');

journal.entries.push({
  idx: nextIdx,
  version: '7',
  when: Date.now(),
  tag,
  breakpoints: true,
});

await Bun.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

console.log(`Created: ${sqlPath}`);
console.log(`Journal updated: entry ${nextIdx} → ${tag}`);
