import { describe, expect, test } from 'bun:test';

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { makeFakeSql } from './fake-sql';
import { publishableWebsiteGate } from './publishable';
import { sponsorNamesColumnFor, SPONSOR_NAMES_KEY } from './sponsor-names';
import { SPONSOR_TOWNS_KEY, sponsorTownsColumnFor } from './sponsor-towns';
import { makeCoverage, makeSelectRows } from './sql';

const dialect = new PgDialect();

describe('makeSelectRows', () => {
  test("reads the company's names and places, which a name_and_place re-check reads", async () => {
    const { sql, calls } = makeFakeSql([
      {
        company_number: '09990117',
        url: 'https://www.qmx.co.uk',
        company_name: 'QUILLMERE ANALYTICS LIMITED',
        locality: 'Harrogate',
        [SPONSOR_NAMES_KEY]: ['Quillmere Analytics Ltd'],
        [SPONSOR_TOWNS_KEY]: ['Harrogate'],
      },
      { company_number: '09990118', url: 'https://hestwick.co.uk' },
    ]);
    const rows = await makeSelectRows(sql)(10);
    expect(calls[0].text.replace(/\s+/g, ' ')).toContain(
      "p.postal_code, coalesce(p.company_name, '') AS company_name, p.locality,",
    );
    // Keyed on the website row, so a company without a profile keeps its register entries.
    expect(calls[0].text).toContain(sponsorNamesColumnFor('w.company_number'));
    expect(calls[0].text).toContain(sponsorTownsColumnFor('w.company_number'));
    expect(
      rows.map((r) => [
        r.companyName,
        r.sponsorNames,
        r.registerTowns,
        r.locality,
      ]),
    ).toEqual([
      [
        'QUILLMERE ANALYTICS LIMITED',
        ['Quillmere Analytics Ltd'],
        ['Harrogate'],
        'Harrogate',
      ],
      ['', [], [], null],
    ]);
  });
});

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
