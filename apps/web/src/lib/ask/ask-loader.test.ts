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

/** A mint's answer: a token, none, or none with the time a waiting device may ask again; a token carrying a time as well; a failure the mint throws; or an answer the test gives later. */
type Minted =
  | string
  | null
  | { cooldown: number }
  | { token: string; cooldown: number }
  | Error
  | Promise<AskMintResponse>;

/** A plan's answer held back until the test gives it. */
function later() {
  let give: (answer: AskPlanResponse) => void = () => {};
  const answer = new Promise<AskPlanResponse>((resolve) => {
    give = resolve;
  });
  return { answer, give };
}

/** A mint's answer held back until the test gives it, or fails it. */
function laterMint() {
  let give: (answer: AskMintResponse) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const answer = new Promise<AskMintResponse>((resolve, reject) => {
    give = resolve;
    fail = reject;
  });
  return { answer, give, fail };
}

/** Lets queued callbacks run, a bounded number of turns, until `ready` holds. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !ready(); turn++) await Promise.resolve();
  if (!ready()) throw new Error('never ready');
}

/** A mint, a plan and a judge answering from queues, recording every call; `clock.now` is the time the loader reads. */
function harness(
  tokens: Minted[],
  answers: (AskPlanResponse | Promise<AskPlanResponse>)[],
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
      if (next instanceof Error) throw next;
      if (next instanceof Promise) return next;
      if (typeof next === 'object' && next !== null)
        return 'token' in next
          ? { token: next.token, cooldown: next.cooldown }
          : { token: null, cooldown: next.cooldown };
      return { token: next };
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

  test('two calls in flight told different waits keep the later, whichever is told last', async () => {
    for (const order of [
      [9_000, 5_000],
      [5_000, 9_000],
    ] as const) {
      const { ask, prepare, mints, plans, clock } = harness(
        ['t1', 't2'],
        order.map((until) => ({ status: 'cooldown', until }) as const),
      );
      // Each call is answered with the latest wait known as it answers.
      expect(
        await Promise.all([
          ask('care homes in leeds', KEY),
          ask('plcs in york', KEY),
        ]),
      ).toEqual([
        { status: 'cooldown', until: order[0] },
        { status: 'cooldown', until: 9_000 },
      ]);
      for (const at of [5_000, 8_999]) {
        clock.now = at;
        expect(await prepare(KEY)).toEqual({
          status: 'cooldown',
          until: 9_000,
        });
      }
      expect(mints).toEqual([KEY]);
      expect(plans).toHaveLength(2);
      clock.now = 9_000;
      expect(await prepare(KEY)).toEqual(OPEN);
      expect(mints).toEqual([KEY, KEY]);
    }
  });

  test('a wait a refused token’s re-mint named is not shortened by a call still in flight told an earlier one', async () => {
    const first = later();
    const { ask, prepare, mints, clock } = harness(
      ['t1', { cooldown: 9_000 }, 't3'],
      [first.answer, DENIED],
    );
    const inFlight = ask('care homes in leeds', KEY);
    expect(await ask('plcs in york', KEY)).toEqual({
      status: 'cooldown',
      until: 9_000,
    });
    first.give({ status: 'cooldown', until: 5_000 });
    expect(await inFlight).toEqual({ status: 'cooldown', until: 9_000 });
    for (const at of [5_000, 8_999]) {
      clock.now = at;
      expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    }
    expect(mints).toEqual([KEY, KEY]);
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toEqual([KEY, KEY, KEY]);
  });

  test('a call still in flight told a later wait than a re-mint named keeps the later', async () => {
    const first = later();
    const { ask, prepare, mints, clock } = harness(
      ['t1', { cooldown: 5_000 }, 't3'],
      [first.answer, DENIED],
    );
    const inFlight = ask('care homes in leeds', KEY);
    expect(await ask('plcs in york', KEY)).toEqual({
      status: 'cooldown',
      until: 5_000,
    });
    first.give({ status: 'cooldown', until: 9_000 });
    expect(await inFlight).toEqual({ status: 'cooldown', until: 9_000 });
    clock.now = 5_000;
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toEqual([KEY, KEY, KEY]);
  });

  test('a wait the mint named once an earlier wait was over is not shortened by a call still in flight', async () => {
    const first = later();
    const { ask, prepare, mints, clock } = harness(
      ['t1', { cooldown: 9_000 }, 't3'],
      [first.answer, { status: 'cooldown', until: 3_000 }],
    );
    const inFlight = ask('care homes in leeds', KEY);
    await ask('plcs in york', KEY);
    clock.now = 3_000;
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    first.give({ status: 'cooldown', until: 5_000 });
    await inFlight;
    clock.now = 5_000;
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mints).toEqual([KEY, KEY]);
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
  });

  test('a wait the mint named after a failed mint is not shortened by a call still in flight', async () => {
    const first = later();
    const { ask, prepare, mints, clock } = harness(
      ['t1', new Error('mint failed'), { cooldown: 9_000 }, 't4'],
      [first.answer, DENIED],
    );
    const inFlight = ask('care homes in leeds', KEY);
    await expect(ask('plcs in york', KEY)).rejects.toThrow('mint failed');
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    first.give({ status: 'cooldown', until: 5_000 });
    await inFlight;
    clock.now = 5_000;
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mints).toEqual([KEY, KEY, KEY]);
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
  });

  test('a replacement token that arrives while a wait is known is not used: the retry is not sent and the call is told the wait', async () => {
    const replacement = laterMint();
    const other = later();
    const { ask, mints, plans } = harness(
      ['t1', replacement.answer],
      [DENIED, other.answer],
    );
    const refused = ask('care homes in leeds', KEY);
    const told = ask('plcs in york', KEY);
    await until(() => mints.length === 2);
    other.give({ status: 'cooldown', until: 9_000 });
    expect(await told).toEqual({ status: 'cooldown', until: 9_000 });
    replacement.give({ token: 't2' });
    expect(await refused).toEqual({ status: 'cooldown', until: 9_000 });
    expect(plans.map((p) => p[2])).toEqual(['t1', 't1']);
  });

  test('a replacement token that arrives with no wait known is used: the retry is sent as before', async () => {
    const replacement = laterMint();
    const { ask, mints, plans } = harness(
      ['t1', replacement.answer],
      [DENIED, OK],
    );
    const refused = ask('care homes in leeds', KEY);
    await until(() => mints.length === 2);
    replacement.give({ token: 't2' });
    expect(await refused).toEqual(OK);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't2']);
  });

  test('a replacement token that arrives once the wait it met has passed is used', async () => {
    const replacement = laterMint();
    const other = later();
    const { ask, mints, plans, clock } = harness(
      ['t1', replacement.answer],
      [DENIED, other.answer, OK],
    );
    const refused = ask('care homes in leeds', KEY);
    const told = ask('plcs in york', KEY);
    await until(() => mints.length === 2);
    other.give({ status: 'cooldown', until: 9_000 });
    await told;
    clock.now = 9_000;
    replacement.give({ token: 't2' });
    expect(await refused).toEqual(OK);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't1', 't2']);
  });

  test('a call that waits on the replacement mint while a wait is told is told the wait too, and sends nothing', async () => {
    const replacement = laterMint();
    const other = later();
    const { ask, mints, plans } = harness(
      ['t1', replacement.answer],
      [DENIED, other.answer],
    );
    const refused = ask('care homes in leeds', KEY);
    const told = ask('plcs in york', KEY);
    await until(() => mints.length === 2);
    const third = ask('nurseries in hull', KEY);
    other.give({ status: 'cooldown', until: 9_000 });
    await told;
    replacement.give({ token: 't2' });
    expect(await third).toEqual({ status: 'cooldown', until: 9_000 });
    expect(await refused).toEqual({ status: 'cooldown', until: 9_000 });
    expect(plans).toHaveLength(2);
  });

  test('a fresh mint after a wait was over whose token arrives once a later wait is told is not used', async () => {
    const fresh = laterMint();
    const first = later();
    const { ask, mints, plans, clock } = harness(
      ['t1', fresh.answer],
      [first.answer, { status: 'cooldown', until: 3_000 }],
    );
    const inFlight = ask('care homes in leeds', KEY);
    await ask('plcs in york', KEY);
    clock.now = 3_000;
    const after = ask('nurseries in hull', KEY);
    await until(() => mints.length === 2);
    first.give({ status: 'cooldown', until: 9_000 });
    await inFlight;
    fresh.give({ token: 't2' });
    expect(await after).toEqual({ status: 'cooldown', until: 9_000 });
    expect(plans).toHaveLength(2);
  });

  test('a replacement mint that names a later wait than a call has told is the one held: nothing is minted or sent until it is over', async () => {
    const replacement = laterMint();
    const other = later();
    const { ask, prepare, mints, plans, clock } = harness(
      ['t1', replacement.answer, 't3'],
      [DENIED, other.answer, OK],
    );
    const refused = ask('care homes in leeds', KEY);
    const told = ask('plcs in york', KEY);
    await until(() => mints.length === 2);
    other.give({ status: 'cooldown', until: 5_000 });
    expect(await told).toEqual({ status: 'cooldown', until: 5_000 });
    replacement.give({ token: null, cooldown: 9_000 });
    expect(await refused).toEqual({ status: 'cooldown', until: 9_000 });
    for (const at of [5_000, 8_999]) {
      clock.now = at;
      expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
      expect(await ask('nurseries in hull', KEY)).toEqual({
        status: 'cooldown',
        until: 9_000,
      });
    }
    expect(mints).toHaveLength(2);
    expect(plans).toHaveLength(2);
    clock.now = 9_000;
    expect(await ask('nurseries in hull', KEY)).toEqual(OK);
    expect(mints).toHaveLength(3);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't1', 't3']);
  });

  test('a replacement mint that names an earlier wait than a call has told does not shorten it: the call that waited on the mint is told the later one', async () => {
    const replacement = laterMint();
    const other = later();
    const { ask, prepare, mints, clock } = harness(
      ['t1', replacement.answer, 't3'],
      [DENIED, other.answer],
    );
    const refused = ask('care homes in leeds', KEY);
    const told = ask('plcs in york', KEY);
    await until(() => mints.length === 2);
    other.give({ status: 'cooldown', until: 9_000 });
    await told;
    replacement.give({ token: null, cooldown: 5_000 });
    expect(await refused).toEqual({ status: 'cooldown', until: 9_000 });
    clock.now = 5_000;
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mints).toHaveLength(2);
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toHaveLength(3);
  });

  test('a replacement mint that issues nothing while a wait is held is told the wait, not off: asking opens again when the wait ends', async () => {
    const replacement = laterMint();
    const other = later();
    const { ask, prepare, mints, clock } = harness(
      ['t1', replacement.answer, 't3'],
      [DENIED, other.answer],
    );
    const refused = ask('care homes in leeds', KEY);
    const told = ask('plcs in york', KEY);
    await until(() => mints.length === 2);
    other.give({ status: 'cooldown', until: 9_000 });
    await told;
    replacement.give({ token: null });
    expect(await refused).toEqual({ status: 'cooldown', until: 9_000 });
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mints).toHaveLength(2);
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toHaveLength(3);
  });

  test('a call made while a wait is held does not join a mint still out: it is told the wait at once', async () => {
    const stale = laterMint();
    const fresh = laterMint();
    const first = later();
    const { ask, prepare, mints, clock } = harness(
      ['t1', stale.answer, fresh.answer],
      [first.answer, DENIED],
    );
    // One call in flight on t1, and a second whose refusal starts a replacement mint that stays out.
    const inFlight = ask('care homes in leeds', KEY);
    const refused = ask('plcs in york', KEY);
    await until(() => mints.length === 2);
    first.give({ status: 'cooldown', until: 3_000 });
    await inFlight;
    // That wait over, a third call starts a new mint, which stays out too.
    clock.now = 3_000;
    void ask('nurseries in hull', KEY);
    await until(() => mints.length === 3);
    // The mint that stayed out first names a wait still ahead.
    stale.give({ token: null, cooldown: 9_000 });
    expect(await refused).toEqual({ status: 'cooldown', until: 9_000 });
    let offer: unknown;
    void prepare(KEY).then((answer) => {
      offer = answer;
    });
    await until(() => offer !== undefined);
    expect(offer).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mints).toHaveLength(3);
    void fresh;
  });

  test('a refused token is replaced by a new mint once the wait this document held has ended: the call is retried', async () => {
    const first = later();
    const second = later();
    const { ask, mints, plans, clock } = harness(
      ['t1', 't2'],
      [first.answer, second.answer, OK],
    );
    const told = ask('care homes in leeds', KEY);
    const refused = ask('plcs in york', KEY);
    await until(() => plans.length === 2);
    first.give({ status: 'cooldown', until: 5_000 });
    expect(await told).toEqual({ status: 'cooldown', until: 5_000 });
    clock.now = 5_001;
    second.give(DENIED);
    expect(await refused).toEqual(OK);
    expect(mints).toHaveLength(2);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't1', 't2']);
  });

  test('a refused token is not replaced while the wait this document holds is still ahead: the call is told the wait', async () => {
    const first = later();
    const second = later();
    const { ask, mints, plans, clock } = harness(
      ['t1', 't2'],
      [first.answer, second.answer, OK],
    );
    const told = ask('care homes in leeds', KEY);
    const refused = ask('plcs in york', KEY);
    await until(() => plans.length === 2);
    first.give({ status: 'cooldown', until: 5_000 });
    await told;
    clock.now = 4_999;
    second.give(DENIED);
    expect(await refused).toEqual({ status: 'cooldown', until: 5_000 });
    expect(mints).toHaveLength(1);
    expect(plans).toHaveLength(2);
  });

  test('a wait the page learnt elsewhere holds every call: nothing is minted or sent until it is over', async () => {
    const { prepare, ask, more, holdUntil, mints, plans, mores, clock } =
      harness(['t1'], [OK]);
    holdUntil(9_000);
    const wait = { status: 'cooldown', until: 9_000 } as const;
    expect(await prepare(KEY)).toEqual(wait);
    expect(await ask('care homes in leeds', KEY)).toEqual(wait);
    expect(await more('care homes', KEY, {}, 400, null)).toEqual(wait);
    expect(mints).toEqual([]);
    expect(plans).toEqual([]);
    expect(mores).toEqual([]);
    clock.now = 9_000;
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY]);
  });

  test('a wait learnt elsewhere holds a token this document already has, and an earlier one does not shorten a later', async () => {
    const { prepare, ask, holdUntil, mints, plans, clock } = harness(
      ['t1', 't2'],
      [OK, OK],
    );
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    holdUntil(9_000);
    holdUntil(5_000);
    clock.now = 5_000;
    expect(await ask('plcs in york', KEY)).toEqual({
      status: 'cooldown',
      until: 9_000,
    });
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    expect(plans).toHaveLength(1);
    expect(mints).toEqual([KEY]);
  });

  test('a wait the page learns while a call is out on its mint holds that call: nothing is sent', async () => {
    const { ask, holdUntil, mints, plans, clock } = harness(
      ['t1', 't2'],
      [{ status: 'cooldown', until: 3_000 }, OK],
    );
    await ask('care homes in leeds', KEY);
    clock.now = 3_000;
    // The first wait over, the call mints afresh, and the page learns a later wait before it resumes.
    const during = ask('plcs in york', KEY);
    holdUntil(9_000);
    expect(await during).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mints).toEqual([KEY, KEY]);
    expect(plans).toHaveLength(1);
  });

  test('a wait learnt elsewhere that is already over holds nothing, even with the clock put back before it', async () => {
    const { ask, holdUntil, mints, plans, clock } = harness(['t1'], [OK]);
    holdUntil(clock.now);
    holdUntil(clock.now - 1);
    clock.now -= 10;
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY]);
    expect(plans).toHaveLength(1);
  });

  test('a wait learnt elsewhere that is already over leaves the token as it is', async () => {
    const { ask, holdUntil, mints, plans, clock } = harness(['t1'], [OK, OK]);
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    holdUntil(clock.now);
    expect(await ask('plcs in york', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't1']);
  });

  test('a fresh mint after a wait was over that names a later wait than one told meanwhile is the one held', async () => {
    const fresh = laterMint();
    const first = later();
    const { ask, prepare, mints, clock } = harness(
      ['t1', fresh.answer, 't3'],
      [first.answer, { status: 'cooldown', until: 3_000 }],
    );
    const inFlight = ask('care homes in leeds', KEY);
    await ask('plcs in york', KEY);
    clock.now = 3_000;
    const after = ask('nurseries in hull', KEY);
    await until(() => mints.length === 2);
    first.give({ status: 'cooldown', until: 5_000 });
    await inFlight;
    fresh.give({ token: null, cooldown: 9_000 });
    expect(await after).toEqual({ status: 'cooldown', until: 9_000 });
    for (const at of [5_000, 8_999]) {
      clock.now = at;
      expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    }
    expect(mints).toHaveLength(2);
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toHaveLength(3);
  });

  test('a fresh mint after a wait was over that names an earlier wait than one told meanwhile answers the later', async () => {
    const fresh = laterMint();
    const first = later();
    const { ask, prepare, mints, plans, clock } = harness(
      ['t1', fresh.answer],
      [first.answer, { status: 'cooldown', until: 3_000 }],
    );
    const inFlight = ask('care homes in leeds', KEY);
    await ask('plcs in york', KEY);
    clock.now = 3_000;
    const after = ask('nurseries in hull', KEY);
    await until(() => mints.length === 2);
    first.give({ status: 'cooldown', until: 9_000 });
    await inFlight;
    fresh.give({ token: null, cooldown: 5_000 });
    expect(await after).toEqual({ status: 'cooldown', until: 9_000 });
    clock.now = 5_000;
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mints).toHaveLength(2);
    expect(plans).toHaveLength(2);
  });

  test('a wait told after a call read its token, but before that call resumed, holds it: the call is not sent', async () => {
    const other = later();
    const { ask, mints, plans } = harness(['t1'], [other.answer, OK]);
    const told = ask('care homes in leeds', KEY);
    await until(() => plans.length === 1);
    // Given first, with the next call started in the same turn: that call reads its token before the wait is noted, and resumes after.
    other.give({ status: 'cooldown', until: 9_000 });
    const second = ask('plcs in york', KEY);
    expect(await told).toEqual({ status: 'cooldown', until: 9_000 });
    expect(await second).toEqual({ status: 'cooldown', until: 9_000 });
    expect(plans).toHaveLength(1);
    expect(mints).toEqual([KEY]);
  });

  test('a wait told after prepare read the token, but before it resumed, is the offer: not open', async () => {
    const other = later();
    const { ask, prepare, plans } = harness(['t1'], [other.answer]);
    const told = ask('care homes in leeds', KEY);
    await until(() => plans.length === 1);
    other.give({ status: 'cooldown', until: 9_000 });
    const offer = prepare(KEY);
    await told;
    expect(await offer).toEqual({ status: 'cooldown', until: 9_000 });
  });

  test('a wait told after a further slice read its token, but before it resumed, holds it: the slice is not judged', async () => {
    const other = later();
    const { ask, more, plans, mores } = harness(['t1'], [other.answer]);
    const told = ask('care homes in leeds', KEY);
    await until(() => plans.length === 1);
    other.give({ status: 'cooldown', until: 9_000 });
    const slice = more('care homes', KEY, {}, 400, null);
    await told;
    expect(await slice).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mores).toEqual([]);
  });

  test('a refused token is not replaced while a wait is ahead: no mint is started, and the call is told the wait', async () => {
    const stale = laterMint();
    const first = later();
    const third = later();
    const { ask, mints, plans, clock } = harness(
      ['t1', stale.answer, 't3', 't4'],
      [first.answer, DENIED, third.answer, OK],
    );
    // One call in flight on t1, and a second whose refusal starts a replacement mint that stays out.
    const inFlight = ask('care homes in leeds', KEY);
    const refused = ask('plcs in york', KEY);
    await until(() => mints.length === 2);
    first.give({ status: 'cooldown', until: 3_000 });
    await inFlight;
    // That wait over, a third call mints afresh and is sent.
    clock.now = 3_000;
    const later3 = ask('nurseries in hull', KEY);
    await until(() => plans.length === 3);
    expect(mints).toHaveLength(3);
    // The mint that stayed out names a wait still ahead, and then the third call's token is refused.
    stale.give({ token: null, cooldown: 9_000 });
    expect(await refused).toEqual({ status: 'cooldown', until: 9_000 });
    third.give(DENIED);
    expect(await later3).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mints).toHaveLength(3);
    expect(plans).toHaveLength(3);
  });

  test('a wait learnt elsewhere takes the token with it: the first call after it mints afresh', async () => {
    const { ask, holdUntil, mints, plans, clock } = harness(
      ['t1', 't2'],
      [OK, OK],
    );
    expect(await ask('care homes in leeds', KEY)).toEqual(OK);
    holdUntil(9_000);
    clock.now = 9_000;
    expect(await ask('plcs in york', KEY)).toEqual(OK);
    expect(mints).toEqual([KEY, KEY]);
    expect(plans.map((p) => p[2])).toEqual(['t1', 't2']);
  });

  test('a wait the loader has seen end is not held again with the clock put back', async () => {
    const { prepare, holdUntil, mints, clock } = harness(['t1'], []);
    holdUntil(9_000);
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    clock.now = 8_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toEqual([KEY]);
  });

  test('a mint that throws while a wait is told answers the wait, not the failure, and the next call after it mints again', async () => {
    const replacement = laterMint();
    const other = later();
    const { ask, prepare, mints, clock } = harness(
      ['t1', replacement.answer, 't3'],
      [DENIED, other.answer],
    );
    const refused = ask('care homes in leeds', KEY);
    const told = ask('plcs in york', KEY);
    await until(() => mints.length === 2);
    other.give({ status: 'cooldown', until: 9_000 });
    await told;
    replacement.fail(new Error('mint failed'));
    expect(await refused).toEqual({ status: 'cooldown', until: 9_000 });
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toHaveLength(3);
  });

  test('a mint that throws with no wait held still rejects the call', async () => {
    const replacement = laterMint();
    const { ask, mints } = harness(['t1', replacement.answer], [DENIED]);
    const refused = ask('care homes in leeds', KEY);
    await until(() => mints.length === 2);
    replacement.fail(new Error('mint failed'));
    await expect(refused).rejects.toThrow('mint failed');
  });

  test('a retry refused while a wait is told answers the wait, not off', async () => {
    const other = later();
    const retry = later();
    const { ask, mints, plans } = harness(
      ['t1', 't2'],
      [DENIED, other.answer, retry.answer],
    );
    const refused = ask('care homes in leeds', KEY);
    const told = ask('plcs in york', KEY);
    await until(() => plans.length === 3);
    other.give({ status: 'cooldown', until: 9_000 });
    await told;
    retry.give(DENIED);
    expect(await refused).toEqual({ status: 'cooldown', until: 9_000 });
    expect(mints).toHaveLength(2);
  });

  test('a mint that issued a token is never taken for a wait, whatever time it carries', async () => {
    const { ask, prepare, mints, clock } = harness(
      [{ token: 't1', cooldown: 9_000 }, 't2'],
      [{ status: 'cooldown', until: 5_000 }],
    );
    expect(await ask('care homes in leeds', KEY)).toEqual({
      status: 'cooldown',
      until: 5_000,
    });
    clock.now = 5_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toEqual([KEY, KEY]);
  });

  test('a wait that is over is not kept: a later call’s wait is the one waited for', async () => {
    const { ask, prepare, mints, clock } = harness(
      ['t1', 't2', 't3'],
      [WAIT, { status: 'cooldown', until: 7_000 }],
    );
    expect(await ask('care homes in leeds', KEY)).toEqual(WAIT);
    clock.now = UNTIL;
    expect(await ask('plcs in york', KEY)).toEqual({
      status: 'cooldown',
      until: 7_000,
    });
    clock.now = 6_999;
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 7_000 });
    expect(mints).toEqual([KEY, KEY]);
    clock.now = 7_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toEqual([KEY, KEY, KEY]);
  });

  test('a wait that is over is forgotten as it is read: with the clock put back before it, nothing is held', async () => {
    const { ask, prepare, mints, clock } = harness(
      ['t1', 't2'],
      [{ status: 'cooldown', until: 9_000 }],
    );
    await ask('care homes in leeds', KEY);
    clock.now = 9_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    clock.now = 8_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toEqual([KEY, KEY]);
  });

  test('a wait a call names that this device’s clock says has passed is held a minute from now, never told as over', async () => {
    const { ask, prepare, mints, plans, clock } = harness(
      ['t1', 't2'],
      [{ status: 'cooldown', until: 7_000 }],
    );
    clock.now = 9_000;
    expect(await ask('care homes in leeds', KEY)).toEqual({
      status: 'cooldown',
      until: 69_000,
    });
    clock.now = 68_999;
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 69_000 });
    expect(mints).toEqual([KEY]);
    expect(plans).toHaveLength(1);
    clock.now = 69_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toEqual([KEY, KEY]);
  });

  test('a wait a mint names that this device’s clock says has passed is held a minute from now: no second mint follows at once', async () => {
    const { prepare, ask, mints, plans, clock } = harness(
      [{ cooldown: 900 }, 't2'],
      [],
    );
    expect(await prepare(KEY)).toEqual({ status: 'cooldown', until: 61_000 });
    expect(await ask('care homes in leeds', KEY)).toEqual({
      status: 'cooldown',
      until: 61_000,
    });
    expect(mints).toEqual([KEY]);
    expect(plans).toEqual([]);
    clock.now = 61_000;
    expect(await prepare(KEY)).toEqual(OPEN);
    expect(mints).toEqual([KEY, KEY]);
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
