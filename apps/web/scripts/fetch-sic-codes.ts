import { join } from 'node:path';

const SIC_URL = 'https://resources.companieshouse.gov.uk/sic/';
const OUTPUT_PATH = join(
  import.meta.dirname,
  '..',
  'src',
  'data',
  'sic-codes.json',
);

console.log('Fetching SIC codes from Companies House...');
const response = await fetch(SIC_URL);
if (!response.ok) {
  console.error(`Failed to fetch: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const html = await response.text();
const codes: Record<string, string> = {};
const regex = /<td>(\d{4,5})<\/td>\s*<td>(.*?)<\/td>/g;
for (const match of html.matchAll(regex)) {
  codes[match[1].trim()] = match[2].trim();
}

const count = Object.keys(codes).length;
if (count === 0) {
  console.error('No SIC codes found — page format may have changed');
  process.exit(1);
}

await Bun.write(OUTPUT_PATH, `${JSON.stringify(codes, null, 2)}\n`);
console.log(`Written ${count} SIC codes to ${OUTPUT_PATH}`);
