import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  coolingStatement,
  coolingUntil,
  createPruner,
  HOLD_TOKENS,
  holdAsk,
  holdStatement,
  minimumCharge,
  pruneStatement,
  type Run,
  settleAsk,
  settleStatement,
  statementFailure,
  tokenBudget,
} from './allowance.server';
import { COOLDOWN_SECONDS } from './cooldown';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const UNTIL = 1_800_000_000_000;
const BUDGET = 1_000_000;
// The start of a window, as the database says it.
const OPENED = '2026-11-21 14:05:00.123456+00';
const dialect = new PgDialect();

/** A statement as the driver would send it. */
const sent = (statement: SQL) => dialect.sqlToQuery(statement);

/** Which of the module's statements one is, by its verb. */
const verb = (statement: SQL) => sent(statement).sql.trim().split(/\s+/)[0];

/** A store answering each statement from a queue for its verb, recording what it ran and with which values. */
function store(answers: {
  INSERT?: unknown[][];
  SELECT?: unknown[][];
  UPDATE?: (unknown[] | Error)[];
  DELETE?: (unknown[] | Error)[];
}) {
  const ran: string[] = [];
  const params: unknown[][] = [];
  const run: Run = async (statement) => {
    const kind = verb(statement) as keyof typeof answers;
    ran.push(kind);
    params.push(sent(statement).params);
    const next = answers[kind]?.shift();
    if (next === undefined) throw new Error(`no ${kind} answer queued`);
    if (next instanceof Error) throw next;
    return { rows: next };
  };
  return { run, ran, params };
}

describe('tokenBudget', () => {
  test('a whole number from one up is the budget', () => {
    expect(tokenBudget('1')).toBe(1);
    expect(tokenBudget('750000')).toBe(750_000);
    expect(tokenBudget('999999999')).toBe(999_999_999);
  });

  test('unset is none, whatever the machine running the tests has set', () => {
    const found = process.env.ASK_DAILY_TOKENS;
    try {
      delete process.env.ASK_DAILY_TOKENS;
      expect(tokenBudget()).toBeNull();
      process.env.ASK_DAILY_TOKENS = '750000';
      expect(tokenBudget()).toBe(750_000);
    } finally {
      if (found === undefined) delete process.env.ASK_DAILY_TOKENS;
      else process.env.ASK_DAILY_TOKENS = found;
    }
  });

  test('empty or anything else is none: asking is never opened on a value nobody meant', () => {
    for (const value of [
      '',
      '0',
      '-5',
      '020',
      '2.5',
      '1.5M',
      '1e6',
      ' 750000',
      '750000 ',
      '750,000',
      'plenty',
      '1000000000',
    ])
      expect(tokenBudget(value)).toBeNull();
  });

  test('the largest budget and a hold together still fit the column', () => {
    expect(999_999_999 + HOLD_TOKENS).toBeLessThan(2 ** 31 - 1);
  });
});

describe('minimumCharge', () => {
  test('is a hundredth of the budget, so a budget never covers more than a hundred asks', () => {
    expect(minimumCharge(1_000_000)).toBe(10_000);
    expect(minimumCharge(400_000)).toBe(4_000);
  });

  test('rounds up, and is never nothing', () => {
    expect(minimumCharge(250)).toBe(3);
    expect(minimumCharge(1)).toBe(1);
    expect(minimumCharge(99)).toBe(1);
  });
});

describe('the statements', () => {
  test('the key, the hold, the budget, the charge and the window are bound, never spliced', () => {
    const hold = sent(holdStatement(KEY, BUDGET));
    expect(hold.params).toEqual([KEY, HOLD_TOKENS, BUDGET, BUDGET]);
    expect(hold.sql).not.toContain(KEY);
    expect(hold.sql).not.toContain(String(BUDGET));
    const settle = sent(settleStatement(KEY, OPENED, 41_000, BUDGET));
    expect(settle.params).toEqual([
      HOLD_TOKENS,
      41_000,
      HOLD_TOKENS,
      41_000,
      BUDGET,
      KEY,
      OPENED,
    ]);
    expect(settle.sql).not.toContain(KEY);
    expect(settle.sql).not.toContain(OPENED);
    const cooling = sent(coolingStatement(KEY));
    expect(cooling.params).toEqual([KEY]);
    expect(cooling.sql).not.toContain(KEY);
    expect(sent(pruneStatement()).params).toEqual([]);
  });

  test('the window and the cooldown run the one length the browser is told', () => {
    const span = `interval '${COOLDOWN_SECONDS} seconds'`;
    expect(sent(holdStatement(KEY, BUDGET)).sql).toContain(span);
    expect(sent(settleStatement(KEY, OPENED, 1, BUDGET)).sql).toContain(span);
    expect(sent(pruneStatement()).sql).toContain(span);
  });

  test('a waiting device’s row is left unwritten and unreturned by the hold', () => {
    const hold = sent(holdStatement(KEY, BUDGET)).sql.replace(/\s+/g, ' ');
    expect(hold).toContain('ON CONFLICT (device_key) DO UPDATE SET');
    expect(hold).toContain(
      'WHERE u.cooldown_until IS NULL OR u.cooldown_until <= now() RETURNING',
    );
  });

  test('the hold says which window it was set in, to the microsecond the database keeps', () => {
    const hold = sent(holdStatement(KEY, BUDGET)).sql.replace(/\s+/g, ' ');
    expect(
      hold
        .trim()
        .endsWith(
          'RETURNING (u.cooldown_until IS NULL)::int AS admitted, u.window_started_at::text AS opened',
        ),
    ).toBe(true);
  });

  test('a settle writes one device’s row, in the window its hold was set in, and no other', () => {
    const settle = sent(settleStatement(KEY, OPENED, 1, BUDGET)).sql.replace(
      /\s+/g,
      ' ',
    );
    expect(
      settle
        .trim()
        .endsWith(
          'WHERE u.device_key = $6 AND u.window_started_at = $7::timestamptz',
        ),
    ).toBe(true);
  });

  test('no statement carries a comment, which a statement sent on one line would be cut at', () => {
    for (const statement of [
      holdStatement(KEY, BUDGET),
      settleStatement(KEY, OPENED, 1, BUDGET),
      coolingStatement(KEY),
      pruneStatement(),
    ])
      expect(sent(statement).sql).not.toContain('--');
  });
});

describe('coolingUntil', () => {
  test('a waiting device is told when its cooldown ends, as the driver hands back a bigint', async () => {
    const { run } = store({ SELECT: [[{ until: String(UNTIL) }]] });
    expect(await coolingUntil(KEY, run)).toBe(UNTIL);
  });

  test('a device with no row, or no cooldown running, is not waiting', async () => {
    const { run } = store({ SELECT: [[]] });
    expect(await coolingUntil(KEY, run)).toBeNull();
  });

  test('a time that does not read as one is no cooldown', async () => {
    const { run } = store({ SELECT: [[{ until: 'soon' }], [{}]] });
    expect(await coolingUntil(KEY, run)).toBeNull();
    expect(await coolingUntil(KEY, run)).toBeNull();
  });
});

describe('holdAsk', () => {
  test('an ask the statement admitted is admitted, in one statement, with the window its hold was set in', async () => {
    const { run, ran } = store({
      INSERT: [[{ admitted: 1, opened: OPENED }]],
    });
    expect(await holdAsk(KEY, BUDGET, run)).toEqual({
      admitted: true,
      opened: OPENED,
    });
    expect(ran).toEqual(['INSERT']);
  });

  test('an ask admitted with no window to settle it in is a failure, never an admission, and is not asked for again', async () => {
    for (const row of [{ admitted: 1 }, { admitted: 1, opened: '' }]) {
      const { run, ran } = store({ INSERT: [[row]] });
      await expect(holdAsk(KEY, BUDGET, run)).rejects.toThrow(
        'an ask could not be counted',
      );
      expect(ran).toEqual(['INSERT']);
    }
  });

  test('a device already waiting gets no row back: it is told when it may ask again', async () => {
    const { run, ran } = store({
      INSERT: [[]],
      SELECT: [[{ until: String(UNTIL) }]],
    });
    expect(await holdAsk(KEY, BUDGET, run)).toEqual({
      admitted: false,
      until: UNTIL,
    });
    expect(ran).toEqual(['INSERT', 'SELECT']);
  });

  test('an ask that found the budget reached is refused, and told the cooldown it started', async () => {
    const { run, ran } = store({
      INSERT: [[{ admitted: 0 }]],
      SELECT: [[{ until: String(UNTIL) }]],
    });
    expect(await holdAsk(KEY, BUDGET, run)).toEqual({
      admitted: false,
      until: UNTIL,
    });
    expect(ran).toEqual(['INSERT', 'SELECT']);
  });

  test('a cooldown that ended between the hold and the read is asked for again', async () => {
    const { run, ran } = store({
      INSERT: [[], [{ admitted: 1, opened: OPENED }]],
      SELECT: [[]],
    });
    expect(await holdAsk(KEY, BUDGET, run)).toEqual({
      admitted: true,
      opened: OPENED,
    });
    expect(ran).toEqual(['INSERT', 'SELECT', 'INSERT']);
  });

  test('an ask that can be neither admitted nor placed is a failure, never an admission', async () => {
    const { run, ran } = store({ INSERT: [[], []], SELECT: [[], []] });
    await expect(holdAsk(KEY, BUDGET, run)).rejects.toThrow(
      'an ask could not be counted',
    );
    expect(ran).toEqual(['INSERT', 'SELECT', 'INSERT', 'SELECT']);
  });

  test('a store that cannot be reached throws', async () => {
    const run: Run = async () => {
      throw new Error('network down');
    };
    await expect(holdAsk(KEY, BUDGET, run)).rejects.toThrow('network down');
  });
});

describe('settleAsk', () => {
  test('writes the charge it is given, as a whole number of tokens and never less than nothing, in the window it is given', async () => {
    const { run, ran, params } = store({ UPDATE: [[], [], []] });
    await settleAsk(KEY, OPENED, 41_200.6, BUDGET, run);
    await settleAsk(KEY, OPENED, 0, BUDGET, run);
    await settleAsk(KEY, OPENED, -5, BUDGET, run);
    expect(ran).toEqual(['UPDATE', 'UPDATE', 'UPDATE']);
    expect(params.map((p) => p[1])).toEqual([41_201, 0, 0]);
    expect(params.map((p) => p.at(-1))).toEqual([OPENED, OPENED, OPENED]);
  });

  test('a settle that fails throws: its caller says so', async () => {
    const { run } = store({ UPDATE: [new Error('network down')] });
    await expect(settleAsk(KEY, OPENED, 1, BUDGET, run)).rejects.toThrow(
      'network down',
    );
  });
});

describe('statementFailure', () => {
  // As the driver reports a statement that failed: the statement and its values in the message.
  const quoted = `Failed query: SELECT 1 FROM ask_usage WHERE device_key = $1\nparams: ${KEY},20,20`;

  test('the database’s own complaint is what is said, never the values bound to the statement', () => {
    const said = statementFailure(
      new Error(quoted, {
        cause: new Error('relation "ask_usage" does not exist'),
      }),
    );
    expect(said).toContain('relation "ask_usage" does not exist');
    expect(said).not.toContain(KEY);
    expect(said).not.toContain('params');
  });

  test('with no complaint passed on, a driver’s failure is said by its name alone', () => {
    const said = statementFailure(new Error(quoted));
    expect(said).toBe('Error');
    expect(said).not.toContain(KEY);
  });

  test('any other failure is said as it is, in one bounded line', () => {
    expect(statementFailure(new Error('network down'))).toBe(
      'Error: network down',
    );
    expect(statementFailure('timed out')).toBe('timed out');
    expect(
      statementFailure(new Error('x'.repeat(500))).length,
    ).toBeLessThanOrEqual(201);
  });
});

describe('createPruner', () => {
  let logged: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    logged?.mockRestore();
    logged = undefined;
  });

  test('prunes on its first call, then at most once every stretch', async () => {
    const { run, ran } = store({ DELETE: [[], [], []] });
    const prune = createPruner(1_000);
    await prune(run, 5_000);
    await prune(run, 5_500);
    await prune(run, 5_999);
    expect(ran).toEqual(['DELETE']);
    await prune(run, 6_000);
    expect(ran).toEqual(['DELETE', 'DELETE']);
  });

  test('a prune that fails is said and never thrown, and is not tried again until the next stretch', async () => {
    logged = spyOn(console, 'error').mockImplementation(() => {});
    const { run, ran } = store({ DELETE: [new Error('network down'), []] });
    const prune = createPruner(1_000);
    await prune(run, 5_000);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[1])).toContain('network down');
    await prune(run, 5_500);
    expect(ran).toEqual(['DELETE']);
    await prune(run, 6_000);
    expect(ran).toEqual(['DELETE', 'DELETE']);
  });
});
