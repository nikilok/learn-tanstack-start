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
  answers: [
    { id: 11, rowHash: 'hash of answer 11' },
    { id: 12, rowHash: 'hash of answer 12' },
  ],
  changedBy: 'uk_establishment_move',
  storage: 'manual',
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
    const answer = (id: number, companyNumber: string) => ({
      id,
      company_number: companyNumber,
      answer: `answer ${id}`,
    });
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
        { stored: answer(11, 'FC004891'), row_hash: 'hash of answer 11' },
        { stored: answer(12, 'FC004891'), row_hash: 'hash of answer 12' },
        { stored: answer(21, 'BR000002'), row_hash: 'hash of answer 21' },
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
      // Each answer as stored, for the backup, with the hash its move is guarded on.
      answers: [
        {
          stored: answer(11, 'FC004891'),
          rowHash: 'hash of answer 11',
          id: 11,
        },
        {
          stored: answer(12, 'FC004891'),
          rowHash: 'hash of answer 12',
          id: 12,
        },
      ],
      establishmentAnswers: 0,
    });
    expect(states.get('FC000002')).toEqual({
      joins: [],
      movedJoins: 1,
      site: null,
      establishmentHasSite: true,
      answers: [],
      establishmentAnswers: 1,
    });
  });
});

describe('makeCommitMove', () => {
  const written = [{ ok: true, joins: 2, sites: 1, answers: 2 }];

  test('one statement, bound to the rows the move was planned on', async () => {
    const { sql, calls } = makeFakeSql(written);
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
      [11, 12],
      ['hash of answer 11', 'hash of answer 12'],
      FC,
      FC,
      FC,
      site,
      site,
      BR,
      BR,
      // Whether joins keep their methods: bound once, read wherever the two ways differ.
      false,
      BR,
      BR,
      'uk_establishment_move',
      BR,
      FC,
      BR,
      FC,
    ]);
  });

  test('it locks every row it moves, and checks the rows as locked', async () => {
    const { sql, calls } = makeFakeSql(written);
    await makeCommitMove(sql)(input);
    const text = flat(calls[0].text);
    expect(text).toContain(
      'joins AS MATERIALIZED ( SELECT m.organisation_name, m.company_number, m.match_method, md5(m::text) AS row_hash FROM hmrc_company_mapping m WHERE m.company_number = $5 FOR UPDATE )',
    );
    expect(text).toContain(
      'site_row AS MATERIALIZED ( SELECT md5(w::text) AS row_hash FROM company_websites w WHERE w.company_number = $6 FOR UPDATE )',
    );
    expect(text).toContain(
      'answer_rows AS MATERIALIZED ( SELECT a.id, md5(a::text) AS row_hash FROM company_answers a WHERE a.company_number = $7 FOR UPDATE )',
    );
    // Every join, the website row and every answer: each as planned, and none besides.
    expect(text).toContain(
      'FROM joins j JOIN expected e ON e.organisation_name = j.organisation_name AND e.row_hash = j.row_hash) = (SELECT count(*) FROM expected) AND (SELECT count(*) FROM joins) = (SELECT count(*) FROM expected)',
    );
    expect(text).toContain(
      '(SELECT s.row_hash FROM site_row s) IS NOT DISTINCT FROM $8::text',
    );
    expect(text).toContain(
      'FROM answer_rows r JOIN expected_answers x ON x.id = r.id AND x.row_hash = r.row_hash) = (SELECT count(*) FROM expected_answers) AND (SELECT count(*) FROM answer_rows) = (SELECT count(*) FROM expected_answers)',
    );
  });

  test('every write holds only while the check passes', async () => {
    const { sql, calls } = makeFakeSql(written);
    await makeCommitMove(sql)(input);
    const text = flat(calls[0].text);
    // The joins are written from the locked rows, and their audit rows from what was written.
    expect(text).toContain(
      'FROM joins j WHERE m.organisation_name = j.organisation_name AND (SELECT ok FROM intact)',
    );
    expect(text).toContain('FROM joins j JOIN moved USING (organisation_name)');
    expect(text).toContain(
      'UPDATE company_websites w SET company_number = $16 WHERE w.company_number = $17 AND (SELECT ok FROM intact)',
    );
    expect(text).toContain(
      'UPDATE company_answers a SET company_number = $18 WHERE a.company_number = $19 AND (SELECT ok FROM intact)',
    );
    // Four writes in all, so none is left outside the check.
    expect(
      text.match(/\b(?:UPDATE \w+ \w+ SET|INSERT INTO|DELETE FROM)\b/g),
    ).toHaveLength(4);
  });

  test('a join is stored as manual or with the method it had, by one bound flag, with an audit row naming where it came from', async () => {
    const { sql, calls } = makeFakeSql(written);
    await makeCommitMove(sql)(input);
    const text = flat(calls[0].text);
    expect(text).toContain('mode AS ( SELECT $12::boolean AS keep )');
    // Kept: the method, score and check time stay as stored. Otherwise manual, no score, stamped now.
    expect(text).toContain(
      "SET company_number = $13, match_method = CASE WHEN (SELECT keep FROM mode) THEN m.match_method ELSE 'manual' END, match_score = CASE WHEN (SELECT keep FROM mode) THEN m.match_score END, verified_at = CASE WHEN (SELECT keep FROM mode) THEN m.verified_at ELSE now() END",
    );
    expect(text).toContain(
      "SELECT j.organisation_name, j.company_number, $14, j.match_method, CASE WHEN (SELECT keep FROM mode) THEN j.match_method ELSE 'manual' END, $15",
    );
    // The flag is bound in one place only, so the four readings cannot disagree.
    expect(text.match(/::boolean/g)).toHaveLength(1);
  });

  test.each([
    ['manual', false],
    ['kept', true],
  ] as const)('joins stored as %s bind the flag %s', async (storage, flag) => {
    const { sql, calls } = makeFakeSql(written);
    await makeCommitMove(sql)({ ...input, storage });
    expect(calls[0].params[11]).toBe(flag);
  });

  test('a company with no answers binds none', async () => {
    const { sql, calls } = makeFakeSql(written);
    await makeCommitMove(sql)({ ...input, siteHash: null, answers: [] });
    expect(calls[0].params.slice(2, 4)).toEqual([[], []]);
    expect(calls[0].params.slice(7, 9)).toEqual([null, null]);
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
