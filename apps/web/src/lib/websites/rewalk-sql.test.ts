import { describe, expect, test } from 'bun:test';

import type { DiscoveryOutcome } from './discover';
import { makeFakeSql } from './fake-sql';
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
import { SPONSOR_NAMES_COLUMN, SPONSOR_NAMES_KEY } from './sponsor-names';
import { SPONSOR_TOWNS_COLUMN, SPONSOR_TOWNS_KEY } from './sponsor-towns';
import type { StatedOnSite } from './stated-numbers';

const flat = (text: string) => text.replace(/\s+/g, ' ');

const noneRow: RewalkRow = {
  companyNumber: '03260168',
  companyName: 'ACME WIDGETS LIMITED',
  sponsorNames: [],
  postcode: 'SO22 5AZ',
  registerTowns: [],
  locality: null,
  evidence: 'none',
  source: 'search',
  url: null,
  candidates: [],
  walkAttempts: 0,
};
const postcodeRow: RewalkRow = {
  ...noneRow,
  evidence: 'postcode_on_page',
  url: 'https://stored.co.uk',
};
const registryRow: RewalkRow = {
  ...noneRow,
  evidence: 'registry',
  source: 'cqc',
  url: 'https://stored.co.uk',
};
const byNumber: DiscoveryOutcome = {
  url: 'https://stored.co.uk',
  evidenceUrl: 'https://stored.co.uk/legal',
  evidence: 'crn_on_page',
  rank: null,
};

/** The SET and WHERE halves of an UPDATE. */
const halves = (text: string) => ({
  set: text.slice(text.indexOf(' SET '), text.indexOf(' WHERE ')),
  where: text.slice(text.indexOf(' WHERE ')),
});

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
    // Only while it holds the status the selector read: a row the sweep parks
    // or marks dead meanwhile is left alone.
    expect(text).toContain("status IN ('verified', 'unreachable')");
  });

  test('a registry row is confirmed on the site it holds, by the importer that wrote it', async () => {
    const { sql, calls } = makeFakeSql([{ company_number: '03260168' }]);
    const confirmed: DiscoveryOutcome = {
      ...byNumber,
      evidence: 'registry_confirmed',
      evidenceUrl: 'https://stored.co.uk/contact',
    };
    expect(await makeUpgrade(sql)(registryRow, confirmed, 0.97)).toBe(true);
    const { set, where } = halves(flat(calls[0].text));
    expect(where).toContain("evidence = 'registry' AND url = $");
    expect(where).toContain("status IN ('verified', 'unreachable')");
    expect(where).toContain('source = $');
    // Never moved, never re-published by the write itself: the sweep confirms it.
    expect(set).not.toMatch(/\b(url|status|source)\s*=/);
    expect(set).toContain('checked_at = NULL');
    expect(calls[0].params).toEqual(
      expect.arrayContaining([
        'registry_confirmed',
        'https://stored.co.uk/contact',
        'cqc',
        'https://stored.co.uk',
      ]),
    );
  });

  test('a registry row takes only its number or its confirmation', async () => {
    for (const evidence of ['postcode_on_page', 'name_and_place'] as const) {
      const { sql, calls } = makeFakeSql();
      const lower: DiscoveryOutcome = { ...byNumber, evidence };
      expect(await makeUpgrade(sql)(registryRow, lower, 0.9)).toBe(false);
      expect(calls).toHaveLength(0);
    }
    const { sql, calls } = makeFakeSql([{ company_number: '03260168' }]);
    expect(await makeUpgrade(sql)(registryRow, byNumber, 0.99)).toBe(true);
    expect(calls[0].params).toContain('crn_on_page');
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

  test("a registry row is stamped under its own importer's name", async () => {
    // Guarded on `search`, neither marker would land and the row would lead every slice.
    for (const mark of [makeMarkWalked, makeMarkUnreadable]) {
      const { sql, calls } = makeFakeSql();
      await mark(sql)(registryRow);
      const { where } = halves(flat(calls[0].text));
      expect(where).toContain('source = $');
      expect(where).not.toContain("source = 'search'");
      expect(calls[0].params).toEqual(
        expect.arrayContaining(['cqc', 'registry', 'https://stored.co.uk']),
      );
    }
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

  test('counts what the same selection would walk, registry rows and re-reads included', async () => {
    const { sql, calls } = makeFakeSql([{ none: 0, postcode: 0, registry: 7 }]);
    const left = await makeRewalkRemaining(sql, {
      evidence: 'registry',
      rereadBefore: '2026-11-16 00:00:00',
    })();
    expect(left).toEqual({ none: 0, postcode: 0, registry: 7 });
    const text = flat(calls[0].text);
    expect(text).toContain("source <> 'search' AND evidence = 'registry'");
    expect(text).toContain('walked_at < $');
    expect(calls[0].params).toEqual(
      expect.arrayContaining(['registry', '2026-11-16 00:00:00']),
    );
    // Asked for nothing in particular: the registry arm stays shut.
    const plain = makeFakeSql([{ none: 3, postcode: 2 }]);
    expect(await makeRewalkRemaining(plain.sql)()).toEqual({
      none: 3,
      postcode: 2,
      registry: 0,
    });
    expect(plain.calls[0].params).not.toContain('registry');
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

  test('reads how many attempts a row has spent, so the network gate counts first attempts', async () => {
    const { sql, calls } = makeFakeSql();
    await makeSelectRewalk(sql)(10);
    expect(flat(calls[0].text)).toContain('w.walk_attempts');
    const seeded = makeFakeSql();
    await makeSelectRewalk(seeded.sql, { seed: 's' })(10);
    // The seeded sample runs before the migration, so it cannot name the column.
    expect(flat(seeded.calls[0].text)).toContain('0 AS walk_attempts');
  });

  test("reads the company's name, which a postcode match must find on the site", async () => {
    for (const selection of [{}, { seed: 's' }]) {
      const { sql, calls } = makeFakeSql([
        { company_number: '03260168', company_name: 'ACME WIDGETS LIMITED' },
        { company_number: '03260169', company_name: null },
      ]);
      const rows = await makeSelectRewalk(sql, selection)(10);
      expect(flat(calls[0].text)).toContain(
        "coalesce(p.company_name, '') AS company_name",
      );
      expect(rows.map((r) => r.companyName)).toEqual([
        'ACME WIDGETS LIMITED',
        '',
      ]);
    }
  });

  test("reads the sponsor register's names, which a postcode match may find instead", async () => {
    for (const selection of [{}, { seed: 's' }]) {
      const { sql, calls } = makeFakeSql([
        {
          company_number: '03260168',
          [SPONSOR_NAMES_KEY]: ['Acme Widgets Ltd T/A Acme Dental'],
        },
        { company_number: '03260169', [SPONSOR_NAMES_KEY]: [] },
      ]);
      const rows = await makeSelectRewalk(sql, selection)(10);
      expect(calls[0].text).toContain(SPONSOR_NAMES_COLUMN);
      expect(rows.map((r) => r.sponsorNames)).toEqual([
        ['Acme Widgets Ltd T/A Acme Dental'],
        [],
      ]);
    }
  });

  test("reads the register's towns and the registered locality, the two-signal rule's places", async () => {
    for (const selection of [{}, { seed: 's' }]) {
      const { sql, calls } = makeFakeSql([
        {
          company_number: '09990117',
          locality: 'Harrogate',
          [SPONSOR_TOWNS_KEY]: ['Harrogate'],
        },
        { company_number: '09990118' },
      ]);
      const rows = await makeSelectRewalk(sql, selection)(10);
      expect(calls[0].text).toContain(SPONSOR_TOWNS_COLUMN);
      expect(flat(calls[0].text)).toContain(
        "coalesce(p.company_name, '') AS company_name, p.locality,",
      );
      expect(rows.map((r) => [r.registerTowns, r.locality])).toEqual([
        [['Harrogate'], 'Harrogate'],
        [[], null],
      ]);
    }
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

  test('takes registry rows only when asked for, and only those no page has confirmed', async () => {
    for (const selection of [{}, { seed: 's' }]) {
      const plain = makeFakeSql();
      await makeSelectRewalk(plain.sql, selection)(10);
      const text = flat(plain.calls[0].text);
      expect(text).toContain(
        "w.source <> 'search' AND w.evidence = 'registry' AND w.status IN ('verified', 'unreachable') AND w.url IS NOT NULL",
      );
      // The arm compares the selection to 'registry', so an unset one shuts it.
      expect(text).toMatch(/AND \$\d+::text = 'registry'\)/);
      expect(plain.calls[0].params).not.toContain('registry');
      const asked = makeFakeSql();
      await makeSelectRewalk(asked.sql, {
        ...selection,
        evidence: 'registry',
      })(10);
      expect(asked.calls[0].params).toContain('registry');
    }
  });

  test('a row keeps the source it was read under, search unless the row says otherwise', async () => {
    const { sql, calls } = makeFakeSql([
      { company_number: '03260168', evidence: 'registry', source: 'wikidata' },
      { company_number: '03260169', evidence: 'none' },
    ]);
    const rows = await makeSelectRewalk(sql, { evidence: 'registry' })(10);
    expect(flat(calls[0].text)).toContain('w.source,');
    expect(rows.map((r) => r.source)).toEqual(['wikidata', 'search']);
  });

  test('a re-read also takes rows this walk last read before the cutoff', async () => {
    const { sql, calls } = makeFakeSql();
    await makeSelectRewalk(sql, { rereadBefore: '2026-11-16 00:00:00' })(10);
    const text = flat(calls[0].text);
    expect(text).toMatch(
      /w\.walk_version IS NULL OR w\.walk_version < \$\d+ OR w\.walked_at < \$\d+::timestamp/,
    );
    expect(calls[0].params).toContain('2026-11-16 00:00:00');
    // Without a cutoff the comparison is against NULL, which takes no row.
    const plain = makeFakeSql();
    await makeSelectRewalk(plain.sql)(10);
    expect(plain.calls[0].params).toContain(null);
    expect(plain.calls[0].params).not.toContain('2026-11-16 00:00:00');
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
