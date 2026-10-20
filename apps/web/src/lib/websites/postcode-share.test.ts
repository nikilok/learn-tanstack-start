import { describe, expect, test } from 'bun:test';

import {
  makeRefreshPostcodeShares,
  POSTCODE_SHARES_SQL,
} from './postcode-share';

/** One line per statement, so assertions read the SQL rather than its layout. */
function flat(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim();
}

/** A query stub that records each statement and answers with a count. */
function stubQuery(moved: unknown) {
  const statements: string[] = [];
  const query = async (text: string) => {
    statements.push(flat(text));
    return [{ moved }];
  };
  return { statements, query };
}

const MOVED_ROWS =
  'WHERE w.company_number = fresh.company_number AND w.postcode_share IS DISTINCT FROM fresh.share';

describe('POSTCODE_SHARES_SQL', () => {
  test('normalises the postcode exactly as the sample did, backslash and all', () => {
    // Inside a tagged template '\s+' cooks to 's+', which strips the letter s
    // and keeps the spaces. It happened while this statement was being
    // checked against prod; the share must be keyed as the sample was.
    expect(POSTCODE_SHARES_SQL).toContain(
      String.raw`upper(regexp_replace(postal_code, '\s+', '', 'g')) AS postcode`,
    );
  });

  test('counts each mapped company once and never an empty postcode', () => {
    // A company mapped from several register names has several mapping rows.
    const text = flat(POSTCODE_SHARES_SQL);
    expect(text).toContain(
      'SELECT pc.postcode, count(DISTINCT m.company_number)::int AS share FROM hmrc_company_mapping m JOIN postcodes pc ON pc.company_number = m.company_number',
    );
    expect(text).toContain("WHERE pc.postcode <> '' GROUP BY pc.postcode");
  });

  test("gives every website row its own company's share, NULL where none matches", () => {
    expect(flat(POSTCODE_SHARES_SQL)).toContain(
      'SELECT w.company_number, s.share FROM company_websites w LEFT JOIN postcodes pc ON pc.company_number = w.company_number LEFT JOIN shares s ON s.postcode = pc.postcode',
    );
  });
});

describe('makeRefreshPostcodeShares', () => {
  test('a live run writes only the rows whose share moved', async () => {
    const { statements, query } = stubQuery(37);
    expect(await makeRefreshPostcodeShares(query)(false)).toBe(37);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(
      `WITH fresh AS (${flat(POSTCODE_SHARES_SQL)})`,
    );
    // IS DISTINCT FROM, not <>: a share falling to NULL must be written too,
    // or a company whose postcode was cleared keeps publishing on its old one.
    expect(statements[0]).toContain(
      `UPDATE company_websites w SET postcode_share = fresh.share FROM fresh ${MOVED_ROWS} RETURNING 1`,
    );
  });

  test('a dry run counts the same rows and writes nothing', async () => {
    const { statements, query } = stubQuery(37);
    expect(await makeRefreshPostcodeShares(query)(true)).toBe(37);
    expect(statements[0]).not.toContain('UPDATE');
    expect(statements[0]).toContain(
      `WITH fresh AS (${flat(POSTCODE_SHARES_SQL)})`,
    );
    expect(statements[0]).toContain(MOVED_ROWS);
  });

  test('reads the count whether the driver hands back a number or a string', async () => {
    expect(await makeRefreshPostcodeShares(stubQuery('5').query)(false)).toBe(
      5,
    );
  });
});
