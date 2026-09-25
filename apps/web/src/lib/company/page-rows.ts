import {
  companyWebsites,
  hmrcCompanyMapping,
  hmrcSkilledWorkers,
  hmrcSponsorLicences,
} from '@ss/db';
import { type SQL, sql } from 'drizzle-orm';

import { publishableWebsiteGate } from '../websites/publishable';

/** Shape of a canonical company slug; both the page RPC and the extras RPC accept exactly this. */
export const SLUG_RE = /^[a-z0-9-]{1,255}$/;

// One licence row of a company page: a (rating, route) pair.
// `companyNumber` is retained (not stripped) so consumers can tell a mapped
// entity's pooled rows from an unmapped namesake's — the page suppresses
// identity-bearing fields when it can't, and the MCP tool needs it to trust
// the pool over a weaker name match.
export type CompanyLicence = {
  slugId: string;
  organisationName: string;
  companyNumber: string | null;
  typeRating: string;
  route: string;
};

/**
 * A row as `companyPageRowsSql` returns it: the payload fields plus the
 * snapshot licence number (when the triple maps to exactly one) and the
 * row's company website, which the page loads separately.
 */
export type CompanyPageRow = CompanyLicence & {
  sponsorLicenceNumber: string | null;
  websiteUrl: string | null;
};

/**
 * Every licence row sharing a `name_slug`, primary org first. The one query
 * behind both getHmrcCompanyBySlug and getCompanyExtras, so both see the same
 * rows in the same order; each then pools for its own company. The website
 * column, used only for the outline, passes the same render gate as the "Has
 * website" filter.
 */
export function companyPageRowsSql(slug: string): SQL {
  return sql`
    SELECT h.hash AS "slugId",
           h.organisation_name AS "organisationName",
           h.type_rating AS "typeRating",
           h.route AS "route",
           m.company_number AS "companyNumber",
           (SELECT CASE WHEN count(DISTINCT l.sponsor_licence_number) = 1
                        THEN min(l.sponsor_licence_number) END
            FROM ${hmrcSponsorLicences} l
            WHERE l.organisation_name = h.organisation_name
              AND l.type_rating = h.type_rating
              AND l.route = h.route) AS "sponsorLicenceNumber",
           (SELECT ${companyWebsites.url} FROM ${companyWebsites}
            WHERE ${companyWebsites.companyNumber} = m.company_number
              AND ${publishableWebsiteGate()}) AS "websiteUrl"
    FROM ${hmrcSkilledWorkers} h
    LEFT JOIN ${hmrcCompanyMapping} m ON m.organisation_name = h.organisation_name
    WHERE h.name_slug = ${slug}
    -- Primary election: mapped first, then LOWEST COMPANY NUMBER — never the
    -- alphabetically-first name. Company numbers are immutable, so the same
    -- entity keeps the page across renames and across a namesake gaining a
    -- mapping mid-cycle; ordering by name would hand a months-indexed URL to
    -- a different legal entity the moment the sweep maps a namesake (the
    -- page is edge-cached 30 days and mapping changes trigger no purge).
    -- Matches the ingest's min(company_number) tie-break for new collisions.
    -- searchHmrc (api/hmrc.ts) and filterSearch elect the card name the same
    -- way; change all three together.
    ORDER BY (m.company_number IS NULL) ASC, m.company_number ASC,
             h.organisation_name ASC, h.hash ASC
  `;
}
