import { describe, expect, test } from 'bun:test';

import type { SearchUrlParams } from '@ss/search-filters';

import {
  type AskMintResponse,
  type AskMoreResponse,
  type AskPlanResponse,
  createAskLoader,
} from './ask-loader';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const OK: AskPlanResponse = {
  status: 'ok',
  filters: { location: 'Leeds' },
  reason: 'none',
  ranking: null,
};
const DENIED: AskPlanResponse = { status: 'denied' };
const MORE_OK: AskMoreResponse = {
  status: 'ok',
  ranked: ['00000003'],
  next: 800,
};
const MORE_DENIED: AskMoreResponse = { status: 'denied' };
const OPEN = { status: 'open' } as const;
const OFF = { status: 'off' } as const;

/** A mint's answer: a token, none, or none with the time a waiting device may ask again. */
type Minted = string | null | { cooldown: number };

/** A mint, a plan and a judge answering from queues, recording every call; `clock.now` is the time the loader reads. */
function harness(
  tokens: Minted[],
  answers: AskPlanResponse[],
  slices: AskMoreResponse[] = [],
) {
  const mints: string[] = [];
  const plans: [string, string, string, SearchUrlParams][] = [];
  const mores: [
    string,
    string,
    string,
    SearchUrlParams,
    number,
    string | null,
  ][] = [];
  const clock = { now: 1_000 };
  const loader = createAskLoader(
    async (key): Promise<AskMintResponse> => {
      mints.push(key);
      const next = tokens.shift();
      if (next === undefined) throw new Error('no token queued');
      return typeof next === 'object' && next !== null
        ? { token: null, cooldown: next.cooldown }
        : { token: next };
    },
    async (text, key, token, base) => {
      plans.push([text, key, token, base]);
      const next = answers.shift();
      if (next === undefined) throw new Error('no answer queued');
      return next;
    },
    async (span, key, token, params, offset, sector) => {
      mores.push([span, key, token, params, offset, sector]);
      const next = slices.shift();
      if (next === undefined) throw new Error('no slice queued');
      return next;
    },
    () => clock.now,
  );
  return { ...loader, mints, plans, mores, clock };
}

describe('createAskLoader', () => {
  test('prepare mints once and says whether the document may ask; a later ask reuses the token', async () => {
    const { prepare, ask, mints, plans } = harness(['t1'], [OK]);
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1']);
  });

  test('prepare answers off where nothing is issued, once per document, without planning', async () => {
    const { prepare, ask, mints, plans } = harness([null], []);
    expect(await prepare(KEY)).toEqual(OFF);
    expect(await prepare(KEY)).toEqual(OFF);
    expect(await ask('x y z', KEY)).toEqual(OFF);
    expect(mints).toEqual([KEY]);
    expect(plans).toEqual([]);
  });

  test('overlapping callers share one mint', async () => {
    const { prepare, ask, mints, plans } = harness(['t1'], [OK]);
    const [a, b, outcome] = await Promise.all([
      prepare(KEY),
      prepare(KEY),
      ask('care homes in leeds', KEY),
    ]);
    expect([a, b]).toEqual([OPEN, OPEN]);
    expect(outcome).toEqual(OK);
    expect(mints).toEqual([KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1']);
  });

  test('overlapping callers refused together share one replacement mint, and each retries with it', async () => {
    const { ask, mints, plans } = harness(
      ['t1', 't2'],
      [DENIED, DENIED, OK, OK],
    );
    const [a, b] = await Promise.all([
      ask('care homes in leeds', KEY),
      ask('plcs in york', KEY),
    ]);
    expect([a, b]).toEqual([OK, OK]);
    expect(mints).toEqual([KEY, KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't1', 't2', 't2']);
  });

  test('mints once and keeps the token across asks', async () => {
    const { ask, mints, plans } = harness(['t1'], [OK, OK]);
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(await ask('plcs in york', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't1']);
  });

  test('a refused token is replaced once and the ask retried', async () => {
    const { ask, mints, plans } = harness(['t1', 't2'], [DENIED, OK]);
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY, KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't2']);
  });

  test('a second refusal, or a mint that issues nothing after one, is off', async () => {
    expect(
      await harness(['t1', 't2'], [DENIED, DENIED]).ask('x y z', KEY),
    ).toEqual(OFF);
    expect(await harness(['t1', null], [DENIED]).ask('x y z', KEY)).toEqual(
      OFF,
    );
  });

  test('unavailable passes through without a retry', async () => {
    const { ask, plans } = harness(['t1'], [{ status: 'unavailable' }]);
    expect(await ask('x y z', KEY)).toEqual({ status: 'unavailable' });
    expect(plans).toHaveLength(1);
  });

  test('more judges the next slice with the token the ask used, replacing a refused one once', async () => {
    const { ask, more, mints, plans, mores } = harness(
      ['t1', 't2'],
      [OK],
      [MORE_DENIED, MORE_OK],
    );
    expect(await ask('care homes in leeds', KEY, { rating: 'A' })).toEqual(OK);
    expect(plans.map((p) => p[3])).toEqual([{ rating: 'A' }]);
    expect(
      await more('care homes', KEY, { location: 'Leeds' }, 400, 'Q'),
    ).toEqual(MORE_OK);
    expect(mints).toEqual([KEY, KEY]);
    expect(mores).toEqual([
      ['care homes', KEY, 't1', { location: 'Leeds' }, 400, 'Q'],
      ['care homes', KEY, 't2', { location: 'Leeds' }, 400, 'Q'],
    ]);
  });

  test('more is off after a second refusal, and passes unavailable through', async () => {
    expect(
      await harness(['t1', 't2'], [], [MORE_DENIED, MORE_DENIED]).more(
        'x',
        KEY,
        {},
        400,
        null,
      ),
    ).toEqual(OFF);
    const { more, mores } = harness(['t1'], [], [{ status: 'unavailable' }]);
    expect(await more('x', KEY, {}, 400, null)).toEqual({
      status: 'unavailable',
    });
    expect(mores).toHaveLength(1);
  });

  test('a plan that throws rejects the call and keeps the token; a mint that throws is dropped', async () => {
    const answers = [OK];
    const { ask, mints, plans } = harness(['t1'], answers);
    await ask('x y z', KEY);
    await expect(ask('x y z', KEY)).rejects.toThrow('no answer queued');
    answers.push(OK);
    expect(await ask('x y z', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't1', 't1']);

    const retried = harness(['t1'], [OK]);
    retried.mints.length = 0;
    const failing = createAskLoader(
      async (key) => {
        retried.mints.push(key);
        if (retried.mints.length === 1) throw new Error('no token queued');
        return { token: 't1' };
      },
      async () => OK,
      async () => MORE_OK,
    );
    await expect(failing.prepare(KEY)).rejects.toThrow('no token queued');
    expect(await failing.prepare(KEY)).toEqual(OPEN);
    expect(retried.mints).toEqual([KEY, KEY]);
  });
});

describe('createAskLoader, a device told to wait out a cooldown', () => {
  const UNTIL = 5_000;
  const WAIT = { status: 'cooldown', until: UNTIL } as const;

  test('a mint that names a cooldown says so to prepare, ask and more alike, and nothing is planned or judged', async () => {
    const { prepare, ask, more, mints, plans, mores } = harness(
      [{ cooldown: UNTIL }],
      [],
    );
    expect(await prepare(KEY)).toEqual(WAIT);
    expect(await ask('care homes in leeds', KEY)).toEqual(WAIT);
    expect(await more('care homes', KEY, {}, 400, null)).toEqual(WAIT);
    expect(mints).toEqual([KEY]);
    expect(plans).toEqual([]);
    expect(mores).toEqual([]);
  });

  test('a plan that names a cooldown passes through without a retry, and nothing more is sent while it runs', async () => {
    const { prepare, ask, more, mints, plans, mores } = harness(['t1'], [WAIT]);
    expect(await ask('care homes in leeds', KEY)).toEqual(WAIT);
    expect(await ask('plcs in york', KEY)).toEqual(WAIT);
    expect(await more('care homes', KEY, {}, 400, null)).toEqual(WAIT);
    expect(await prepare(KEY)).toEqual(WAIT);
    expect(mints).toEqual([KEY]);
    expect(plans).toHaveLength(1);
    expect(mores).toEqual([]);
  });

  test('a slice that names a cooldown holds the next ask too', async () => {
    const { ask, more, plans, mores } = harness(['t1'], [OK], [WAIT]);
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(await more('care homes', KEY, {}, 400, null)).toEqual(WAIT);
    expect(await ask('plcs in york', KEY)).toEqual(WAIT);
    expect(plans).toHaveLength(1);
    expect(mores).toHaveLength(1);
  });

  test('a cooldown named after a refused token passes through as the retry found it', async () => {
    const { ask, mints, plans } = harness(['t1', 't2'], [DENIED, WAIT]);
    expect(await ask('care homes in leeds', KEY)).toEqual(WAIT);
    expect(mints).toEqual([KEY, KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't2']);
    const refused = harness(['t1', { cooldown: UNTIL }], [DENIED]);
    expect(await refused.ask('x y z', KEY)).toEqual(WAIT);
    expect(refused.plans).toHaveLength(1);
  });

  test('once the wait is over the next call mints afresh and asks', async () => {
    const { prepare, ask, mints, plans, clock } = harness(
      [{ cooldown: UNTIL }, 't2'],
      [OK],
    );
    expect(await prepare(KEY)).toEqual(WAIT);
    clock.now = UNTIL - 1;
    expect(await prepare(KEY)).toEqual(WAIT);
    expect(mints).toEqual([KEY]);
    clock.now = UNTIL;
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY, KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t2']);
  });

  test('a wait a call named ends the same way: the token it was told under is not kept', async () => {
    const { ask, mints, plans, clock } = harness(['t1', 't2'], [WAIT, OK]);
    expect(await ask('care homes in leeds', KEY)).toEqual(WAIT);
    clock.now = UNTIL + 1;
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY, KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't2']);
  });

  test('a device still waiting when its wait was thought over is told the new time', async () => {
    const { prepare, mints, clock } = harness(
      [{ cooldown: UNTIL }, { cooldown: UNTIL + 500 }],
      [],
    );
    expect(await prepare(KEY)).toEqual(WAIT);
    clock.now = UNTIL;
    expect(await prepare(KEY)).toEqual({
      status: 'cooldown',
      until: UNTIL + 500,
    });
    expect(mints).toEqual([KEY, KEY]);
  });
});
