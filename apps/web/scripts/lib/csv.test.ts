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

  test('tolerates CRLF and a trailing blank line', () => {
    const parsed = fromCsv('a,b\r\n1,2\r\n\r\n');
    expect(parsed.rows).toEqual([{ a: '1', b: '2' }]);
  });

  test('an empty file yields nothing rather than throwing', () => {
    expect(fromCsv('')).toEqual({ rows: [], malformed: [] });
  });
});
