import { describe, expect, test } from 'bun:test';

import { fromCsv, toCsv } from './csv.ts';

describe('toCsv', () => {
  test('quotes only the fields that need it', () => {
    const csv = toCsv(['a', 'b'], [{ a: 'plain', b: 'has,comma' }]);
    expect(csv).toBe('a,b\nplain,"has,comma"\n');
  });

  test('doubles embedded quotes', () => {
    expect(toCsv(['a'], [{ a: 'say "hi"' }])).toBe('a\n"say ""hi"""\n');
  });

  test('renders null and undefined as empty, not as the words', () => {
    expect(toCsv(['a', 'b'], [{ a: null, b: undefined }])).toBe('a,b\n,\n');
  });
});

describe('toCsv — spreadsheet formula injection', () => {
  test('neutralises a value that would execute on open', () => {
    // Company names and URLs come from the database, not from us. A field
    // starting =, +, - or @ is a formula to Excel, Numbers and Sheets.
    for (const evil of ['=1+1', '+1', '-1', '@SUM(A1)', '  =cmd|calc']) {
      const value = fromCsv(toCsv(['a'], [{ a: evil }])).rows[0].a;
      expect(value.startsWith("'"), evil).toBe(true);
    }
  });

  test('leaves an ordinary value alone', () => {
    expect(toCsv(['a'], [{ a: 'ACME LIMITED' }])).toBe('a\nACME LIMITED\n');
    expect(toCsv(['a'], [{ a: 'https://x.co.uk' }])).toBe(
      'a\nhttps://x.co.uk\n',
    );
  });
});

describe('toCsv — single column', () => {
  test('an empty value survives the round trip', () => {
    // Unquoted it serialises to a blank line, which is indistinguishable from
    // the blank lines fromCsv skips, and the record vanishes.
    for (const value of ['', ' ']) {
      const parsed = fromCsv(toCsv(['a'], [{ a: value }]));
      expect(parsed.rows, JSON.stringify(value)).toEqual([{ a: value }]);
    }
  });
});

describe('fromCsv', () => {
  test('round-trips a company name containing a comma', () => {
    // The real failure: "SMITH, JONES AND CO LIMITED" split naively shifts
    // every later column right, so the url lands under evidence and the row
    // gets labelled against the wrong company.
    const rows = [
      {
        company_number: '01234567',
        company_name: 'SMITH, JONES AND CO LIMITED',
        url: 'https://example.co.uk',
      },
    ];
    const parsed = fromCsv(
      toCsv(['company_number', 'company_name', 'url'], rows),
    );
    expect(parsed.rows).toEqual(rows);
    expect(parsed.malformed).toEqual([]);
  });

  test('round-trips a field containing a newline', () => {
    const rows = [{ a: 'line one\nline two', b: 'x' }];
    expect(fromCsv(toCsv(['a', 'b'], rows)).rows).toEqual(rows);
  });

  test('reports a shifted row instead of padding it', () => {
    const parsed = fromCsv('a,b,c\n1,2,3\n4,5\n6,7,8\n');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.malformed).toEqual([3]);
  });

  test('rejects an unterminated quote even when the field count fits', () => {
    // Field count alone is not a corruption check: this yields exactly two
    // fields, so without quote validation the precision scorer would trust a
    // row a human mangled in a spreadsheet and score it.
    const parsed = fromCsv('a,b\n1,"unterminated\n');
    expect(parsed.rows).toEqual([]);
    expect(parsed.malformed).toEqual([2]);
  });

  test('rejects a quote inside an unquoted field', () => {
    const parsed = fromCsv('a,b\n1,say "hi"\n');
    expect(parsed.rows).toEqual([]);
    expect(parsed.malformed).toEqual([2]);
  });

  test('reports the PHYSICAL line of a malformed row after a multiline one', () => {
    // A legitimate newline inside a quoted company name shifts every later
    // physical line, and the number is what the caller tells a human to fix.
    const parsed = fromCsv('a,b\n"line one\nline two",2\n3\n');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.malformed).toEqual([4]);
  });

  test('tolerates CRLF and a trailing blank line', () => {
    const parsed = fromCsv('a,b\r\n1,2\r\n\r\n');
    expect(parsed.rows).toEqual([{ a: '1', b: '2' }]);
  });

  test('an empty file yields nothing rather than throwing', () => {
    expect(fromCsv('')).toEqual({ rows: [], malformed: [] });
  });
});
