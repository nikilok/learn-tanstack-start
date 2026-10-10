import { describe, expect, test } from 'bun:test';

import { type AskPlanResponse, createAskLoader } from './ask-loader';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const OK: AskPlanResponse = {
  status: 'ok',
  filters: { location: 'Leeds' },
  reason: 'none',
  ranking: null,
};
const DENIED: AskPlanResponse = { status: 'denied' };

/** A mint and a plan answering from queues, recording every call. */
function harness(tokens: (string | null)[], answers: AskPlanResponse[]) {
  const mints: string[] = [];
  const plans: [string, string, string][] = [];
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
  );
  return { ...loader, mints, plans };
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
    );
    await expect(failing.prepare(KEY)).rejects.toThrow('no token queued');
    expect(await failing.prepare(KEY)).toBe(true);
    expect(retried.mints).toEqual([KEY, KEY]);
  });
});
