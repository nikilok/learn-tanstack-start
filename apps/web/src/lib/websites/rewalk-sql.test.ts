import { describe, expect, test } from 'bun:test';

import type { DiscoveryOutcome } from './discover';
import {
  CURRENT_WALK_VERSION,
  MAX_WALK_ATTEMPTS,
  type RewalkRow,
} from './rewalk';
import {
  makeMarkUnreadable,
  makeMarkWalked,
  makeRecordStated,
  makeRewalkRemaining,
  makeSelectRewalk,
  makeUpgrade,
} from './rewalk-sql';
import type { StatedOnSite } from './stated-numbers';

type Captured = { text: string; params: unknown[] };

/** Fake tagged-template client: records each call's text ($n placeholders) and params. */
function makeFakeSql(result: Record<string, unknown>[] = []) {
  const calls: Captured[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings
      .map((s, i) => (i < values.length ? `${s}$${i + 1}` : s))
      .join('');
    calls.push({ text, params: values });
    return Promise.resolve(result);
  }) as unknown as Parameters<typeof makeUpgrade>[0];
  return { sql, calls };
}

const flat = (text: string) => text.replace(/\s+/g, ' ');

const noneRow: RewalkRow = {
  companyNumber: '03260168',
  postcode: 'SO22 5AZ',
  evidence: 'none',
  url: null,
  candidates: [],
};
const postcodeRow: RewalkRow = {
  ...noneRow,
  evidence: 'postcode_on_page',
  url: 'https://stored.co.uk',
};
const byNumber: DiscoveryOutcome = {
  url: 'https://stored.co.uk',
  evidenceUrl: 'https://stored.co.uk/legal',
  evidence: 'crn_on_page',
  rank: null,
};

describe('makeUpgrade', () => {
  test('a none row gains its site only while it is still an empty search row', async () => {
    const { sql, calls } = makeFakeSql([{ company_number: '03260168' }]);
    const written = await makeUpgrade(sql)(noneRow, byNumber, 0.99);
    expect(written).toBe(true);
    const text = flat(calls[0].text);
    expect(text).toContain(
      "AND source = 'search' AND evidence = 'none' AND url IS NULL AND status = 'none'",
    );
    // The sweep confirms the row before it renders.
    expect(text).toContain('checked_at = NULL');
    expect(calls[0].params).toContain(CURRENT_WALK_VERSION);
  });

  test('a postcode row is upgraded on the site it holds and never moved', async () => {
    const { sql, calls } = makeFakeSql([{ company_number: '03260168' }]);
    await makeUpgrade(sql)(postcodeRow, byNumber, 0.99);
    const text = flat(calls[0].text);
    expect(text).toContain("evidence = 'postcode_on_page' AND url = $");
    const set = text.slice(text.indexOf(' SET '), text.indexOf(' WHERE '));
    expect(set).not.toMatch(/\burl\s*=/);
    expect(calls[0].params).toContain('https://stored.co.uk');
  });

  test('a row another job changed meanwhile reports false', async () => {
    const { sql } = makeFakeSql([]);
    expect(await makeUpgrade(sql)(noneRow, byNumber, 0.99)).toBe(false);
  });

  test('nothing to upgrade writes nothing', async () => {
    const { sql, calls } = makeFakeSql();
    const nothing: DiscoveryOutcome = {
      url: null,
      evidenceUrl: null,
      evidence: 'none',
      rank: null,
    };
    expect(await makeUpgrade(sql)(noneRow, nothing, 0)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

/** The SET and WHERE halves of an UPDATE. */
const halves = (text: string) => ({
  set: text.slice(text.indexOf(' SET '), text.indexOf(' WHERE ')),
  where: text.slice(text.indexOf(' WHERE ')),
});

describe('markers', () => {
  test('a walked row is stamped, its answer untouched, only while it holds what was read', async () => {
    const { sql, calls } = makeFakeSql();
    await makeMarkWalked(sql)(postcodeRow);
    const { set, where } = halves(flat(calls[0].text));
    expect(set).toContain('walk_version =');
    expect(set).not.toMatch(/\b(url|evidence|status)\s*=/);
    expect(where).toContain('evidence = $');
    expect(where).toContain('url IS NOT DISTINCT FROM $');
    expect(calls[0].params).toEqual(
      expect.arrayContaining(['postcode_on_page', 'https://stored.co.uk']),
    );
  });

  test('an unreadable row only counts the attempt, on the content it failed to read', async () => {
    const { sql, calls } = makeFakeSql();
    await makeMarkUnreadable(sql)(noneRow);
    const { set, where } = halves(flat(calls[0].text));
    expect(set).toContain('walk_attempts + 1 >=');
    expect(calls[0].params).toContain(MAX_WALK_ATTEMPTS);
    expect(set).not.toMatch(/\b(url|evidence|status|checked_at)\s*=/);
    expect(where).toContain('evidence = $');
    expect(where).toContain('url IS NOT DISTINCT FROM $');
  });
});

describe('makeRewalkRemaining', () => {
  test('counts only rows the selector can return', async () => {
    // The selector joins the profile for the postcode; a row without one is
    // never walked, so counting it would leave the total stuck above zero.
    const { sql, calls } = makeFakeSql([{ none: 0, postcode: 0 }]);
    await makeRewalkRemaining(sql)();
    expect(flat(calls[0].text)).toMatch(
      /EXISTS \( ?SELECT 1 FROM companies_house_profiles/,
    );
  });
});

describe('makeSelectRewalk', () => {
  test('skips rows the current walk has read and slices by the discovery bucket', async () => {
    const { sql, calls } = makeFakeSql();
    await makeSelectRewalk(sql, { shard: { index: 2, count: 8 } })(100);
    const text = flat(calls[0].text);
    expect(text).toContain('walk_version IS NULL OR w.walk_version <');
    expect(text).toMatch(
      /mod\( \('x' \|\| left\(md5\(w\.company_number\), 7\)\)::bit\(28\)::int/,
    );
    expect(calls[0].params).toEqual(
      expect.arrayContaining([CURRENT_WALK_VERSION, 8, 2, 100]),
    );
  });

  test('takes a none row only while its url is empty, as the upgrade guard requires', async () => {
    // Otherwise a refused upgrade leaves the row unmarked and it is re-read every run.
    for (const selection of [{}, { seed: 'rewalk-2026-10-20' }]) {
      const { sql, calls } = makeFakeSql();
      await makeSelectRewalk(sql, selection)(10);
      expect(flat(calls[0].text)).toContain(
        "w.evidence = 'none' AND w.status = 'none' AND w.url IS NULL",
      );
    }
    const { sql, calls } = makeFakeSql([{ none: 0, postcode: 0 }]);
    await makeRewalkRemaining(sql)();
    expect(flat(calls[0].text)).toContain(
      "evidence = 'none' AND status = 'none' AND url IS NULL",
    );
  });

  test('a seeded sample ignores the marker, so it can run before the migration', async () => {
    const { sql, calls } = makeFakeSql();
    await makeSelectRewalk(sql, { seed: 'rewalk-2026-10-20' })(150);
    const text = flat(calls[0].text);
    expect(text).not.toContain('walk_version');
    expect(text).toContain('ORDER BY md5(w.company_number ||');
  });
});

describe('makeRecordStated', () => {
  const entry = (companyNumber: string, pageUrl: string): StatedOnSite => ({
    host: 'acme.co.uk',
    companyNumber,
    pageUrl,
    context: `Company No. ${companyNumber}`,
  });

  test('upserts one row per site and number', async () => {
    const { sql, calls } = makeFakeSql();
    await makeRecordStated(sql)([
      entry('03135910', 'https://acme.co.uk/'),
      entry('03135910', 'https://acme.co.uk/privacy'),
      entry('07590616', 'https://acme.co.uk/privacy'),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].params[1]).toEqual(['03135910', '07590616']);
    expect(flat(calls[0].text)).toContain(
      'ON CONFLICT (host, company_number) DO UPDATE',
    );
  });

  test('nothing stated, nothing written', async () => {
    const { sql, calls } = makeFakeSql();
    await makeRecordStated(sql)([]);
    expect(calls).toHaveLength(0);
  });
});
