import { describe, expect, test } from 'bun:test';

import {
  makeRefreshNamedUrls,
  NAMED_URL_BATCH_ROWS,
  NAMED_URL_ROWS_SQL,
  namedUrlOf,
} from './named-url';

/** One line per statement, so assertions read the SQL rather than its layout. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A query stub: the select answers with `rows`, every write with nothing; each call is recorded. */
function stubQuery(rows: Record<string, unknown>[]) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const query = async (text: string, params?: unknown[]) => {
    calls.push({ text: flat(text), params });
    return params ? [] : rows;
  };
  return { calls, query };
}

/** A selected row: a company, its names, its url and the named url it holds. */
const row = (
  companyNumber: string,
  url: string | null,
  namedUrl: string | null,
  companyName = 'EXPRESSLINES LIMITED',
  sponsorNames: string[] = [],
) => ({
  company_number: companyNumber,
  url,
  named_url: namedUrl,
  company_name: companyName,
  sponsor_names: sponsorNames,
});

describe('NAMED_URL_ROWS_SQL', () => {
  test("reads every row with a url, or a named url to clear, with its company's names", () => {
    // The register's names by the row's own number: a row with no profile
    // still has its trading names.
    const text = flat(NAMED_URL_ROWS_SQL);
    expect(text).toContain(
      "SELECT w.company_number, w.url, w.named_url, coalesce(p.company_name, '') AS company_name, ARRAY(SELECT s.organisation_name FROM hmrc_company_mapping s WHERE s.company_number = w.company_number) AS sponsor_names",
    );
    expect(text).toContain(
      'FROM company_websites w LEFT JOIN companies_house_profiles p USING (company_number) WHERE w.url IS NOT NULL OR w.named_url IS NOT NULL',
    );
  });
});

describe('namedUrlOf', () => {
  test('a host spelling the registered name names the company', () => {
    const url = 'https://www.expresslines.co.uk';
    expect(
      namedUrlOf({
        url,
        companyName: 'EXPRESSLINES LIMITED',
        sponsorNames: [],
      }),
    ).toBe(url);
  });

  test('a host spelling only a trading name names it through the sponsor register', () => {
    // Wave 2's Reeda Safety: the register lists it t/a Building Transformation.
    const url = 'https://buildingtransformation.co.uk';
    const companyName = 'REEDA SAFETY LIMITED';
    expect(
      namedUrlOf({
        url,
        companyName,
        sponsorNames: ['Reeda Safety Ltd t/a Building Transformation'],
      }),
    ).toBe(url);
    expect(namedUrlOf({ url, companyName, sponsorNames: [] })).toBeNull();
  });

  test('a brand no register name spells, or a url that does not parse, names nothing', () => {
    // Wilkin & Sons' Tiptree is right, but its host carries none of the names.
    expect(
      namedUrlOf({
        url: 'https://www.tiptree.com',
        companyName: 'WILKIN & SONS LIMITED',
        sponsorNames: ['Wilkin & Sons Limited'],
      }),
    ).toBeNull();
    expect(
      namedUrlOf({
        url: 'not a url',
        companyName: 'EXPRESSLINES LIMITED',
        sponsorNames: [],
      }),
    ).toBeNull();
  });
});

describe('makeRefreshNamedUrls', () => {
  const named = 'https://www.expresslines.co.uk';
  const other = 'https://www.example-venue.co.uk';
  const rows = [
    row('01', named, null), // newly named
    row('02', named, named), // already holds its named url
    row('03', other, named), // its url no longer names it
    row('04', null, named), // its url was cleared
    row('05', other, null), // never named
  ];

  test('a live run writes only the rows whose named url moved', async () => {
    const { calls, query } = stubQuery(rows);
    expect(await makeRefreshNamedUrls(query)(false)).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toBe(
      'UPDATE company_websites w SET named_url = v.named_url FROM unnest($1::text[], $2::text[]) AS v(company_number, named_url) WHERE w.company_number = v.company_number',
    );
    expect(calls[1].params).toEqual([
      ['01', '03', '04'],
      [named, null, null],
    ]);
  });

  test('a dry run counts what a live run would write and writes nothing', async () => {
    const { calls, query } = stubQuery(rows);
    expect(await makeRefreshNamedUrls(query)(true)).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toBeUndefined();
  });

  test('writes in batches of NAMED_URL_BATCH_ROWS', async () => {
    const many = Array.from({ length: NAMED_URL_BATCH_ROWS + 1 }, (_, i) =>
      row(String(i), named, null),
    );
    const { calls, query } = stubQuery(many);
    expect(await makeRefreshNamedUrls(query)(false)).toBe(many.length);
    const sizes = calls.flatMap((c) =>
      c.params ? [(c.params[0] as string[]).length] : [],
    );
    expect(sizes).toEqual([NAMED_URL_BATCH_ROWS, 1]);
  });
});
