// The tokens a device's asks may use in one window, and the cooldown that
// follows once they are used up. The total lives in `ask_usage` (@ss/db), a
// row a device key; the statements here are its only readers and writers.
//
// What an ask uses is known only once the judge has answered, so an ask is
// admitted on a hold: an amount set against the device's total while the ask
// runs, and replaced by what it really used when it is settled.

import { type SQL, sql } from 'drizzle-orm';

import { describeError } from '../server-fn-errors';
import { COOLDOWN_SECONDS } from './cooldown';

/** Runs one statement, as the Drizzle client does. */
export type Run = (statement: SQL) => Promise<{ rows: unknown[] }>;

/** The tokens a device's asks may use in a window before its cooldown, from `ASK_DAILY_TOKENS`: a whole number from one up; null when unset or anything else. */
export function tokenBudget(
  value = process.env.ASK_DAILY_TOKENS,
): number | null {
  return value !== undefined && /^[1-9]\d{0,8}$/.test(value)
    ? Number(value)
    : null;
}

/**
 * What is set against a device's total while one of its asks is with the
 * judge: about the most one call uses. Asks sent together are each admitted
 * on a total that already carries the others' holds, so together they cannot
 * run far past the budget before any of them has been charged.
 */
export const HOLD_TOKENS = 200_000;

/** The asks one budget covers at most. */
const ASKS_PER_BUDGET = 100;

/** The least an ask is charged, whatever it used: every ask costs a browser check and a count, so a budget never covers more than ASKS_PER_BUDGET of them. */
export function minimumCharge(budget: number): number {
  return Math.ceil(budget / ASKS_PER_BUDGET);
}

// How long a window and a cooldown each run: a constant of the code, so it is spliced, not bound.
const SPAN = sql.raw(`interval '${COOLDOWN_SECONDS} seconds'`);

// A row whose window or cooldown is over: its total starts again.
const SPENT = sql`(u.cooldown_until IS NOT NULL OR u.window_started_at <= now() - ${SPAN})`;

/**
 * Admits one ask for a device by setting a hold against its total, unless it
 * is waiting out a cooldown or its total has already reached the budget; a
 * total found there starts the cooldown. One statement decides and writes, so
 * asks sent together cannot each pass a check the other has not yet written.
 * No row comes back for a device already waiting; otherwise `admitted` is 1
 * for an ask admitted and 0 for one that found the budget reached.
 */
export function holdStatement(key: string, budget: number): SQL {
  return sql`
    INSERT INTO ask_usage AS u (device_key, window_started_at, tokens, cooldown_until)
    VALUES (${key}, now(), ${HOLD_TOKENS}::int, NULL)
    ON CONFLICT (device_key) DO UPDATE SET
      window_started_at = CASE WHEN ${SPENT} THEN now() ELSE u.window_started_at END,
      tokens = CASE
        WHEN ${SPENT} THEN excluded.tokens
        WHEN u.tokens < ${budget}::int THEN u.tokens + excluded.tokens
        ELSE u.tokens
      END,
      cooldown_until = CASE
        WHEN ${SPENT} OR u.tokens < ${budget}::int THEN NULL
        ELSE now() + ${SPAN}
      END
    WHERE u.cooldown_until IS NULL OR u.cooldown_until <= now()
    RETURNING (u.cooldown_until IS NULL)::int AS admitted
  `;
}

/**
 * Replaces an ask's hold with what it is charged, and starts the cooldown
 * when that brings the device's total to its budget. A cooldown already
 * running is left where it is; a total never goes below nothing.
 */
export function settleStatement(
  key: string,
  charge: number,
  budget: number,
): SQL {
  const settled = sql`greatest(u.tokens - ${HOLD_TOKENS}::int + ${charge}::int, 0)`;
  return sql`
    UPDATE ask_usage AS u SET
      tokens = ${settled},
      cooldown_until = CASE
        WHEN u.cooldown_until > now() THEN u.cooldown_until
        WHEN ${settled} >= ${budget}::int THEN now() + ${SPAN}
        ELSE u.cooldown_until
      END
    WHERE u.device_key = ${key}
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

/** What asking for a hold came to: admitted, or the time the device may ask again. */
export type Held = { admitted: true } | { admitted: false; until: number };

/**
 * Admits one ask against a device's budget on a hold, or says when the device
 * may ask again. A device found waiting whose cooldown ends before its end
 * can be read is asked for again. Throws when the total cannot be read or
 * written, so the caller answers nothing it could not set against it.
 */
export async function holdAsk(
  key: string,
  budget: number,
  run: Run,
): Promise<Held> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [row] = (await run(holdStatement(key, budget))).rows as {
      admitted?: unknown;
    }[];
    if (row && Number(row.admitted) === 1) return { admitted: true };
    const until = await coolingUntil(key, run);
    if (until !== null) return { admitted: false, until };
  }
  throw new Error('an ask could not be counted');
}

/** Settles an admitted ask's hold at `charge` tokens: what it used, or what an ask that used nothing is charged. */
export async function settleAsk(
  key: string,
  charge: number,
  budget: number,
  run: Run,
): Promise<void> {
  await run(settleStatement(key, Math.max(0, Math.round(charge)), budget));
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
