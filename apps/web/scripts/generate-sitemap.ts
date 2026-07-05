import { join } from 'node:path';

import {
  companiesHouseProfiles,
  hmrcCompanyMapping,
  hmrcSkilledWorkers,
} from '@ss/db';
import { Glob } from 'bun';
import { eq, sql } from 'drizzle-orm';

import { db } from '../src/db.server';

const BASE_URL = 'https://sponsorsearch.co.uk';
const URLS_PER_SITEMAP = 45000;
const OUT_DIR = join(import.meta.dirname, '..', 'public');

/**
 * Regenerate the full sitemap set: index, static-pages file, and paginated
 * company sitemaps. URLs use `name_slug`; `<lastmod>` is sourced via the
 * HMRC → mapping → CH profile chain and omitted when the row has no profile.
 */
async function generate() {
  console.log('Generating sitemap...');

  // Clean up old sitemap files
  const glob = new Glob('sitemap*.xml');
  for await (const file of glob.scan(OUT_DIR)) {
    await Bun.file(join(OUT_DIR, file)).delete();
    console.log(`Deleted old ${file}`);
  }

  // Single pass over all rows; LEFT JOIN keeps HMRC entries without a CH match.
  // One URL per (org, rating, route) group. With hash = org|rating|route the
  // min(hash) grouping is 1:1 — kept for resilience if the hash inputs ever
  // change again; siblings would 301 to it, so only min(hash) belongs here.
  // updatedAt is constant per org (mapping PK is organisation_name), so adding
  // it to GROUP BY never splits a group — it just keeps drizzle's Date mapping.
  const allRows = await db
    .select({
      hash: sql<string>`min(${hmrcSkilledWorkers.hash})`,
      nameSlug: hmrcSkilledWorkers.nameSlug,
      updatedAt: companiesHouseProfiles.updatedAt,
    })
    .from(hmrcSkilledWorkers)
    .leftJoin(
      hmrcCompanyMapping,
      eq(
        hmrcCompanyMapping.organisationName,
        hmrcSkilledWorkers.organisationName,
      ),
    )
    .leftJoin(
      companiesHouseProfiles,
      eq(
        companiesHouseProfiles.companyNumber,
        hmrcCompanyMapping.companyNumber,
      ),
    )
    .groupBy(
      hmrcSkilledWorkers.organisationName,
      hmrcSkilledWorkers.nameSlug,
      hmrcSkilledWorkers.typeRating,
      hmrcSkilledWorkers.route,
      companiesHouseProfiles.updatedAt,
    )
    .orderBy(sql`min(${hmrcSkilledWorkers.hash})`);

  const entries = new Map(
    allRows.map((row) => [
      row.hash,
      { nameSlug: row.nameSlug, updatedAt: row.updatedAt },
    ]),
  );
  const ordered = Array.from(entries.entries());

  console.log(`Total companies: ${ordered.length}`);
  const totalPages = Math.ceil(ordered.length / URLS_PER_SITEMAP);

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
  </url>
  <url>
    <loc>${BASE_URL}/privacy</loc>
  </url>
  <url>
    <loc>${BASE_URL}/download</loc>
  </url>
</urlset>`;

  await Bun.write(join(OUT_DIR, 'sitemap-0.xml'), sitemap0);
  console.log('Written sitemap-0.xml (static pages)');

  // Generate company sitemaps from the prebuilt Map
  for (let page = 1; page <= totalPages; page++) {
    const offset = (page - 1) * URLS_PER_SITEMAP;
    const batch = ordered.slice(offset, offset + URLS_PER_SITEMAP);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${batch
  .map(([hash, { nameSlug, updatedAt }]) => {
    const lastmod = updatedAt
      ? `\n    <lastmod>${updatedAt.toISOString()}</lastmod>`
      : '';
    return `  <url>
    <loc>${BASE_URL}/company/${hash}/${nameSlug}</loc>${lastmod}
  </url>`;
  })
  .join('\n')}
</urlset>`;

    await Bun.write(join(OUT_DIR, `sitemap-${page}.xml`), xml);
    console.log(`Written sitemap-${page}.xml (${batch.length} companies)`);
  }

  console.log('Done!');
  process.exit(0);
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
