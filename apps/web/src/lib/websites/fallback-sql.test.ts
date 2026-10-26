import { describe, expect, test } from 'bun:test';

import { makeFakeSql } from './fake-sql';
import type { FallbackRow } from './fallback';
import {
  makeFallbackRemaining,
  makeMarkSettled,
  makeSelectFallback,
  makeWritePick,
  tradesOf,
} from './fallback-sql';
import { CURRENT_WALK_VERSION } from './rewalk';
import { SPONSOR_NAMES_KEY } from './sponsor-names';
import { SPONSOR_TOWNS_KEY } from './sponsor-towns';

const flat = (text: string) => text.replace(/\s+/g, ' ');

const row: FallbackRow = {
  companyNumber: '09990117',
  companyName: 'QUILLMERE FABRICATION LIMITED',
  sponsorNames: [],
  registerTowns: [],
  locality: null,
  postcode: null,
  incorporated: null,
  trades: [],
  candidates: [],
};

/** The selector's predicate, every clause of it. */
const PREDICATE = [
  "w.source = 'search' AND w.status = 'none' AND w.evidence = 'none'",
  "AND w.url IS NULL AND jsonb_typeof(w.candidates) = 'array'",
  `AND w.walk_version = ${CURRENT_WALK_VERSION}`,
  'AND w.fallback_checked_at IS NULL',
  "AND p.company_status = 'active'",
].join(' ');

describe('makeSelectFallback', () => {
  test('reads only empty search rows the current walk read, of active companies, not yet settled', async () => {
    const { sql, calls } = makeFakeSql([]);
    await makeSelectFallback(sql, {})(50);
    expect(flat(calls[0].text)).toContain(PREDICATE);
    expect(calls[0].params.at(-1)).toBe(50);
  });

  test('carries the facts the picker reads, its SIC codes as descriptions', async () => {
    const { sql } = makeFakeSql([
      {
        company_number: '09990117',
        candidates: ['https://www.quillmerefabrication.co.uk/about'],
        company_name: 'QUILLMERE FABRICATION LIMITED',
        locality: 'Wakefield',
        postal_code: 'WF1 2AB',
        incorporated: '1987-03-14',
        sic_codes: ['25110', '99999'],
        [SPONSOR_NAMES_KEY]: ['Quillmere Fabrication Ltd'],
        [SPONSOR_TOWNS_KEY]: ['Wakefield'],
      },
    ]);
    const [read] = await makeSelectFallback(sql, {
      '25110': 'Manufacture of metal structures and parts of structures',
    })(1);
    expect(read).toEqual({
      companyNumber: '09990117',
      companyName: 'QUILLMERE FABRICATION LIMITED',
      sponsorNames: ['Quillmere Fabrication Ltd'],
      registerTowns: ['Wakefield'],
      locality: 'Wakefield',
      postcode: 'WF1 2AB',
      incorporated: '1987-03-14',
      trades: [
        'Manufacture of metal structures and parts of structures',
        '99999',
      ],
      candidates: ['https://www.quillmerefabrication.co.uk/about'],
    });
  });

  test('reads the incorporation date as text, never as a timezone-shifted date', async () => {
    const { sql, calls } = makeFakeSql([]);
    await makeSelectFallback(sql, {})(1);
    expect(calls[0].text).toContain(
      "to_char(p.date_of_creation, 'YYYY-MM-DD') AS incorporated",
    );
  });

  test('the count reads the same rows, every shard’s', async () => {
    const { sql, calls } = makeFakeSql([{ remaining: 7 }]);
    expect(await makeFallbackRemaining(sql)()).toBe(7);
    expect(flat(calls[0].text)).toContain(PREDICATE);
    expect(calls[0].text).not.toContain('md5');
  });
});

describe('makeWritePick', () => {
  test('writes an assessed site and settles the row, only while it is still the row read', async () => {
    const { sql, calls } = makeFakeSql([{ company_number: '09990117' }]);
    const written = await makeWritePick(sql)(row, {
      url: 'https://www.quillmere-group.com',
      linkUrl: 'https://www.quillmere-group.com/en-gb/',
    });
    expect(written).toBe(true);
    const text = flat(calls[0].text);
    expect(text).toContain("status = 'verified'");
    expect(text).toContain("evidence = 'assessed'");
    // The sweep confirms the site before it renders.
    expect(text).toContain('checked_at = NULL');
    expect(text).toContain('fallback_checked_at = now()');
    expect(text).toContain(
      "AND source = 'search' AND status = 'none' AND evidence = 'none' AND url IS NULL AND fallback_checked_at IS NULL",
    );
    expect(calls[0].params).toEqual([
      'https://www.quillmere-group.com',
      'https://www.quillmere-group.com/en-gb/',
      '0.750',
      '09990117',
    ]);
  });

  test('reports a row that changed meanwhile', async () => {
    const { sql } = makeFakeSql([]);
    expect(
      await makeWritePick(sql)(row, {
        url: 'https://a.example',
        linkUrl: null,
      }),
    ).toBe(false);
  });
});

describe('makeMarkSettled', () => {
  test('stamps only a row still empty and unsettled', async () => {
    const { sql, calls } = makeFakeSql([]);
    await makeMarkSettled(sql)(row);
    const text = flat(calls[0].text);
    expect(text).toContain('SET fallback_checked_at = now()');
    expect(text).toContain(
      "AND source = 'search' AND status = 'none' AND evidence = 'none' AND url IS NULL AND fallback_checked_at IS NULL",
    );
  });
});

describe('tradesOf', () => {
  test('keeps a code without a description as itself, and drops what is not a code', () => {
    expect(tradesOf(['25110', 7, null, '99999'], { '25110': 'Steel' })).toEqual(
      ['Steel', '99999'],
    );
    expect(tradesOf(null, {})).toEqual([]);
  });
});
