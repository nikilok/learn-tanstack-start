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
 * company sitemaps. One URL per `name_slug` (licence rows and namesake orgs
 * merge into one page); `<lastmod>` is the newest CH profile update across
 * the slug's orgs and omitted when none has a profile.
 */
async function generate() {
  console.log('Generating sitemap...');

  // Clean up old sitemap files
  const glob = new Glob('sitemap*.xml');
  for await (const file of glob.scan(OUT_DIR)) {
    await Bun.file(join(OUT_DIR, file)).delete();
    console.log(`Deleted old ${file}`);
  }

  // Single pass; LEFT JOIN keeps HMRC entries without a CH match. Slug order
  // keeps page membership stable between regenerations.
  const ordered = await db
    .select({
      nameSlug: hmrcSkilledWorkers.nameSlug,
      updatedAt: sql<string | null>`max(${companiesHouseProfiles.updatedAt})`,
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
    .groupBy(hmrcSkilledWorkers.nameSlug)
    .orderBy(hmrcSkilledWorkers.nameSlug);

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
  <url>
    <loc>${BASE_URL}/filters</loc>
  </url>
</urlset>`;

  await Bun.write(join(OUT_DIR, 'sitemap-0.xml'), sitemap0);
  console.log('Written sitemap-0.xml (static pages)');

  // Generate company sitemaps
  for (let page = 1; page <= totalPages; page++) {
    const offset = (page - 1) * URLS_PER_SITEMAP;
    const batch = ordered.slice(offset, offset + URLS_PER_SITEMAP);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${batch
  .map(({ nameSlug, updatedAt }) => {
    // max() comes back as a raw tz-less string via the driver; the column is
    // UTC, so pin it (mirroring drizzle's decoder) or Date parses local time.
    const parsed = updatedAt
      ? new Date(
          /(?:z|[+-]\d\d(?::?\d\d)?)$/i.test(updatedAt)
            ? updatedAt
            : `${updatedAt}+0000`,
        )
      : null;
    const lastmod =
      parsed && !Number.isNaN(parsed.getTime())
        ? `\n    <lastmod>${parsed.toISOString()}</lastmod>`
        : '';
    return `  <url>
    <loc>${BASE_URL}/company/${nameSlug}</loc>${lastmod}
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
