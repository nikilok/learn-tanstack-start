import { describe, expect, test } from 'bun:test';

import type { BrowserVerdict } from '../device/browser-check.server';
import {
  type Admission,
  type AdmissionDeps,
  admitAsk,
} from './admission.server';
import { type Budgets, type Held, minimumCharge } from './allowance.server';
import { COOLDOWN_SECONDS } from './cooldown';

const SPAN_MS = COOLDOWN_SECONDS * 1000;
const START = Date.UTC(2026, 11, 1, 12, 0);
const TOKEN = 'a-live-token';
const DEVICES = [
  '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
  '1b2c3d4e5f60718293a4b5c6d7e8f90a',
  '2c3d4e5f60718293a4b5c6d7e8f90a1b',
];
const OTHER_DEVICE = '3d4e5f60718293a4b5c6d7e8f90a1b2c';
const NETWORK = 'net:4e5f60718293a4b5c6d7e8f90a1b2c3d';
const SITE = 'all:test';
const BUDGETS = {
  device: 1_000_000,
  network: 2_000_000,
  site: 5_000_000,
} satisfies Budgets;
const LEAST = minimumCharge(BUDGETS.device);
// Eleven asks across the three devices, four, four and three.
const ELEVEN = Array.from({ length: 11 }, (_, i) => DEVICES[i % 3]);

type Verdict = BrowserVerdict | 'unchecked';
type Row = {
  tokens: number;
  held: number;
  started: number;
  until: number | null;
};

/** An in-memory `ask_usage`, one row per key on a fake clock, following holdStatement, settleStatement and coolingStatement in allowance.server.ts. */
function usageStore() {
  const clock = { now: START };
  const rows = new Map<string, Row>();
  /** The start of a row's window, as the hold returns it. */
  const openedOf = (row: Row) => new Date(row.started).toISOString();
  /** A new window holding one ask's reserve. */
  const fresh = (reserve: number): Row => ({
    tokens: 0,
    held: reserve,
    started: clock.now,
    until: null,
  });
  return {
    clock,
    rows,
    /** Admits an ask on a hold of `reserve`, says when the total opens again, or says it is busy. */
    hold: async (
      key: string,
      budget: number,
      reserve: number,
    ): Promise<Held> => {
      const row = rows.get(key);
      if (row === undefined) {
        const added = fresh(reserve);
        rows.set(key, added);
        return { admitted: true, opened: openedOf(added) };
      }
      if (row.until !== null && row.until > clock.now)
        return { admitted: false, until: row.until };
      if (row.until !== null || row.started <= clock.now - SPAN_MS) {
        const reset = fresh(reserve);
        rows.set(key, reset);
        return { admitted: true, opened: openedOf(reset) };
      }
      if (row.tokens >= budget) {
        row.until = clock.now + SPAN_MS;
        return { admitted: false, until: row.until };
      }
      if (row.tokens + row.held >= budget)
        return { admitted: false, busy: true };
      row.held += reserve;
      return { admitted: true, opened: openedOf(row) };
    },
    /** Gives up a hold of `reserve` and adds the charge to the tokens used, in the hold's own window only. */
    settle: async (
      key: string,
      opened: string,
      charge: number,
      budget: number,
      reserve: number,
    ): Promise<void> => {
      const row = rows.get(key);
      if (row === undefined || openedOf(row) !== opened) return;
      const running = row.until !== null && row.until > clock.now;
      row.held = Math.max(row.held - reserve, 0);
      row.tokens += charge;
      if (!running && row.tokens >= budget) row.until = clock.now + SPAN_MS;
    },
    /** When a waiting total opens again; null when it is not waiting. */
    cooling: async (key: string): Promise<number | null> => {
      const row = rows.get(key);
      return row && row.until !== null && row.until > clock.now
        ? row.until
        : null;
    },
  };
}

type Store = ReturnType<typeof usageStore>;

/** The admission's steps over the store, for a public visitor on one network, with the browser check given. */
function steps(
  store: Store,
  budgets: Budgets,
  verdict: () => Promise<Verdict>,
): AdmissionDeps {
  return {
    standing: async () => 'public',
    tokenMatches: () => true,
    listed: async () => false,
    budgets: () => budgets,
    network: () => NETWORK,
    site: () => SITE,
    cooling: store.cooling,
    hold: store.hold,
    settle: store.settle,
    verdict,
  };
}

/** Starts one ask per device key together, each held at the browser check until `release`; `allHeld` resolves once every ask has taken the holds it can. */
function inFlight(
  store: Store,
  budgets: Budgets,
  keys: readonly string[],
  verdict: Verdict,
) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = () => {};
  const allHeld = new Promise<void>((resolve) => {
    held = resolve;
  });
  let reached = 0;
  /** Counts one ask that has taken all the holds it will. */
  const reach = () => {
    reached += 1;
    if (reached === keys.length) held();
  };
  const answers = Promise.all(
    keys.map((key) => {
      let atCheck = false;
      return admitAsk(
        key,
        TOKEN,
        steps(store, budgets, async () => {
          atCheck = true;
          reach();
          await gate;
          return verdict;
        }),
      ).then((admission) => {
        // An ask answered before the check took every hold it could.
        if (!atCheck) reach();
        return admission;
      });
    }),
  );
  return { answers, allHeld, release };
}

/** How many answers came to each status. */
function tally(answers: readonly Admission[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { status } of answers) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

/** The keys whose totals are waiting out a cooldown. */
function waiting(store: Store): string[] {
  return [...store.rows.keys()].filter(
    (key) => (store.rows.get(key)?.until ?? 0) > store.clock.now,
  );
}

/** What each total holds for asks still running. */
function heldBy(store: Store): number[] {
  return [...store.rows.values()].map(({ held }) => held);
}

/** One more ask from a device none of the others came from, the check naming it a person. */
function further(store: Store, budgets: Budgets): Promise<Admission> {
  return admitAsk(
    OTHER_DEVICE,
    TOKEN,
    steps(store, budgets, async () => 'person'),
  );
}

describe('asks in flight together', () => {
  test('eleven asks from one network named automated: ten are denied and charged the least, one finds the network busy, and none waits', async () => {
    const store = usageStore();
    const flight = inFlight(store, BUDGETS, ELEVEN, 'automated');
    await flight.allHeld;
    expect(store.rows.get(NETWORK)?.held).toBe(2_000_000);
    expect(waiting(store)).toEqual([]);
    flight.release();
    const answers = await flight.answers;
    expect(tally(answers)).toEqual({ denied: 10, unavailable: 1 });
    expect(heldBy(store)).toEqual(Array(store.rows.size).fill(0));
    expect(store.rows.get(NETWORK)?.tokens).toBe(10 * LEAST);
    expect(store.rows.get(SITE)?.tokens).toBe(10 * LEAST);
    expect(waiting(store)).toEqual([]);
    expect((await further(store, BUDGETS)).status).toBe('admitted');
  });

  test('eleven asks from one network whose check could not run are all unavailable, and every total is left as it was', async () => {
    const store = usageStore();
    const flight = inFlight(store, BUDGETS, ELEVEN, 'unchecked');
    await flight.allHeld;
    flight.release();
    const answers = await flight.answers;
    expect(tally(answers)).toEqual({ unavailable: 11 });
    expect(
      [...store.rows.values()].map(({ tokens, held }) => [tokens, held]),
    ).toEqual(Array(store.rows.size).fill([0, 0]));
    expect(waiting(store)).toEqual([]);
    expect((await further(store, BUDGETS)).status).toBe('admitted');
  });

  test('eleven asks from one network each charged 250_000 bring the network to its budget, and the next ask is told the network’s time', async () => {
    const store = usageStore();
    const flight = inFlight(store, BUDGETS, ELEVEN, 'person');
    await flight.allHeld;
    flight.release();
    const answers = await flight.answers;
    expect(tally(answers)).toEqual({ admitted: 10, unavailable: 1 });
    for (const admission of answers)
      if (admission.status === 'admitted') await admission.charge(250_000);
    const network = store.rows.get(NETWORK);
    expect(network?.tokens).toBe(10 * 250_000);
    expect(network?.held).toBe(0);
    expect(waiting(store)).toContain(NETWORK);
    const until = await store.cooling(NETWORK);
    if (until === null) throw new Error('the network is not waiting');
    expect(await further(store, BUDGETS)).toEqual({
      status: 'cooldown',
      until,
    });
  });

  test('one hundred and thirty asks from one device whose least is 400_000 are admitted only as far as the budget covers, and charged no further than it', async () => {
    const budgets = {
      device: 40_000_000,
      network: 200_000_000,
      site: 900_000_000,
    } satisfies Budgets;
    expect(minimumCharge(budgets.device)).toBe(400_000);
    const store = usageStore();
    const flight = inFlight(
      store,
      budgets,
      Array(130).fill(DEVICES[0]),
      'automated',
    );
    await flight.allHeld;
    expect(store.rows.get(DEVICES[0])?.held).toBe(40_000_000);
    flight.release();
    const answers = await flight.answers;
    expect(tally(answers)).toEqual({ denied: 100, unavailable: 30 });
    const device = store.rows.get(DEVICES[0]);
    expect(device?.tokens).toBe(40_000_000);
    expect(device?.held).toBe(0);
  });
});
