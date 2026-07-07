import { describe, expect, test } from 'bun:test';

import { parseHmrcName, squashForComparison } from '../hmrc-ch/pipeline.ts';
import type { BacklogEntry } from './backlog-index.ts';
import { buildBacklogIndex, matchSnapshotCompany } from './backlog-index.ts';
import { pickForOrg } from './pick-candidate.ts';
import {
  isSnapshotActive,
  type SnapshotCompany,
  snapshotRowToCompany,
} from './snapshot-row.ts';

const entry = (org: string, over: Partial<BacklogEntry> = {}): BacklogEntry => {
  const legal = parseHmrcName(org).parsedLegal;
  return {
    organisationName: org,
    legal,
    squash: squashForComparison(legal),
    townCity: null,
    county: null,
    ...over,
  };
};

const company = (over: Partial<SnapshotCompany> = {}): SnapshotCompany => ({
  companyNumber: '08065565',
  name: 'J S B HAULAGE LIMITED',
  status: 'Active',
  postTown: 'DUMFRIES',
  county: null,
  previousNames: [],
  ...over,
});

describe('snapshotRowToCompany', () => {
  test('maps the columns and collects previous names', () => {
    const c = snapshotRowToCompany({
      CompanyName: 'ACME TRADING LIMITED',
      CompanyNumber: '01234567',
      CompanyStatus: 'Active',
      'RegAddress.PostTown': 'LEEDS',
      'RegAddress.County': 'WEST YORKSHIRE',
      'PreviousName_1.CompanyName': 'ACME WIDGETS LIMITED',
      'PreviousName_2.CompanyName': '',
      'PreviousName_3.CompanyName': 'ACME HOLDINGS LIMITED',
    });
    expect(c).toEqual({
      companyNumber: '01234567',
      name: 'ACME TRADING LIMITED',
      status: 'Active',
      postTown: 'LEEDS',
      county: 'WEST YORKSHIRE',
      previousNames: ['ACME WIDGETS LIMITED', 'ACME HOLDINGS LIMITED'],
    });
  });

  test('rows without name or number are unusable', () => {
    expect(snapshotRowToCompany({ CompanyName: 'X' })).toBeNull();
    expect(snapshotRowToCompany({ CompanyNumber: '123' })).toBeNull();
  });

  test('isSnapshotActive covers strike-off proposals, not liquidation', () => {
    expect(isSnapshotActive('Active')).toBe(true);
    expect(isSnapshotActive('Active - Proposal to Strike off')).toBe(true);
    expect(isSnapshotActive('Liquidation')).toBe(false);
    expect(isSnapshotActive('')).toBe(false);
  });
});

describe('matchSnapshotCompany — exact/squash path', () => {
  test('byte-equal name hits Tier A; punctuation variant hits Tier A2', () => {
    const index = buildBacklogIndex([
      entry('J S B Haulage Limited'),
      entry('JSB Haulage LTD'),
    ]);
    const hits = matchSnapshotCompany(index, company());
    const tiers = hits
      .map((h) => `${h.entry.organisationName}:${h.tier}`)
      .sort();
    expect(tiers).toEqual(['J S B Haulage Limited:A', 'JSB Haulage LTD:A2']);
  });

  test('unrelated companies produce no hits', () => {
    const index = buildBacklogIndex([entry('JSB Haulage LTD')]);
    const hits = matchSnapshotCompany(
      index,
      company({ name: 'JSB LIMITED', companyNumber: '11758030' }),
    );
    expect(hits).toHaveLength(0);
  });
});

describe('matchSnapshotCompany — previous-name path', () => {
  test('backlog name matching a previous name hits Tier B', () => {
    const index = buildBacklogIndex([entry('Acme Widgets Limited')]);
    const hits = matchSnapshotCompany(
      index,
      company({
        name: 'TOTALLY RENAMED LIMITED',
        previousNames: ['ACME WIDGETS LIMITED'],
      }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].tier).toBe('B');
    expect(hits[0].score).toBe(0.95);
  });

  test('TRADING AS previous names are excluded, matching the online Tier B', () => {
    const index = buildBacklogIndex([entry('Roosters Piri Piri Limited')]);
    const hits = matchSnapshotCompany(
      index,
      company({
        name: 'A CLASS FOOD LIMITED',
        previousNames: ['A CLASS FOOD TRADING AS ROOSTERS PIRI PIRI LIMITED'],
      }),
    );
    // The squash index may pre-fetch, but matchTierB's exclusion drops it.
    expect(hits).toHaveLength(0);
  });
});

describe('matchSnapshotCompany — fuzzy path gates', () => {
  const typoEntry = entry('Madani Food Products Ltd', {
    townCity: 'Leicester',
    county: null,
  });

  test('typo match requires locality corroboration', () => {
    const index = buildBacklogIndex([typoEntry]);
    const withLocality = matchSnapshotCompany(
      index,
      company({ name: 'MADNI FOOD PRODUCTS LTD', postTown: 'Leicester' }),
    );
    expect(withLocality).toHaveLength(1);
    expect(withLocality[0].tier).toBe('D');

    const wrongTown = matchSnapshotCompany(
      index,
      company({ name: 'MADNI FOOD PRODUCTS LTD', postTown: 'Manchester' }),
    );
    expect(wrongTown).toHaveLength(0);
  });

  test('inactive companies never fuzzy-match', () => {
    const index = buildBacklogIndex([typoEntry]);
    const hits = matchSnapshotCompany(
      index,
      company({
        name: 'MADNI FOOD PRODUCTS LTD',
        postTown: 'Leicester',
        status: 'Liquidation',
      }),
    );
    expect(hits).toHaveLength(0);
  });
});

describe('pickForOrg', () => {
  const org = entry('Acme Trading Limited', { townCity: 'Leeds' });

  const hit = (
    tier: 'A' | 'A2' | 'B' | 'D',
    over: Partial<SnapshotCompany> = {},
    score = 1,
  ) => ({
    entry: org,
    company: company(over),
    tier,
    score,
  });

  test('strongest tier wins', () => {
    const out = pickForOrg(
      [
        hit('B', { companyNumber: '1' }, 0.95),
        hit('A2', { companyNumber: '2' }, 0.98),
      ],
      'Leeds',
      null,
    );
    expect(out.kind).toBe('picked');
    if (out.kind !== 'picked') return;
    expect(out.hit.company.companyNumber).toBe('2');
  });

  test('active beats inactive within a tier', () => {
    const out = pickForOrg(
      [
        hit('A2', { companyNumber: '1', status: 'Liquidation' }, 0.98),
        hit('A2', { companyNumber: '2', status: 'Active' }, 0.98),
      ],
      null,
      null,
    );
    expect(out.kind).toBe('picked');
    if (out.kind !== 'picked') return;
    expect(out.hit.company.companyNumber).toBe('2');
  });

  test('same company via name + previous name dedupes to one hit', () => {
    const out = pickForOrg(
      [
        hit('A2', { companyNumber: '1' }, 0.98),
        hit('A2', { companyNumber: '1' }, 0.98),
      ],
      null,
      null,
    );
    expect(out.kind).toBe('picked');
  });

  test('two same-tier candidates split by locality tiebreak', () => {
    const out = pickForOrg(
      [
        hit('A2', { companyNumber: '1', postTown: 'LEEDS' }, 0.98),
        hit('A2', { companyNumber: '2', postTown: 'GLASGOW' }, 0.98),
      ],
      'Leeds',
      null,
    );
    expect(out.kind).toBe('picked');
    if (out.kind !== 'picked') return;
    expect(out.hit.company.companyNumber).toBe('1');
  });

  test('unresolvable ambiguity fails closed', () => {
    const out = pickForOrg(
      [
        hit('A2', { companyNumber: '1', postTown: 'HULL' }, 0.98),
        hit('A2', { companyNumber: '2', postTown: 'YORK' }, 0.98),
      ],
      'Leeds',
      null,
    );
    expect(out.kind).toBe('tied');
  });
});

describe('pickForOrg — active preference crosses tiers (resolver cascade)', () => {
  const org = entry('Acme Care Limited');
  test('an active Tier-B successor beats an inactive Tier-A namesake', () => {
    const out = pickForOrg(
      [
        {
          entry: org,
          company: company({
            companyNumber: '1',
            name: 'ACME CARE LIMITED',
            status: 'Liquidation',
          }),
          tier: 'A',
          score: 1,
        },
        {
          entry: org,
          company: company({
            companyNumber: '2',
            name: 'TOTALLY RENAMED LIMITED',
            status: 'Active',
            previousNames: ['ACME CARE LIMITED'],
          }),
          tier: 'B',
          score: 0.95,
        },
      ],
      null,
      null,
    );
    expect(out.kind).toBe('picked');
    if (out.kind !== 'picked') return;
    expect(out.hit.company.companyNumber).toBe('2');
  });

  test('inactive pool still competes when no hit is active at any tier', () => {
    const out = pickForOrg(
      [
        {
          entry: org,
          company: company({ companyNumber: '1', status: 'Liquidation' }),
          tier: 'A',
          score: 1,
        },
      ],
      null,
      null,
    );
    expect(out.kind).toBe('picked');
  });
});

describe('matchSnapshotCompany — short-squash previous names still reach Tier B', () => {
  test('prev name sharing a sub-minimum squash with the current name is not dropped', () => {
    const shortEntry = entry('S K Ltd');
    const index = buildBacklogIndex([shortEntry]);
    const hits = matchSnapshotCompany(
      index,
      company({
        name: 'S.K. LIMITED', // Tier A fails (dots), A2 fails (squash "SK" < 3)
        previousNames: ['S K LIMITED'], // matchTierB exact-normalised hit
      }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].tier).toBe('B');
  });
});
