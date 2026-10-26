/**
 * Which page a company page links to for its website. No I/O.
 *
 * `url` is the canonical origin every check compares, so a deeper page, such
 * as a group site's UK section, is stored beside it as `link_url`. The link
 * is read only while it is on url's site: a writer that moves url elsewhere
 * leaves a stale link that no longer starts with it, so no writer has to
 * clear it.
 */

import { companyWebsites } from '@ss/db/schema';
import { type SQL, sql } from 'drizzle-orm';

/** The page to link to: link_url while it is on url's site, else url. */
export function websiteLinkSql(): SQL<string | null> {
  return sql<
    string | null
  >`CASE WHEN starts_with(${companyWebsites.linkUrl}, ${companyWebsites.url} || '/') THEN ${companyWebsites.linkUrl} ELSE ${companyWebsites.url} END`;
}
