import { describe, expect, test } from 'bun:test';

import type { CHFullProfile } from '../phase5/decide';
import {
  applyMoves,
  type CommitMoveInput,
  type CommitMoveResult,
  type EstablishmentMove,
  findMoves,
  type MoveState,
  moveForSweep,
  moveKind,
  parseEstablishmentMoves,
  planMoves,
} from './establishment-move';
import type { ListedEstablishment } from './uk-establishment';

// JPMorgan Chase Bank's overseas record and its one UK establishment.
const JPM: EstablishmentMove = {
  companyNumber: 'FC004891',
  establishmentNumber: 'BR000746',
};
const OTHER: EstablishmentMove = {
  companyNumber: 'FC000002',
  establishmentNumber: 'BR000002',
};

/** An establishment's profile as Companies House gives it. */
const profile = (over: Record<string, unknown> = {}): CHFullProfile => ({
  company_number: 'BR000746',
  company_name: 'JPMORGAN CHASE BANK, NATIONAL ASSOCIATION',
  company_status: 'open',
  type: 'uk-establishment',
  branch_company_details: { parent_company_number: 'FC004891' },
  ...over,
});

/** A stored join on the overseas company. */
const join = (
  organisationName: string,
  matchMethod: string | null = 'exact',
) => ({
  stored: { organisation_name: organisationName, match_method: matchMethod },
  rowHash: `hash of ${organisationName}`,
  organisationName,
  matchMethod,
});

const SITE = {
  stored: { company_number: 'FC004891', url: 'https://www.quillmere.example' },
  rowHash: 'hash of the site row',
};

/** Two answers held for the overseas company, as stored. */
const ANSWERS = [11, 12].map((id) => ({
  stored: { id, company_number: 'FC004891', answer: `answer ${id}` },
  rowHash: `hash of answer ${id}`,
  id,
}));

/** The overseas company's website row at a given status and proof. */
const siteAt = (status: string, evidence: string) => ({
  stored: { ...SITE.stored, status, evidence },
  rowHash: SITE.rowHash,
});

/** What is stored for a move, one exact join unless told otherwise. */
const state = (over: Partial<MoveState> = {}): MoveState => ({
  joins: [join('JPMorgan Chase Bank, National Association')],
  movedJoins: 0,
  site: null,
  establishmentHasSite: false,
  answers: [],
  establishmentAnswers: 0,
  ...over,
});

const read = (states: Record<string, MoveState>) => async () =>
  new Map(Object.entries(states));

describe('parseEstablishmentMoves', () => {
  test('reads a list of moves', () => {
    expect(parseEstablishmentMoves([JPM, OTHER])).toEqual([JPM, OTHER]);
  });

  test.each([
    [{}, 'the list must be an array'],
    [[null], 'entry 0: companyNumber must be a company number'],
    [[{ ...JPM, companyNumber: 7 }], 'entry 0: companyNumber'],
    [
      [{ ...JPM, companyNumber: 'FC004891/officers' }],
      'entry 0: companyNumber',
    ],
    [[{ companyNumber: 'FC004891' }], 'entry 0: establishmentNumber'],
    [
      [{ ...JPM, establishmentNumber: ' BR000746' }],
      'entry 0: establishmentNumber',
    ],
    [
      [{ ...JPM, establishmentNumber: 'FC004891' }],
      'entry 0: a company number is listed twice',
    ],
    [[JPM, JPM], 'entry 1: a company number is listed twice'],
    [
      [JPM, { ...OTHER, establishmentNumber: 'BR000746' }],
      'entry 1: a company number is listed twice',
    ],
    [
      [JPM, { ...OTHER, companyNumber: 'BR000746' }],
      'entry 1: a company number is listed twice',
    ],
  ])('refuses %j', (raw, why) => {
    expect(parseEstablishmentMoves(raw)).toStartWith(why);
  });
});

describe('moveKind', () => {
  test('joins on the overseas company move', () => {
    expect(moveKind(state())).toBe('move');
  });

  // FC000071 lists twelve current officers and its establishment BR001924 none, so a site proved by an officer's name is proved on the overseas record alone.
  test.each([
    ['verified', 'name_and_place'],
    ['verified', 'registry_confirmed'],
    ['verified', 'postcode_on_page'],
    ['verified', 'assessed'],
    ['unreachable', 'name_and_place'],
  ])(
    'a website shown on a proof of the overseas record keeps the company where it is: %s, %s',
    (status, evidence) => {
      expect(
        moveKind(state({ site: siteAt(status, evidence), answers: ANSWERS })),
      ).toBe('site_bound');
    },
  );

  test.each([
    ['verified', 'crn_on_page'],
    ['verified', 'manual'],
    ['verified', 'registry'],
    ['dead', 'name_and_place'],
    ['candidate', 'postcode_on_page'],
    ['none', 'none'],
  ])(
    'any other website row goes with the joins: %s, %s',
    (status, evidence) => {
      expect(moveKind(state({ site: siteAt(status, evidence) }))).toBe('move');
    },
  );

  test("an owner's join comes before the website: the company is left as manual", () => {
    expect(
      moveKind(
        state({
          joins: [join('A', 'manual')],
          site: siteAt('verified', 'name_and_place'),
        }),
      ),
    ).toBe('manual');
  });

  test('a website row and answers go with them when the establishment has none', () => {
    expect(moveKind(state({ site: SITE, answers: ANSWERS }))).toBe('move');
  });

  test("the establishment's own rows do not matter when there is nothing to carry", () => {
    expect(
      moveKind(state({ establishmentHasSite: true, establishmentAnswers: 2 })),
    ).toBe('move');
  });

  test('no join left on the company, and one on the establishment, is already done', () => {
    expect(moveKind(state({ joins: [], movedJoins: 1 }))).toBe('already');
  });

  test('no join on either is missing', () => {
    expect(moveKind(state({ joins: [] }))).toBe('missing');
  });

  test("an owner's join on the company leaves the whole company", () => {
    expect(moveKind(state({ joins: [join('A'), join('B', 'manual')] }))).toBe(
      'manual',
    );
  });

  // Forestry Commission, the UK public body, is joined to Ghana Forestry Commission (FC025909) by a previous name: a move would store that join as manual.
  test('a join made on less than the full name leaves the whole company, to be read first', () => {
    expect(
      moveKind(
        state({
          joins: [
            join('Ghana Forestry Commission'),
            join('Forestry Commission', 'previous_name'),
          ],
        }),
      ),
    ).toBe('weak_join');
  });

  test.each([['previous_name'], ['token_sim'], ['fuzzy_edit'], [null]])(
    'a join made by %s is not on the full name',
    (method) => {
      expect(moveKind(state({ joins: [join('A', method)] }))).toBe('weak_join');
    },
  );

  test('a join on the squashed name is on the full name', () => {
    expect(moveKind(state({ joins: [join('A', 'exact_squash')] }))).toBe(
      'move',
    );
  });

  // A join that keeps its method stays under the sweeps, so nothing is settled by moving it.
  test.each([['previous_name'], ['token_sim'], ['fuzzy_edit'], [null]])(
    'a join made by %s moves with the rest when joins keep their methods',
    (method) => {
      expect(
        moveKind(state({ joins: [join('A'), join('B', method)] }), 'kept'),
      ).toBe('move');
    },
  );

  test("keeping methods moves no owner's join, no shown website and nothing onto rows of the establishment's own", () => {
    expect(moveKind(state({ joins: [join('A', 'manual')] }), 'kept')).toBe(
      'manual',
    );
    expect(
      moveKind(state({ site: siteAt('verified', 'name_and_place') }), 'kept'),
    ).toBe('site_bound');
    expect(
      moveKind(state({ site: SITE, establishmentHasSite: true }), 'kept'),
    ).toBe('site_conflict');
    expect(
      moveKind(state({ answers: ANSWERS, establishmentAnswers: 1 }), 'kept'),
    ).toBe('answers_conflict');
  });

  test('a website row on both is left', () => {
    expect(moveKind(state({ site: SITE, establishmentHasSite: true }))).toBe(
      'site_conflict',
    );
  });

  test('answers on both are left', () => {
    expect(moveKind(state({ answers: ANSWERS, establishmentAnswers: 1 }))).toBe(
      'answers_conflict',
    );
  });
});

describe('findMoves', () => {
  /** What the register lists under each test company; one it cannot answer for throws. */
  const register: Record<string, ListedEstablishment[] | null> = {
    FC004891: [{ company_number: 'BR000746', company_status: 'open' }],
    FC023485: [
      { company_number: 'BR006261', company_status: 'open' },
      { company_number: 'BR028851', company_status: 'open' },
    ],
    FC021303: [],
    FC000009: null,
  };
  const ask = async (companyNumber: string) => {
    const listed = register[companyNumber];
    if (!listed) throw new Error('HTTP 401');
    return listed;
  };

  test('lists each company with one open establishment, and counts the rest', async () => {
    expect(await findMoves(['FC004891', 'FC023485', 'FC021303'], ask)).toEqual({
      moves: [JPM],
      found: { one: 1, none: 1, several: 1, failed: 0 },
    });
  });

  test('a company that could not be asked is counted as failed, never as having none', async () => {
    expect(await findMoves(['FC000009', 'FC004891'], ask)).toEqual({
      moves: [JPM],
      found: { one: 1, none: 0, several: 0, failed: 1 },
    });
  });
});

describe('planMoves', () => {
  test('counts each outcome, and what the planned moves carry', async () => {
    const plan = await planMoves(
      [
        JPM,
        OTHER,
        { companyNumber: 'FC000003', establishmentNumber: 'BR000003' },
      ],
      read({
        FC004891: state({
          joins: [join('A'), join('B')],
          site: SITE,
          answers: ANSWERS,
        }),
        FC000002: state({ joins: [join('C', 'manual')], site: SITE }),
      }),
    );
    expect(plan.planned).toEqual({
      move: 1,
      already: 0,
      manual: 1,
      weak_join: 0,
      site_bound: 0,
      site_conflict: 0,
      answers_conflict: 0,
      missing: 1,
    });
    expect(plan.carried).toEqual({ joins: 2, sites: 1, answered: 1 });
    expect(plan.kinds.get('FC000003')).toBe('missing');
    expect(plan.storage).toBe('manual');
  });

  test('a plan that keeps methods carries a join made on less than the full name', async () => {
    const stored = {
      FC004891: state({ joins: [join('A'), join('B', 'previous_name')] }),
    };
    expect((await planMoves([JPM], read(stored))).planned).toMatchObject({
      move: 0,
      weak_join: 1,
    });
    const kept = await planMoves([JPM], read(stored), 'kept');
    expect(kept.planned).toMatchObject({ move: 1, weak_join: 0 });
    expect(kept.carried.joins).toBe(2);
    expect(kept.storage).toBe('kept');
  });
});

/** The one open establishment the register lists under a test company. */
const soleEstablishment = (companyNumber: string): ListedEstablishment[] => [
  {
    company_number:
      companyNumber === JPM.companyNumber
        ? JPM.establishmentNumber
        : companyNumber.replace('FC', 'BR'),
    company_status: 'open',
  },
];

/** The writes of a run, each recorded in order, with what they answer. */
function writes(over: {
  listed?: ListedEstablishment[] | Error;
  profile?: CHFullProfile | null | Error;
  commit?: CommitMoveResult | null;
  backup?: Error;
}) {
  const log: string[] = [];
  const commits: CommitMoveInput[] = [];
  const backups: Record<string, unknown>[][] = [];
  return {
    log,
    commits,
    backups,
    deps: {
      changedBy: 'uk_establishment_move',
      backup: async (stored: Record<string, unknown>[]) => {
        log.push('backup');
        if (over.backup) throw over.backup;
        backups.push(stored);
      },
      fetchEstablishments: async (companyNumber: string) => {
        log.push(`list ${companyNumber}`);
        if (over.listed instanceof Error) throw over.listed;
        return over.listed ?? soleEstablishment(companyNumber);
      },
      fetchProfile: async (companyNumber: string) => {
        log.push(`fetch ${companyNumber}`);
        const given = 'profile' in over ? over.profile : profile();
        if (given instanceof Error) throw given;
        return given ?? null;
      },
      storeProfile: async (stored: CHFullProfile) => {
        log.push(`store ${stored.company_number}`);
      },
      commit: async (input: CommitMoveInput) => {
        log.push(`commit ${input.companyNumber}`);
        commits.push(input);
        return 'commit' in over
          ? (over.commit ?? null)
          : { joins: input.joins.length, sites: 1, answers: 2 };
      },
    },
  };
}

describe('applyMoves', () => {
  test('backs the rows up, asks the register again, checks and stores the profile, then writes the move on what it was planned on', async () => {
    const stored = state({
      joins: [join('A'), join('B')],
      site: SITE,
      answers: ANSWERS,
    });
    const plan = await planMoves([JPM], read({ FC004891: stored }));
    const run = writes({});
    const result = await applyMoves([JPM], plan, run.deps);
    expect(run.log).toEqual([
      'backup',
      'list FC004891',
      'fetch BR000746',
      'store BR000746',
      'commit FC004891',
    ]);
    // Every row the move writes is kept as stored: its joins, its website row and its answers.
    expect(run.backups).toEqual([
      [
        {
          ...JPM,
          joins: stored.joins.map((j) => j.stored),
          site: SITE.stored,
          answers: ANSWERS.map((a) => a.stored),
        },
      ],
    ]);
    expect(run.commits).toEqual([
      {
        ...JPM,
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
      },
    ]);
    expect(result).toEqual({
      applied: {
        moved: 1,
        changed: 0,
        no_profile: 0,
        not_establishment: 0,
        errored: 0,
        not_tried: 0,
        left: 0,
      },
      written: { joins: 2, sites: 1, answers: 2 },
      failure: null,
    });
  });

  test('each move is written as its plan stores joins, never as the default', async () => {
    const stored = state({ joins: [join('A'), join('B', 'token_sim')] });
    const plan = await planMoves([JPM], read({ FC004891: stored }), 'kept');
    const run = writes({});
    const result = await applyMoves([JPM], plan, run.deps);
    expect(run.commits.map((c) => c.storage)).toEqual(['kept']);
    expect(run.commits[0].joins.map((j) => j.organisationName)).toEqual([
      'A',
      'B',
    ]);
    expect(result.applied).toMatchObject({ moved: 1, left: 0 });
  });

  test('a failed backup writes nothing', async () => {
    const plan = await planMoves([JPM], read({ FC004891: state() }));
    const run = writes({ backup: new Error('disk full') });
    const result = await applyMoves([JPM], plan, run.deps);
    expect(run.log).toEqual(['backup']);
    expect(result.applied).toBeNull();
    expect(result.failure).toBe(
      'nothing was written, as the backup failed: disk full',
    );
  });

  test('a move not planned is left, and not backed up', async () => {
    const plan = await planMoves(
      [JPM, OTHER],
      read({
        FC004891: state(),
        FC000002: state({ joins: [join('C', 'manual')] }),
      }),
    );
    const run = writes({});
    const result = await applyMoves([JPM, OTHER], plan, run.deps);
    expect(run.backups[0]).toHaveLength(1);
    expect(run.commits.map((c) => c.companyNumber)).toEqual(['FC004891']);
    expect(result.applied).toMatchObject({ moved: 1, left: 1 });
    expect(result.failure).toBeNull();
  });

  test.each([
    ['closed since', profile({ company_status: 'closed' })],
    [
      "another company's",
      profile({
        branch_company_details: { parent_company_number: 'FC000002' },
      }),
    ],
  ])(
    'an establishment %s is not written, and fails the run',
    async (_label, given) => {
      const plan = await planMoves([JPM], read({ FC004891: state() }));
      const run = writes({ profile: given });
      const result = await applyMoves([JPM], plan, run.deps);
      expect(run.log).toEqual(['backup', 'list FC004891', 'fetch BR000746']);
      expect(result.applied).toMatchObject({ moved: 0, not_establishment: 1 });
      expect(result.failure).toStartWith('1 planned moves were not written');
    },
  );

  // The list can be older than the register: Caixa Geral de Depositos has two open establishments, and a company with one may gain another.
  test.each([
    [
      'a second establishment has opened',
      [
        { company_number: 'BR000746', company_status: 'open' },
        { company_number: 'BR028851', company_status: 'open' },
      ],
    ],
    [
      'another establishment is now the open one',
      [
        { company_number: 'BR000746', company_status: 'closed' },
        { company_number: 'BR028851', company_status: 'open' },
      ],
    ],
    ['none is listed any more', []],
  ])(
    'when %s since the list was made, nothing is fetched or written, and the run fails',
    async (_label, listed) => {
      const plan = await planMoves([JPM], read({ FC004891: state() }));
      const run = writes({ listed });
      const result = await applyMoves([JPM], plan, run.deps);
      expect(run.log).toEqual(['backup', 'list FC004891']);
      expect(result.applied).toMatchObject({ moved: 0, not_establishment: 1 });
      expect(result.failure).toStartWith('1 planned moves were not written');
    },
  );

  test('a register that cannot say is an error, and nothing is written', async () => {
    const plan = await planMoves([JPM], read({ FC004891: state() }));
    const failed = new Error('the company is JPMorgan');
    failed.name = 'HTTP 502';
    const run = writes({ listed: failed });
    const result = await applyMoves([JPM], plan, run.deps);
    expect(run.log).toEqual(['backup', 'list FC004891']);
    expect(result.applied).toMatchObject({ moved: 0, errored: 1 });
    expect(result.failure).toBe(
      '1 planned moves were not written (first error: companies_house: HTTP 502); plan again and apply with a new --backup',
    );
  });

  test.each([
    ['no profile', null],
    ['a profile for another number', profile({ company_number: 'BR000002' })],
  ])('%s is not written, and fails the run', async (_label, given) => {
    const plan = await planMoves([JPM], read({ FC004891: state() }));
    const run = writes({ profile: given });
    const result = await applyMoves([JPM], plan, run.deps);
    expect(run.log).toEqual(['backup', 'list FC004891', 'fetch BR000746']);
    expect(result.applied).toMatchObject({ moved: 0, no_profile: 1 });
    expect(result.failure).toStartWith('1 planned moves were not written');
  });

  test('rows changed since they were read are left, and fail the run', async () => {
    const plan = await planMoves([JPM], read({ FC004891: state() }));
    const run = writes({ commit: null });
    const result = await applyMoves([JPM], plan, run.deps);
    expect(result.applied).toMatchObject({ moved: 0, changed: 1 });
    expect(result.written).toEqual({ joins: 0, sites: 0, answers: 0 });
    expect(result.failure).toBe(
      '1 planned moves were not written; plan again and apply with a new --backup',
    );
  });

  test('errors in a row stop the run, named by stage and kind only', async () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      companyNumber: `FC00001${i}`,
      establishmentNumber: `BR00001${i}`,
    }));
    const plan = await planMoves(
      entries,
      read(Object.fromEntries(entries.map((e) => [e.companyNumber, state()]))),
    );
    const failed = new Error('the company is JPMorgan');
    failed.name = 'HTTP 503';
    const run = writes({ profile: failed });
    const result = await applyMoves(entries, plan, run.deps);
    expect(result.applied).toMatchObject({
      errored: 5,
      not_tried: 2,
      moved: 0,
    });
    expect(result.failure).toBe(
      '7 planned moves were not written (first error: companies_house: HTTP 503); plan again and apply with a new --backup',
    );
  });
});

describe('moveForSweep', () => {
  const SPONSOR = 'JPMorgan Chase Bank, National Association';
  const BY = 'phase5_sweep_exact_establishment';

  /** One sweep's move of JPMorgan's company, over the rows given. */
  async function sweepMove(
    stored: MoveState | undefined,
    over: Parameters<typeof writes>[0] = {},
    dryRun = false,
  ) {
    const run = writes(over);
    const result = await moveForSweep(JPM, SPONSOR, BY, {
      ...run.deps,
      read: read(stored ? { FC004891: stored } : {}),
      dryRun,
    });
    return { run, result };
  }

  test('JPMorgan Chase Bank: the register is asked again, then every join moves with the method it had', async () => {
    const stored = state({
      joins: [join(SPONSOR), join('J.P. Morgan Chase Bank NA', 'exact_squash')],
      site: SITE,
      answers: ANSWERS,
    });
    const { run, result } = await sweepMove(stored);
    expect(run.log).toEqual([
      'list FC004891',
      'fetch BR000746',
      'store BR000746',
      'commit FC004891',
    ]);
    expect(run.commits).toEqual([
      {
        ...JPM,
        joins: stored.joins.map(({ organisationName, rowHash }) => ({
          organisationName,
          rowHash,
        })),
        siteHash: 'hash of the site row',
        answers: [
          { id: 11, rowHash: 'hash of answer 11' },
          { id: 12, rowHash: 'hash of answer 12' },
        ],
        changedBy: BY,
        storage: 'kept',
      },
    ]);
    expect(result).toEqual({
      kind: 'moved',
      written: { joins: 2, sites: 1, answers: 2 },
    });
    // A sweep's move changes nothing but the company number, so it keeps no backup.
    expect(run.backups).toEqual([]);
  });

  // Forestry Commission sits on Ghana Forestry Commission (FC025909) by a previous name: as wrong on either record, and still under the non-exact sweep after it moves.
  test('a join made on less than the full name moves with its company', async () => {
    const { run, result } = await sweepMove(
      state({ joins: [join(SPONSOR, 'previous_name')] }),
    );
    expect(result.kind).toBe('moved');
    expect(run.commits[0].storage).toBe('kept');
  });

  test.each([
    [
      'a website shown on a proof of the overseas record',
      state({ site: siteAt('verified', 'name_and_place') }),
      'site_bound',
    ],
    [
      "an owner's join beside the swept one",
      state({ joins: [join(SPONSOR), join('B', 'manual')] }),
      'manual',
    ],
    [
      "a website row of the establishment's own",
      state({ site: SITE, establishmentHasSite: true }),
      'site_conflict',
    ],
    [
      "answers of the establishment's own",
      state({ answers: ANSWERS, establishmentAnswers: 1 }),
      'answers_conflict',
    ],
  ] as const)(
    '%s holds the whole company, and nothing is asked or written',
    async (_label, stored, reason) => {
      const { run, result } = await sweepMove(stored);
      expect(result).toEqual({ kind: 'held', reason });
      expect(run.log).toEqual([]);
    },
  );

  test.each([
    [
      'is on the company no longer',
      state({ joins: [join('Another Sponsor')] }),
    ],
    ['has already moved', state({ joins: [], movedJoins: 1 })],
    ['has nothing stored', undefined],
  ])(
    'a swept join that %s writes nothing: its row has changed',
    async (_label, stored) => {
      const { run, result } = await sweepMove(stored);
      expect(result).toEqual({ kind: 'changed' });
      expect(run.log).toEqual([]);
    },
  );

  test('a dry run reads and decides, and neither asks the register nor writes', async () => {
    const { run, result } = await sweepMove(
      state({ site: SITE, answers: ANSWERS }),
      {},
      true,
    );
    expect(result).toEqual({ kind: 'moved', written: null });
    expect(run.log).toEqual([]);
  });

  // Caixa Geral de Depositos has two open establishments: a second one opening is the same case arriving later.
  test('a second establishment open by the time of the write holds the company', async () => {
    const { run, result } = await sweepMove(state(), {
      listed: [
        { company_number: 'BR000746', company_status: 'open' },
        { company_number: 'BR028851', company_status: 'open' },
      ],
    });
    expect(result).toEqual({ kind: 'held', reason: 'not_establishment' });
    expect(run.log).toEqual(['list FC004891']);
  });

  test('a profile for another number holds the company', async () => {
    const { result } = await sweepMove(state(), {
      profile: profile({ company_number: 'BR000002' }),
    });
    expect(result).toEqual({ kind: 'held', reason: 'no_profile' });
  });

  test('rows changed between the read and the write are left as changed', async () => {
    const { run, result } = await sweepMove(state(), { commit: null });
    expect(result).toEqual({ kind: 'changed' });
    expect(run.log.at(-1)).toBe('commit FC004891');
  });

  test('a register that cannot say stops the row, named by stage and kind only', async () => {
    const failed = new Error('the company is JPMorgan');
    failed.name = 'HTTP 502';
    const run = writes({ listed: failed });
    await expect(
      moveForSweep(JPM, SPONSOR, BY, {
        ...run.deps,
        read: read({ FC004891: state() }),
        dryRun: false,
      }),
    ).rejects.toThrow('companies_house: HTTP 502');
    expect(run.log).toEqual(['list FC004891']);
  });
});
