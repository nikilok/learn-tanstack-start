// The tokens a device's asks may use in one window, and the cooldown that
// follows once they are used up. The total lives in `ask_usage` (@ss/db), a
// row a device key; the statements here are its only readers and writers.
//
// What an ask uses is known only once the judge has answered, so an ask is
// admitted on a hold: an amount set aside from the room left in the budget
// while the ask runs (`held`), and given up for what the ask really used
// (`tokens`) when it is settled. Only what was used starts a cooldown.

import { type SQL, sql } from 'drizzle-orm';

import { describeError } from '../server-fn-errors';
import { COOLDOWN_SECONDS } from './cooldown';

/** Runs one statement, as the Drizzle client does. */
export type Run = (statement: SQL) => Promise<{ rows: unknown[] }>;

/** A budget as set: a whole number of tokens from one up; null when unset or anything else. */
export function tokenBudget(value: string | undefined): number | null {
  return value !== undefined && /^[1-9]\d{0,8}$/.test(value)
    ? Number(value)
    : null;
}

/** The tokens the asks of one device, of one network and of the whole site may each use in a window before a cooldown; null where none is set. */
export type Budgets = {
  device: number | null;
  network: number | null;
  site: number | null;
};

/** The three budgets as set (`ASK_DAILY_TOKENS`, `ASK_DAILY_TOKENS_NETWORK`, `ASK_DAILY_TOKENS_SITE`), each read as `tokenBudget` reads one. */
export function tokenBudgets(
  env: Record<string, string | undefined> = process.env,
): Budgets {
  return {
    device: tokenBudget(env.ASK_DAILY_TOKENS),
    network: tokenBudget(env.ASK_DAILY_TOKENS_NETWORK),
    site: tokenBudget(env.ASK_DAILY_TOKENS_SITE),
  };
}

/**
 * What is set aside from a budget while one of its asks is with the judge:
 * about the most one call uses. Asks sent together are each admitted on the
 * room the others' holds have left, so together they cannot run far past the
 * budget before any of them has been charged.
 */
export const HOLD_TOKENS = 200_000;

/** What an ask sets aside from each total while it runs: the usual hold, or the least it will be charged where that is more, so asks sent together are never charged past what they set aside between them. */
export function reserveFor(least: number): number {
  return Math.max(HOLD_TOKENS, least);
}

/** The asks one budget covers at most. */
const ASKS_PER_BUDGET = 100;

/** The least an ask is charged, whatever it used: every ask costs a browser check and a count, so a budget never covers more than ASKS_PER_BUDGET of them. */
export function minimumCharge(budget: number): number {
  return Math.ceil(budget / ASKS_PER_BUDGET);
}

// How long a window and a cooldown each run: a constant of the code, so it is spliced, not bound.
const SPAN = sql.raw(`interval '${COOLDOWN_SECONDS} seconds'`);

// A row whose window or cooldown is over: its totals start again.
const SPENT = sql`(u.cooldown_until IS NOT NULL OR u.window_started_at <= now() - ${SPAN})`;

/**
 * Admits one ask on a hold of `reserve` tokens, where the tokens used and
 * those already held leave room under the budget. One statement decides and writes, so asks
 * sent together cannot each pass a check the other has not yet written.
 *
 * A row comes back with `admitted` 1 for an ask admitted, and `opened` the
 * start of the window the row is now in. It comes back with `admitted` 0 for
 * one that found the tokens used already at the budget, which starts the
 * cooldown there. No row comes back for a total already waiting out a
 * cooldown, nor for one whose room is taken up by holds alone: that one
 * starts no cooldown, and has room again as those asks are settled.
 */
export function holdStatement(
  key: string,
  budget: number,
  reserve: number = HOLD_TOKENS,
): SQL {
  return sql`
    INSERT INTO ask_usage AS u (device_key, window_started_at, tokens, held, cooldown_until)
    VALUES (${key}, now(), 0, ${reserve}::int, NULL)
    ON CONFLICT (device_key) DO UPDATE SET
      window_started_at = CASE WHEN ${SPENT} THEN now() ELSE u.window_started_at END,
      tokens = CASE WHEN ${SPENT} THEN 0 ELSE u.tokens END,
      held = CASE
        WHEN ${SPENT} THEN excluded.held
        WHEN u.tokens < ${budget}::int THEN u.held + excluded.held
        ELSE u.held
      END,
      cooldown_until = CASE
        WHEN ${SPENT} OR u.tokens < ${budget}::int THEN NULL
        ELSE now() + ${SPAN}
      END
    WHERE (u.cooldown_until IS NULL OR u.cooldown_until <= now())
      AND (${SPENT} OR u.tokens >= ${budget}::int OR u.tokens + u.held < ${budget}::int)
    RETURNING (u.cooldown_until IS NULL)::int AS admitted, u.window_started_at::text AS opened
  `;
}

/**
 * Gives up an ask's hold (`reserve`, as it was set aside) and adds what it is
 * charged to the tokens used,
 * starting the cooldown when that brings them to the budget. A cooldown
 * already running is left where it is; what is held never goes below
 * nothing. It writes only the window the hold was set in (`opened`): a
 * window begun since holds no hold of this ask's to give up.
 */
export function settleStatement(
  key: string,
  opened: string,
  charge: number,
  budget: number,
  reserve: number = HOLD_TOKENS,
): SQL {
  return sql`
    UPDATE ask_usage AS u SET
      tokens = u.tokens + ${charge}::int,
      held = greatest(u.held - ${reserve}::int, 0),
      cooldown_until = CASE
        WHEN u.cooldown_until > now() THEN u.cooldown_until
        WHEN u.tokens + ${charge}::int >= ${budget}::int THEN now() + ${SPAN}
        ELSE u.cooldown_until
      END
    WHERE u.device_key = ${key} AND u.window_started_at = ${opened}::timestamptz
  `;
}

/** When a waiting device may ask again, in epoch milliseconds; no row when it is not waiting. */
export function coolingStatement(key: string): SQL {
  return sql`
    SELECT (extract(epoch FROM cooldown_until) * 1000)::bigint AS until
    FROM ask_usage
    WHERE device_key = ${key} AND cooldown_until > now()
  `;
}

/** Deletes every row whose window and cooldown have both passed: a device with no row starts afresh, as one whose row is spent does. */
export function pruneStatement(): SQL {
  return sql`
    DELETE FROM ask_usage
    WHERE cooldown_until <= now()
       OR (cooldown_until IS NULL AND window_started_at <= now() - ${SPAN})
  `;
}

/** When a device waiting out a cooldown may ask again (epoch milliseconds); null when it is not waiting. */
export async function coolingUntil(
  key: string,
  run: Run,
): Promise<number | null> {
  const [row] = (await run(coolingStatement(key))).rows as {
    until?: unknown;
  }[];
  const until = Number(row?.until);
  return row && Number.isFinite(until) ? until : null;
}

/** What asking for a hold came to: admitted, with the start of the window the hold was set in as the database says it; the time the total opens again; or `busy`, its room taken up for now by asks still with the judge. */
export type Held =
  | { admitted: true; opened: string }
  | { admitted: false; until: number }
  | { admitted: false; busy: true };

/**
 * Admits one ask against a budget on a hold, says when the total opens
 * again, or says it is busy. A total found without room is asked for once
 * more, as a cooldown may have ended, or a hold been given up, in between.
 * Throws when the total cannot be read or written, so the caller answers
 * nothing it could not set against it.
 */
export async function holdAsk(
  key: string,
  budget: number,
  run: Run,
  reserve: number = HOLD_TOKENS,
): Promise<Held> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [row] = (await run(holdStatement(key, budget, reserve))).rows as {
      admitted?: unknown;
      opened?: unknown;
    }[];
    if (row && Number(row.admitted) === 1) {
      // A hold with no window to settle it in is left standing, and the ask unanswered.
      if (typeof row.opened !== 'string' || row.opened === '')
        throw new Error('an ask could not be counted');
      return { admitted: true, opened: row.opened };
    }
    const until = await coolingUntil(key, run);
    if (until !== null) return { admitted: false, until };
  }
  return { admitted: false, busy: true };
}

/** Settles an admitted ask's hold at `charge` tokens, in the window it was set in (`opened`): what it used, or what an ask that used nothing is charged. */
export async function settleAsk(
  key: string,
  opened: string,
  charge: number,
  budget: number,
  run: Run,
  reserve: number = HOLD_TOKENS,
): Promise<void> {
  await run(
    settleStatement(
      key,
      opened,
      Math.max(0, Math.round(charge)),
      budget,
      reserve,
    ),
  );
}

/**
 * A statement's failure as the log carries it: the database's own complaint
 * when the driver passes one on, and never the driver's message, which quotes
 * the statement and the values bound to it (a device key is one).
 */
export function statementFailure(error: unknown): string {
  if (!(error instanceof Error)) return describeError(error, 200);
  if (error.cause !== undefined) return describeError(error.cause, 200);
  return error.message.startsWith('Failed query')
    ? error.name
    : describeError(error, 200);
}

/** How long one instance leaves between prunes. */
const PRUNE_EVERY_MS = 10 * 60 * 1000;

/** A prune of the spent rows that runs at most once every `everyMs` and never throws, as nothing waits on it. */
export function createPruner(everyMs = PRUNE_EVERY_MS) {
  let last: number | null = null;
  return async (run: Run, now = Date.now()): Promise<void> => {
    if (last !== null && now - last < everyMs) return;
    last = now;
    try {
      await run(pruneStatement());
    } catch (error) {
      console.error(
        '[ask] usage could not be pruned:',
        statementFailure(error),
      );
    }
  };
}

/** This instance's prune. */
export const pruneUsage = createPruner();
