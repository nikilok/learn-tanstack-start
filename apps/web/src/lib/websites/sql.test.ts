import { describe, expect, test } from 'bun:test';

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { publishableWebsiteGate } from './publishable';
import { makeCoverage } from './sql';

const dialect = new PgDialect();

describe('makeCoverage', () => {
  test('counts renderable rows through the page gate itself', async () => {
    // It used to bind PUBLISHABLE_EVIDENCE in hand-written SQL, which would
    // have left the shared-postcode arm out of the figure every run reports.
    let rendered = { sql: '', params: [] as unknown[] };
    const db = {
      execute: async (query: SQL) => {
        rendered = dialect.sqlToQuery(query);
        return {
          rows: [
            {
              sponsors: 9,
              identified: 7,
              renderable: 5,
              dead_total: 2,
              never_checked: 1,
            },
          ],
        };
      },
    } as unknown as Parameters<typeof makeCoverage>[0];

    expect(await makeCoverage(db)()).toEqual({
      sponsors: 9,
      identified: 7,
      renderable: 5,
      deadTotal: 2,
      neverChecked: 1,
    });
    const gate = dialect.sqlToQuery(publishableWebsiteGate());
    expect(rendered.sql.replace(/\s+/g, ' ')).toContain(
      `FROM company_websites JOIN mapped ON mapped.cn = company_websites.company_number WHERE ${gate.sql})::int AS renderable`,
    );
    expect(rendered.params).toEqual(gate.params);
  });
});
