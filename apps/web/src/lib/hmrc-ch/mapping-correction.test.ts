import { describe, expect, test } from 'bun:test';

import type { CommitPromotionInput } from '../phase5/apply-promotion';
import {
  applyCorrections,
  correctionInput,
  correctionKind,
  type ListedMapping,
  type MappingCorrection,
  parseMappingCorrections,
  planCorrections,
} from './mapping-correction';

const VERIFIED_AT = new Date('2026-01-02T03:04:05.678Z');

/** A stored row joined to a company by the given method. */
const listed = (
  organisationName: string,
  companyNumber: string | null,
  matchMethod: string | null = 'exact',
): ListedMapping => ({
  stored: {
    organisation_name: organisationName,
    company_number: companyNumber,
  },
  organisationName,
  companyNumber,
  matchMethod,
  queryUsed: organisationName,
  verifiedAt: VERIFIED_AT,
});

const hold = (organisationName: string): MappingCorrection => ({
  organisationName,
  companyNumber: '00000001',
  newCompanyNumber: null,
});

const move = (organisationName: string): MappingCorrection => ({
  organisationName,
  companyNumber: '00000001',
  newCompanyNumber: '00000002',
});

describe('parseMappingCorrections', () => {
  test('reads holds and moves', () => {
    expect(
      parseMappingCorrections([hold('Northgate Bakery'), move('Quillmere')]),
    ).toEqual([hold('Northgate Bakery'), move('Quillmere')]);
  });

  test.each([
    [{}, 'the list must be an array'],
    [[null], 'entry 0: organisationName must be a non-empty string'],
    [[{ ...hold('A'), organisationName: '' }], 'entry 0: organisationName'],
    [
      [{ ...hold('A'), companyNumber: 7 }],
      'entry 0: companyNumber must be a company number',
    ],
    [
      [{ ...hold('A'), companyNumber: '0000/001' }],
      'entry 0: companyNumber must be a company number',
    ],
    [
      [{ ...move('A'), newCompanyNumber: '00000002/officers' }],
      'entry 0: newCompanyNumber must be null',
    ],
    [
      [{ ...move('A'), newCompanyNumber: ' 00000002' }],
      'entry 0: newCompanyNumber must be null',
    ],
    [
      [{ organisationName: 'A', companyNumber: '00000001' }],
      'entry 0: newCompanyNumber must be null',
    ],
    [
      [{ ...hold('A'), newCompanyNumber: '' }],
      'entry 0: newCompanyNumber must be null',
    ],
    [[{ ...hold('A'), newCompanyNumber: '00000001' }], 'already holds'],
    [[hold('A'), move('A')], 'entry 1: its organisationName is listed twice'],
  ])('refuses a list that is wrong: %#', (raw, message) => {
    const parsed = parseMappingCorrections(raw);
    expect(typeof parsed).toBe('string');
    expect(parsed).toContain(message);
  });

  test('prefixed numbers and leading zeroes are company numbers', () => {
    const entry = {
      organisationName: 'A',
      companyNumber: 'SC123456',
      newCompanyNumber: '00012345',
    };
    expect(parseMappingCorrections([entry])).toEqual([entry]);
  });

  test('a refusal never quotes a name from the list', () => {
    expect(
      parseMappingCorrections([
        hold('Northgate Bakery'),
        hold('Northgate Bakery'),
      ]),
    ).not.toContain('Northgate');
  });
});

describe('correctionKind', () => {
  test('a join still on the listed company is held or moved', () => {
    expect(correctionKind(hold('A'), listed('A', '00000001'))).toBe('hold');
    expect(correctionKind(move('A'), listed('A', '00000001'))).toBe('repoint');
  });

  test.each(['exact', 'exact_squash', 'previous_name', 'token_sim'])(
    'a %s join is corrected',
    (method) => {
      expect(correctionKind(hold('A'), listed('A', '00000001', method))).toBe(
        'hold',
      );
    },
  );

  test('a row that is not there is missing', () => {
    expect(correctionKind(hold('A'), undefined)).toBe('missing');
  });

  test('a join on another company than listed differs', () => {
    expect(correctionKind(hold('A'), listed('A', '00000009'))).toBe('differs');
    expect(correctionKind(hold('A'), listed('A', null, 'no_match'))).toBe(
      'differs',
    );
  });

  test.each(['fuzzy_edit', 'public_body', 'manual', null])(
    'a join made by %s differs',
    (method) => {
      expect(correctionKind(hold('A'), listed('A', '00000001', method))).toBe(
        'differs',
      );
    },
  );

  test('a correction already made is not made again', () => {
    expect(correctionKind(hold('A'), listed('A', null, 'manual'))).toBe(
      'already',
    );
    expect(correctionKind(move('A'), listed('A', '00000002', 'manual'))).toBe(
      'already',
    );
  });
});

describe('correctionInput', () => {
  test('a hold clears the company, keeps the query, and is guarded on the row as read', () => {
    expect(
      correctionInput(listed('A', '00000001', 'token_sim'), null, 'owner'),
    ).toEqual({
      organisationName: 'A',
      originalVerifiedAt: VERIFIED_AT,
      newCompanyNumber: null,
      newMatchMethod: 'manual',
      newMatchScore: null,
      newQueryUsed: 'A',
      newIsPublicBody: false,
      oldCompanyNumber: '00000001',
      oldMatchMethod: 'token_sim',
      changedBy: 'owner',
    });
  });

  test('a move names the new company', () => {
    const input = correctionInput(listed('A', '00000001'), '00000002', 'owner');
    expect(input.newCompanyNumber).toBe('00000002');
    expect(input.newMatchMethod).toBe('manual');
    expect(input.oldCompanyNumber).toBe('00000001');
  });
});

describe('planCorrections', () => {
  test('reads the listed names once and counts what each comes to', async () => {
    const asked: (readonly string[])[] = [];
    const entries = [hold('A'), move('B'), hold('C'), hold('D'), hold('E')];
    const plan = await planCorrections(entries, async (names) => {
      asked.push(names);
      return [
        listed('A', '00000001'),
        listed('B', '00000001'),
        listed('C', null, 'manual'),
        listed('D', '00000009'),
      ];
    });
    expect(asked).toEqual([['A', 'B', 'C', 'D', 'E']]);
    expect(plan.planned).toEqual({
      hold: 1,
      repoint: 1,
      already: 1,
      differs: 1,
      missing: 1,
    });
    expect(plan.kinds.get('B')).toBe('repoint');
  });
});

describe('applyCorrections', () => {
  /** Writes that record what was asked of them, in order. */
  function writes(
    over: {
      commit?: (input: CommitPromotionInput) => Promise<object | null>;
      fetchProfile?: (number: string) => Promise<object | null>;
      storeProfile?: () => Promise<void>;
    } = {},
  ) {
    const log: string[] = [];
    return {
      log,
      changedBy: 'owner',
      backup: async (stored: Record<string, unknown>[]) => {
        log.push(`backup:${stored.length}`);
      },
      commit: async (input: CommitPromotionInput) => {
        log.push(`commit:${input.organisationName}:${input.newCompanyNumber}`);
        const done = over.commit ? await over.commit(input) : {};
        return done as never;
      },
      fetchProfile: async (number: string) => {
        log.push(`fetch:${number}`);
        const profile = over.fetchProfile
          ? await over.fetchProfile(number)
          : { company_number: number, company_name: 'A COMPANY LIMITED' };
        return profile as never;
      },
      storeProfile: async (profile: { company_number: string }) => {
        log.push(`store:${profile.company_number}`);
        await over.storeProfile?.();
      },
    };
  }
  const entries = [hold('A'), move('B'), hold('C'), hold('D'), hold('E')];
  const read = async () => [
    listed('A', '00000001'),
    listed('B', '00000001'),
    listed('C', null, 'manual'),
    listed('D', '00000009'),
  ];
  const none = {
    held: 0,
    repointed: 0,
    changed: 0,
    no_profile: 0,
    errored: 0,
    not_tried: 0,
    left: 0,
  };

  test('backs every listed row up first, then writes only the planned corrections', async () => {
    const plan = await planCorrections(entries, read);
    const w = writes();
    const result = await applyCorrections(entries, plan, w);
    expect(w.log).toEqual([
      'backup:4',
      'commit:A:null',
      'fetch:00000002',
      'store:00000002',
      'commit:B:00000002',
    ]);
    expect(result).toEqual({
      applied: { ...none, held: 1, repointed: 1, left: 3 },
      failure: null,
    });
  });

  test('a failed backup writes nothing', async () => {
    const plan = await planCorrections(entries, read);
    const w = writes();
    const result = await applyCorrections(entries, plan, {
      ...w,
      backup: async () => {
        throw new Error('file exists');
      },
    });
    expect(w.log).toEqual([]);
    expect(result.applied).toBeNull();
    expect(result.failure).toContain('file exists');
  });

  test('a row that changed since it was read is left, and fails the run', async () => {
    const plan = await planCorrections(entries, read);
    const result = await applyCorrections(
      entries,
      plan,
      writes({ commit: async () => null }),
    );
    expect(result.applied).toEqual({ ...none, changed: 2, left: 3 });
    expect(result.failure).toContain('2 planned rows were not written');
    expect(result.failure).toContain('plan again');
  });

  test('a move to a company with no profile changes nothing for that row', async () => {
    const plan = await planCorrections(entries, read);
    const w = writes({ fetchProfile: async () => null });
    const result = await applyCorrections(entries, plan, w);
    expect(w.log).toEqual(['backup:4', 'commit:A:null', 'fetch:00000002']);
    expect(result.applied).toEqual({
      ...none,
      held: 1,
      no_profile: 1,
      left: 3,
    });
    expect(result.failure).toContain('plan again');
  });

  test('a profile for another number moves nothing', async () => {
    const plan = await planCorrections(entries, read);
    const w = writes({
      fetchProfile: async () => ({ company_number: '00000099' }),
    });
    const result = await applyCorrections(entries, plan, w);
    expect(w.log).toEqual(['backup:4', 'commit:A:null', 'fetch:00000002']);
    expect(result.applied).toEqual({
      ...none,
      held: 1,
      no_profile: 1,
      left: 3,
    });
  });

  test('a failed profile write leaves the join as it was, to be planned again', async () => {
    const plan = await planCorrections(entries, read);
    const w = writes({
      storeProfile: async () => {
        throw new TypeError('the row Northgate could not be stored');
      },
    });
    const result = await applyCorrections(entries, plan, w);
    expect(w.log).toEqual([
      'backup:4',
      'commit:A:null',
      'fetch:00000002',
      'store:00000002',
    ]);
    expect(result.applied).toEqual({ ...none, held: 1, errored: 1, left: 3 });
    expect(result.failure).toContain('first error: TypeError');
    expect(result.failure).not.toContain('Northgate');
  });

  test('stops trying after five errors in a row', async () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const many = names.map(hold);
    const plan = await planCorrections(many, async () =>
      names.map((n) => listed(n, '00000001')),
    );
    const w = writes({
      commit: async () => {
        throw new Error('down');
      },
    });
    const result = await applyCorrections(many, plan, w);
    expect(w.log.filter((l) => l.startsWith('commit:'))).toHaveLength(5);
    expect(result.applied).toEqual({ ...none, errored: 5, not_tried: 2 });
    expect(result.failure).toContain('7 planned rows were not written');
  });

  test('an error between good writes does not stop the run', async () => {
    const names = ['A', 'B', 'C'];
    const many = names.map(hold);
    const plan = await planCorrections(many, async () =>
      names.map((n) => listed(n, '00000001')),
    );
    const result = await applyCorrections(
      many,
      plan,
      writes({
        commit: async (input) => {
          if (input.organisationName === 'B') throw new Error('blip');
          return {};
        },
      }),
    );
    expect(result.applied).toEqual({ ...none, held: 2, errored: 1 });
  });
});
