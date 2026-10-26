import { describe, expect, test } from 'bun:test';

import { PgDialect } from 'drizzle-orm/pg-core';

import { websiteLinkSql } from './link-url';

describe('websiteLinkSql', () => {
  test('links a stored page only while it is on the url’s site', () => {
    // A writer that moves url to another site leaves link_url behind; the
    // prefix check is what stops the page linking to the old site's section.
    expect(new PgDialect().sqlToQuery(websiteLinkSql()).sql).toBe(
      `CASE WHEN starts_with("company_websites"."link_url", "company_websites"."url" || '/') THEN "company_websites"."link_url" ELSE "company_websites"."url" END`,
    );
  });
});
