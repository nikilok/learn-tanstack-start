import { join } from 'node:path';
import { Glob } from 'bun';
import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import { hmrcSkilledWorkers } from '../src/db/schema';
import { slugify } from '../src/utils';

const BASE_URL = 'https://sponsorsearch.co.uk';
const BATCH_SIZE = 45000;
const OUT_DIR = join(import.meta.dirname, '..', 'public');

async function generate() {
  console.log('Generating sitemap...');

  // Clean up old sitemap files
  const glob = new Glob('sitemap*.xml');
  for await (const file of glob.scan(OUT_DIR)) {
    await Bun.file(join(OUT_DIR, file)).delete();
    console.log(`Deleted old ${file}`);
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(hmrcSkilledWorkers);

  console.log(`Total companies: ${count}`);
  const totalPages = Math.ceil(count / BATCH_SIZE);

  // Generate sitemap index
  const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${BASE_URL}/sitemap-0.xml</loc>
  </sitemap>
${Array.from(
  { length: totalPages },
  (_, i) => `  <sitemap>
    <loc>${BASE_URL}/sitemap-${i + 1}.xml</loc>
  </sitemap>`,
).join('\n')}
</sitemapindex>`;

  await Bun.write(join(OUT_DIR, 'sitemap.xml'), index);
  console.log('Written sitemap.xml (index)');

  // Generate static pages sitemap
  const sitemap0 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${BASE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${BASE_URL}/privacy</loc>
    <changefreq>yearly</changefreq>
    <priority>0.2</priority>
  </url>
</urlset>`;

  await Bun.write(join(OUT_DIR, 'sitemap-0.xml'), sitemap0);
  console.log('Written sitemap-0.xml (static pages)');

  // Generate company sitemaps
  for (let page = 1; page <= totalPages; page++) {
    const offset = (page - 1) * BATCH_SIZE;
    const rows = await db
      .select({
        hash: hmrcSkilledWorkers.hash,
        organisationName: hmrcSkilledWorkers.organisationName,
      })
      .from(hmrcSkilledWorkers)
      .orderBy(hmrcSkilledWorkers.hash)
      .limit(BATCH_SIZE)
      .offset(offset);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows
  .map(
    (row) => `  <url>
    <loc>${BASE_URL}/company/${row.hash}/${slugify(row.organisationName)}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`,
  )
  .join('\n')}
</urlset>`;

    await Bun.write(join(OUT_DIR, `sitemap-${page}.xml`), xml);
    console.log(`Written sitemap-${page}.xml (${rows.length} companies)`);
  }

  console.log('Done!');
  process.exit(0);
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
