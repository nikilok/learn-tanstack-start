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
  reserveFor,
  tokenBudgets,
} from './allowance.server';
import { COOLDOWN_SECONDS } from './cooldown';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const UNTIL = 1_800_000_000_000;
const BUDGET = 1_000_000;
// A reserve other than HOLD_TOKENS, as a large budget's least charge sets.
const RESERVE = 400_000;
// The start of a window, as the database says it.
const OPENED = '2026-11-21 14:05:00.123456+00';
const dialect = new PgDialect();

/** A statement as the driver would send it. */
const sent = (statement: SQL) => dialect.sqlToQuery(statement);

/** A statement's text as sent, on one line. */
const flat = (statement: SQL) =>
  sent(statement).sql.replace(/\s+/g, ' ').trim();

// The span and the spent-row test as the statements splice them.
const SPAN = `interval '${COOLDOWN_SECONDS} seconds'`;
const SPENT = `(u.cooldown_until IS NOT NULL OR u.window_started_at <= now() - ${SPAN})`;

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

  test('unset is none', () => {
    expect(tokenBudget(undefined)).toBeNull();
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

describe('tokenBudgets', () => {
  const NAMES = [
    'ASK_DAILY_TOKENS',
    'ASK_DAILY_TOKENS_NETWORK',
    'ASK_DAILY_TOKENS_SITE',
  ] as const;

  test('each budget is read from its own variable', () => {
    expect(
      tokenBudgets({
        ASK_DAILY_TOKENS: '1000000',
        ASK_DAILY_TOKENS_NETWORK: '2000000',
        ASK_DAILY_TOKENS_SITE: '5000000',
      }),
    ).toEqual({ device: 1_000_000, network: 2_000_000, site: 5_000_000 });
    expect(tokenBudgets({ ASK_DAILY_TOKENS_NETWORK: '2000000' })).toEqual({
      device: null,
      network: 2_000_000,
      site: null,
    });
    expect(tokenBudgets({ ASK_DAILY_TOKENS_SITE: '5000000' })).toEqual({
      device: null,
      network: null,
      site: 5_000_000,
    });
  });

  test('an unset network or site budget is none even with the device’s set: neither is ever taken from another variable', () => {
    expect(tokenBudgets({ ASK_DAILY_TOKENS: '1000000' })).toEqual({
      device: 1_000_000,
      network: null,
      site: null,
    });
    expect(
      tokenBudgets({
        ASK_DAILY_TOKENS: '1000000',
        ASK_DAILY_TOKENS_NETWORK: '2000000',
      }).site,
    ).toBeNull();
  });

  test('each is read as tokenBudget reads one', () => {
    expect(
      tokenBudgets({
        ASK_DAILY_TOKENS: '0',
        ASK_DAILY_TOKENS_NETWORK: '1.5M',
        ASK_DAILY_TOKENS_SITE: '',
      }),
    ).toEqual({ device: null, network: null, site: null });
  });

  test('with no argument, the budgets are read from the process environment', () => {
    const found = NAMES.map((name) => process.env[name]);
    try {
      process.env.ASK_DAILY_TOKENS = '1000000';
      process.env.ASK_DAILY_TOKENS_NETWORK = '2000000';
      process.env.ASK_DAILY_TOKENS_SITE = '5000000';
      expect(tokenBudgets()).toEqual({
        device: 1_000_000,
        network: 2_000_000,
        site: 5_000_000,
      });
      for (const name of NAMES) delete process.env[name];
      expect(tokenBudgets()).toEqual({
        device: null,
        network: null,
        site: null,
      });
    } finally {
      NAMES.forEach((name, i) => {
        const value = found[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
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

describe('reserveFor', () => {
  test('a least charge below the usual hold sets aside the usual hold', () => {
    expect(reserveFor(10_000)).toBe(HOLD_TOKENS);
    expect(reserveFor(1)).toBe(HOLD_TOKENS);
  });

  test('a least charge at the usual hold sets aside exactly that', () => {
    expect(reserveFor(HOLD_TOKENS)).toBe(HOLD_TOKENS);
  });

  test('a least charge above the usual hold sets aside the least charge', () => {
    expect(reserveFor(400_000)).toBe(400_000);
    expect(reserveFor(HOLD_TOKENS + 1)).toBe(HOLD_TOKENS + 1);
  });
});

describe('the statements', () => {
  test('the hold and the settle bind the reserve they are given, where HOLD_TOKENS would be', () => {
    expect(sent(holdStatement(KEY, BUDGET, RESERVE)).params).toEqual([
      KEY,
      RESERVE,
      BUDGET,
      BUDGET,
      BUDGET,
      BUDGET,
    ]);
    expect(
      sent(settleStatement(KEY, OPENED, 41_000, BUDGET, RESERVE)).params,
    ).toEqual([41_000, RESERVE, 41_000, BUDGET, KEY, OPENED]);
  });

  test('given no reserve, the hold and the settle bind HOLD_TOKENS', () => {
    expect(sent(holdStatement(KEY, BUDGET)).params[1]).toBe(HOLD_TOKENS);
    expect(sent(settleStatement(KEY, OPENED, 1, BUDGET)).params[1]).toBe(
      HOLD_TOKENS,
    );
  });

  test('the text of the hold and the settle is the same whatever reserve they bind', () => {
    expect(sent(holdStatement(KEY, BUDGET, RESERVE)).sql).toBe(
      sent(holdStatement(KEY, BUDGET)).sql,
    );
    expect(sent(settleStatement(KEY, OPENED, 1, BUDGET, RESERVE)).sql).toBe(
      sent(settleStatement(KEY, OPENED, 1, BUDGET)).sql,
    );
  });

  test('the key, the hold, the budget, the charge and the window are bound, never spliced', () => {
    const hold = sent(holdStatement(KEY, BUDGET));
    expect(hold.params).toEqual([
      KEY,
      HOLD_TOKENS,
      BUDGET,
      BUDGET,
      BUDGET,
      BUDGET,
    ]);
    expect(hold.sql).not.toContain(KEY);
    expect(hold.sql).not.toContain(String(BUDGET));
    const settle = sent(settleStatement(KEY, OPENED, 41_000, BUDGET));
    expect(settle.params).toEqual([
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

  test('a new row starts with no tokens used and the ask’s hold set aside', () => {
    expect(flat(holdStatement(KEY, BUDGET))).toStartWith(
      'INSERT INTO ask_usage AS u (device_key, window_started_at, tokens, held, cooldown_until) VALUES ($1, now(), 0, $2::int, NULL) ON CONFLICT (device_key) DO UPDATE SET',
    );
  });

  test('the hold sets room aside in held, never in the tokens used, and starts a cooldown only on the tokens used', () => {
    const hold = flat(holdStatement(KEY, BUDGET));
    expect(hold).toContain(
      `tokens = CASE WHEN ${SPENT} THEN 0 ELSE u.tokens END,`,
    );
    expect(hold).toContain(
      `held = CASE WHEN ${SPENT} THEN excluded.held WHEN u.tokens < $3::int THEN u.held + excluded.held ELSE u.held END,`,
    );
    expect(hold).toContain(
      `cooldown_until = CASE WHEN ${SPENT} OR u.tokens < $4::int THEN NULL ELSE now() + ${SPAN} END`,
    );
  });

  test('the hold writes no row waiting out a cooldown, nor one whose room is taken up by holds alone', () => {
    const hold = flat(holdStatement(KEY, BUDGET));
    const where = hold.slice(
      hold.indexOf(' WHERE '),
      hold.indexOf(' RETURNING '),
    );
    expect(where).toBe(
      ` WHERE (u.cooldown_until IS NULL OR u.cooldown_until <= now()) AND (${SPENT} OR u.tokens >= $5::int OR u.tokens + u.held < $6::int)`,
    );
  });

  test('a settle gives up its hold, adds its charge to the tokens used, and starts a cooldown on those alone', () => {
    expect(flat(settleStatement(KEY, OPENED, 1, BUDGET))).toStartWith(
      `UPDATE ask_usage AS u SET tokens = u.tokens + $1::int, held = greatest(u.held - $2::int, 0), cooldown_until = CASE WHEN u.cooldown_until > now() THEN u.cooldown_until WHEN u.tokens + $3::int >= $4::int THEN now() + ${SPAN} ELSE u.cooldown_until END WHERE`,
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
          'WHERE u.device_key = $5 AND u.window_started_at = $6::timestamptz',
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

  test('an ask admitted with no window to settle it in is a failure at once, never an admission, and is not asked for again', async () => {
    for (const row of [{ admitted: 1 }, { admitted: 1, opened: '' }]) {
      const { run, ran } = store({
        INSERT: [[row], [{ admitted: 1, opened: OPENED }]],
      });
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

  test('a total found without room and not waiting is asked for again, and admitted when room has opened', async () => {
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

  test('a total whose room is taken up by asks still running, on both tries, is busy and never a throw', async () => {
    const { run, ran } = store({ INSERT: [[], []], SELECT: [[], []] });
    expect(await holdAsk(KEY, BUDGET, run)).toEqual({
      admitted: false,
      busy: true,
    });
    expect(ran).toEqual(['INSERT', 'SELECT', 'INSERT', 'SELECT']);
  });

  test('a busy total that is found waiting on the second try is told its time', async () => {
    const { run, ran } = store({
      INSERT: [[], [{ admitted: 0 }]],
      SELECT: [[], [{ until: String(UNTIL) }]],
    });
    expect(await holdAsk(KEY, BUDGET, run)).toEqual({
      admitted: false,
      until: UNTIL,
    });
    expect(ran).toEqual(['INSERT', 'SELECT', 'INSERT', 'SELECT']);
  });

  test('a store that cannot be reached throws', async () => {
    const run: Run = async () => {
      throw new Error('network down');
    };
    await expect(holdAsk(KEY, BUDGET, run)).rejects.toThrow('network down');
  });

  test('the reserve it is given is what every try sets aside, and HOLD_TOKENS when it is given none', async () => {
    const given = store({
      INSERT: [[], [{ admitted: 1, opened: OPENED }]],
      SELECT: [[]],
    });
    await holdAsk(KEY, BUDGET, given.run, RESERVE);
    expect(given.ran).toEqual(['INSERT', 'SELECT', 'INSERT']);
    expect([given.params[0]?.[1], given.params[2]?.[1]]).toEqual([
      RESERVE,
      RESERVE,
    ]);
    const none = store({ INSERT: [[{ admitted: 1, opened: OPENED }]] });
    await holdAsk(KEY, BUDGET, none.run);
    expect(none.params[0]?.[1]).toBe(HOLD_TOKENS);
  });
});

describe('settleAsk', () => {
  test('writes the charge it is given, as a whole number of tokens and never less than nothing, in the window it is given', async () => {
    const { run, ran, params } = store({ UPDATE: [[], [], []] });
    await settleAsk(KEY, OPENED, 41_200.6, BUDGET, run);
    await settleAsk(KEY, OPENED, 0, BUDGET, run);
    await settleAsk(KEY, OPENED, -5, BUDGET, run);
    expect(ran).toEqual(['UPDATE', 'UPDATE', 'UPDATE']);
    expect(params.map((p) => p[0])).toEqual([41_201, 0, 0]);
    expect(params.map((p) => p.at(-1))).toEqual([OPENED, OPENED, OPENED]);
  });

  test('gives up the reserve it is given, and HOLD_TOKENS when it is given none', async () => {
    const { run, params } = store({ UPDATE: [[], []] });
    await settleAsk(KEY, OPENED, 41_000, BUDGET, run, RESERVE);
    await settleAsk(KEY, OPENED, 41_000, BUDGET, run);
    expect(params.map((p) => p[1])).toEqual([RESERVE, HOLD_TOKENS]);
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
