import { describe, expect, test } from 'bun:test';

import {
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

/** A mint, a plan and a judge answering from queues, recording every call. */
function harness(
  tokens: (string | null)[],
  answers: AskPlanResponse[],
  slices: AskMoreResponse[] = [],
) {
  const mints: string[] = [];
  const plans: [string, string, string][] = [];
  const mores: [string, string, string, number][] = [];
  const loader = createAskLoader(
    async (key) => {
      mints.push(key);
      const next = tokens.shift();
      if (next === undefined) throw new Error('no token queued');
      return next;
    },
    async (text, key, token) => {
      plans.push([text, key, token]);
      const next = answers.shift();
      if (next === undefined) throw new Error('no answer queued');
      return next;
    },
    async (span, key, token, _params, offset) => {
      mores.push([span, key, token, offset]);
      const next = slices.shift();
      if (next === undefined) throw new Error('no slice queued');
      return next;
    },
  );
  return { ...loader, mints, plans, mores };
}

describe('createAskLoader', () => {
  test('prepare mints once and says whether the document may ask; a later ask reuses the token', async () => {
    const { prepare, ask, mints, plans } = harness(['t1'], [OK]);
    expect(await prepare(KEY)).toBe(true);
    expect(await prepare(KEY)).toBe(true);
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1']);
  });

  test('prepare answers false where nothing is issued, once per document, without planning', async () => {
    const { prepare, ask, mints, plans } = harness([null], []);
    expect(await prepare(KEY)).toBe(false);
    expect(await prepare(KEY)).toBe(false);
    expect(await ask('x y z', KEY)).toEqual({ status: 'off' });
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
    expect([a, b]).toEqual([true, true]);
    expect(outcome).toEqual(OK);
    expect(mints).toEqual([KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1']);
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
    ).toEqual({ status: 'off' });
    expect(await harness(['t1', null], [DENIED]).ask('x y z', KEY)).toEqual({
      status: 'off',
    });
  });

  test('unavailable passes through without a retry', async () => {
    const { ask, plans } = harness(['t1'], [{ status: 'unavailable' }]);
    expect(await ask('x y z', KEY)).toEqual({ status: 'unavailable' });
    expect(plans).toHaveLength(1);
  });

  test('more judges the next slice with the token the ask used, replacing a refused one once', async () => {
    const { ask, more, mints, mores } = harness(
      ['t1', 't2'],
      [OK],
      [MORE_DENIED, MORE_OK],
    );
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(await more('care homes', KEY, { location: 'Leeds' }, 400)).toEqual(
      MORE_OK,
    );
    expect(mints).toEqual([KEY, KEY]);
    expect(mores).toEqual([
      ['care homes', KEY, 't1', 400],
      ['care homes', KEY, 't2', 400],
    ]);
  });

  test('more is off after a second refusal, and passes unavailable through', async () => {
    expect(
      await harness(['t1', 't2'], [], [MORE_DENIED, MORE_DENIED]).more(
        'x',
        KEY,
        {},
        400,
      ),
    ).toEqual({ status: 'off' });
    const { more, mores } = harness(['t1'], [], [{ status: 'unavailable' }]);
    expect(await more('x', KEY, {}, 400)).toEqual({ status: 'unavailable' });
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
        return 't1';
      },
      async () => OK,
      async () => MORE_OK,
    );
    await expect(failing.prepare(KEY)).rejects.toThrow('no token queued');
    expect(await failing.prepare(KEY)).toBe(true);
    expect(retried.mints).toEqual([KEY, KEY]);
  });
});
