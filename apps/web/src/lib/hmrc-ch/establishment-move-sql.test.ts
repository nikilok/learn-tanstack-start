import { describe, expect, test } from 'bun:test';

import { makeFakeSql } from '../websites/fake-sql';
import type { CommitMoveInput } from './establishment-move';
import {
  makeCommitMove,
  makeReadMoveStates,
  makeReadOverseasCompanies,
} from './establishment-move-sql';

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

const input: CommitMoveInput = {
  companyNumber: 'FC004891',
  establishmentNumber: 'BR000746',
  joins: [
    { organisationName: 'A', rowHash: 'hash of A' },
    { organisationName: 'B', rowHash: 'hash of B' },
  ],
  siteHash: 'hash of the site row',
  answers: 2,
  changedBy: 'uk_establishment_move',
};

describe('makeReadOverseasCompanies', () => {
  test('the companies with joins that the register types as overseas companies', async () => {
    const { sql, calls } = makeFakeSql([
      { company_number: 'FC000002' },
      { company_number: 'FC004891' },
    ]);
    expect(await makeReadOverseasCompanies(sql)()).toEqual([
      'FC000002',
      'FC004891',
    ]);
    expect(flat(calls[0].text)).toContain(
      "WHERE p.company_type = 'oversea-company'",
    );
  });
});

describe('makeReadMoveStates', () => {
  test('reads both numbers of every move, and keys what it finds by the overseas company', async () => {
    const joinA = {
      organisation_name: 'A',
      company_number: 'FC004891',
      match_method: 'exact',
    };
    const joinB = {
      organisation_name: 'B',
      company_number: 'BR000002',
      match_method: 'manual',
    };
    const site = {
      company_number: 'FC004891',
      url: 'https://www.quillmere.example',
    };
    const { sql, calls } = makeFakeSql(
      [
        { stored: joinA, row_hash: 'hash of A' },
        { stored: joinB, row_hash: 'hash of B' },
      ],
      [
        { stored: site, row_hash: 'hash of the site row' },
        { stored: { company_number: 'BR000002' }, row_hash: 'another' },
      ],
      [
        { company_number: 'FC004891', answers: 2 },
        { company_number: 'BR000002', answers: 1 },
      ],
    );
    const states = await makeReadMoveStates(sql)([
      { companyNumber: 'FC004891', establishmentNumber: 'BR000746' },
      { companyNumber: 'FC000002', establishmentNumber: 'BR000002' },
    ]);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.params).toEqual([
        ['FC004891', 'BR000746', 'FC000002', 'BR000002'],
      ]);
    }
    expect(states.get('FC004891')).toEqual({
      joins: [
        {
          stored: joinA,
          rowHash: 'hash of A',
          organisationName: 'A',
          matchMethod: 'exact',
        },
      ],
      movedJoins: 0,
      site: { stored: site, rowHash: 'hash of the site row' },
      establishmentHasSite: false,
      answers: 2,
      establishmentAnswers: 0,
    });
    expect(states.get('FC000002')).toEqual({
      joins: [],
      movedJoins: 1,
      site: null,
      establishmentHasSite: true,
      answers: 0,
      establishmentAnswers: 1,
    });
  });
});

describe('makeCommitMove', () => {
  test('one statement, bound to the rows the move was planned on', async () => {
    const { sql, calls } = makeFakeSql([
      { ok: true, joins: 2, sites: 1, answers: 2 },
    ]);
    expect(await makeCommitMove(sql)(input)).toEqual({
      joins: 2,
      sites: 1,
      answers: 2,
    });
    expect(calls).toHaveLength(1);
    const FC = 'FC004891';
    const BR = 'BR000746';
    const site = 'hash of the site row';
    expect(calls[0].params).toEqual([
      ['A', 'B'],
      ['hash of A', 'hash of B'],
      FC,
      FC,
      FC,
      site,
      site,
      BR,
      FC,
      2,
      2,
      BR,
      FC,
      BR,
      BR,
      'uk_establishment_move',
      BR,
      FC,
      BR,
      FC,
    ]);
  });

  test('every write holds only while the rows are as they were read', async () => {
    const { sql, calls } = makeFakeSql([
      { ok: true, joins: 2, sites: 1, answers: 2 },
    ]);
    await makeCommitMove(sql)(input);
    const text = flat(calls[0].text);
    // The joins are read under the check, and both their writes follow that read.
    expect(text).toContain(
      'old AS ( SELECT m.organisation_name, m.company_number, m.match_method FROM hmrc_company_mapping m WHERE m.company_number = $13 AND (SELECT ok FROM intact) )',
    );
    expect(text).toContain(
      'FROM old WHERE m.organisation_name = old.organisation_name',
    );
    expect(text).toContain('FROM old JOIN moved USING (organisation_name)');
    expect(text).toContain(
      'UPDATE company_websites w SET company_number = $17 WHERE w.company_number = $18 AND (SELECT ok FROM intact)',
    );
    expect(text).toContain(
      'UPDATE company_answers a SET company_number = $19 WHERE a.company_number = $20 AND (SELECT ok FROM intact)',
    );
    // Four writes in all, so none is left outside the check.
    expect(text.match(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\b/g)).toHaveLength(
      4,
    );
  });

  test('a moved join is stored as manual, with an audit row naming where it came from', async () => {
    const { sql, calls } = makeFakeSql([
      { ok: true, joins: 2, sites: 0, answers: 0 },
    ]);
    await makeCommitMove(sql)(input);
    const text = flat(calls[0].text);
    expect(text).toContain(
      "SET company_number = $14, match_method = 'manual', match_score = NULL, verified_at = now()",
    );
    expect(text).toContain(
      "SELECT old.organisation_name, old.company_number, $15, old.match_method, 'manual', $16",
    );
  });

  test('rows changed since they were read write nothing', async () => {
    const { sql } = makeFakeSql([
      { ok: false, joins: 0, sites: 0, answers: 0 },
    ]);
    expect(await makeCommitMove(sql)(input)).toBeNull();
  });

  test('no answer at all is nothing written', async () => {
    const { sql } = makeFakeSql([]);
    expect(await makeCommitMove(sql)(input)).toBeNull();
  });
});
