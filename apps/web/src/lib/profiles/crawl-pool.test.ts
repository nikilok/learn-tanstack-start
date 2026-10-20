import { describe, expect, test } from 'bun:test';

import { runPool, siteLane } from './crawl-pool';

/** Lets a finished run's completion chain start the next item. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Settle = { resolve: () => void; reject: (error: Error) => void };

/** A run function whose items finish only when the test says so. */
function manualRun(laneOf: (item: string) => string = (item) => item) {
  const running = new Map<string, Settle>();
  const started: string[] = [];
  let peak = 0;
  let laneClashes = 0;
  return {
    started,
    running: () => [...running.keys()],
    stats: () => ({ peak, laneClashes }),
    run: (item: string): Promise<void> => {
      started.push(item);
      if ([...running.keys()].some((other) => laneOf(other) === laneOf(item))) {
        laneClashes++;
      }
      return new Promise<void>((resolve, reject) => {
        running.set(item, { resolve, reject });
        peak = Math.max(peak, running.size);
      });
    },
    finish: async (item: string, error?: Error): Promise<void> => {
      const settle = running.get(item);
      if (!settle) throw new Error(`${item} is not running`);
      running.delete(item);
      if (error) settle.reject(error);
      else settle.resolve();
      await tick();
    },
  };
}

/** mulberry32, so a failing completion order replays from its seed. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('siteLane', () => {
  test('www and scheme variants of one site share a lane', () => {
    expect(siteLane('https://www.example.co.uk')).toBe('example.co.uk');
    expect(siteLane('http://example.co.uk')).toBe('example.co.uk');
    expect(siteLane('http://www.example.co.uk')).toBe('example.co.uk');
  });

  test('a port is the same server; another subdomain is another host', () => {
    expect(siteLane('https://example.co.uk:8443')).toBe('example.co.uk');
    expect(siteLane('https://shop.example.co.uk')).toBe('shop.example.co.uk');
  });

  test('an unparsable origin is a lane of its own', () => {
    expect(siteLane('null')).toBe('null');
  });
});

describe('runPool', () => {
  test('fills every slot and never exceeds the bound', async () => {
    const harness = manualRun();
    const done = runPool(['a', 'b', 'c', 'd', 'e', 'f'], {
      concurrency: 3,
      laneOf: (item) => item,
      run: harness.run,
    });
    expect(harness.running()).toEqual(['a', 'b', 'c']);
    await harness.finish('b');
    expect(harness.running()).toEqual(['a', 'c', 'd']);
    for (const item of ['a', 'c', 'd', 'e', 'f']) await harness.finish(item);
    await done;
    expect(harness.started).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(harness.stats().peak).toBe(3);
  });

  // The 2026-10-20 population held 36 sites as two origins each (33 www, 3 scheme).
  test('two origins of one site never crawl at once; the next site goes first', async () => {
    const harness = manualRun(siteLane);
    const done = runPool(
      ['https://www.acme.co.uk', 'http://acme.co.uk', 'https://other.co.uk'],
      { concurrency: 3, laneOf: siteLane, run: harness.run },
    );
    expect(harness.running()).toEqual([
      'https://www.acme.co.uk',
      'https://other.co.uk',
    ]);
    await harness.finish('https://www.acme.co.uk');
    expect(harness.running()).toEqual([
      'https://other.co.uk',
      'http://acme.co.uk',
    ]);
    await harness.finish('https://other.co.uk');
    await harness.finish('http://acme.co.uk');
    await done;
    expect(harness.stats().laneClashes).toBe(0);
  });

  test('resolves only after the last running item finishes', async () => {
    const harness = manualRun();
    let settled = false;
    const done = runPool(['a', 'b', 'c'], {
      concurrency: 3,
      laneOf: (item) => item,
      run: harness.run,
    }).finally(() => {
      settled = true;
    });
    await harness.finish('a');
    await harness.finish('c');
    expect(settled).toBe(false);
    await harness.finish('b');
    await done;
    expect(settled).toBe(true);
  });

  test('concurrency 1 is the sequential sweep, in rotation order', async () => {
    const harness = manualRun();
    const done = runPool(['c', 'a', 'b'], {
      concurrency: 1,
      laneOf: (item) => item,
      run: harness.run,
    });
    for (const item of ['c', 'a', 'b']) {
      expect(harness.running()).toEqual([item]);
      await harness.finish(item);
    }
    await done;
    expect(harness.started).toEqual(['c', 'a', 'b']);
  });

  test('stop halts new starts and lets running items finish', async () => {
    const harness = manualRun();
    let aborted = false;
    let settled = false;
    const done = runPool(['a', 'b', 'c', 'd'], {
      concurrency: 2,
      laneOf: (item) => item,
      run: harness.run,
      stop: () => aborted,
    }).finally(() => {
      settled = true;
    });
    aborted = true;
    await harness.finish('a');
    expect(harness.running()).toEqual(['b']);
    expect(settled).toBe(false);
    await harness.finish('b');
    await done;
    expect(harness.started).toEqual(['a', 'b']);
  });

  test('a failed run stops new starts and rejects once running items settle', async () => {
    const harness = manualRun();
    let settled = false;
    const outcome = runPool(['a', 'b', 'c', 'd'], {
      concurrency: 2,
      laneOf: (item) => item,
      run: harness.run,
    })
      .then(
        () => 'resolved',
        (error: Error) => error.message,
      )
      .finally(() => {
        settled = true;
      });
    await harness.finish('a', new Error('db down'));
    expect(harness.running()).toEqual(['b']);
    expect(settled).toBe(false);
    await harness.finish('b');
    expect(await outcome).toBe('db down');
    expect(harness.started).toEqual(['a', 'b']);
  });

  test('a synchronous throw from run rejects instead of escaping', async () => {
    let calls = 0;
    const outcome = await runPool(['a', 'b', 'c', 'd'], {
      concurrency: 2,
      laneOf: (item) => item,
      run: () => {
        calls++;
        throw new Error('boom');
      },
    }).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    expect(outcome).toBe('boom');
    expect(calls).toBeLessThanOrEqual(2);
  });

  test('an empty queue resolves at once', async () => {
    let calls = 0;
    await runPool([], {
      concurrency: 4,
      laneOf: (item: string) => item,
      run: async () => {
        calls++;
      },
    });
    expect(calls).toBe(0);
  });

  test('rejects a concurrency that is not a positive integer', async () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      const outcome = await runPool(['a'], {
        concurrency,
        laneOf: (item) => item,
        run: async () => {},
      }).then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      expect(outcome).toContain('positive integer');
    }
  });

  test('any completion order: each item runs once, inside the bound, one per lane', async () => {
    const random = seeded(20261020);
    for (let round = 0; round < 40; round++) {
      const concurrency = 1 + Math.floor(random() * 8);
      const lanes = new Map(
        Array.from({ length: 30 }, (_, i) => [
          `item-${i}`,
          `lane-${Math.floor(random() * 6)}`,
        ]),
      );
      const laneOf = (item: string) => lanes.get(item) as string;
      const harness = manualRun(laneOf);
      const done = runPool([...lanes.keys()], {
        concurrency,
        laneOf,
        run: harness.run,
      });
      for (;;) {
        const running = harness.running();
        if (running.length === 0) break;
        // A free lane with queued work must never sit idle under the bound.
        const busyLanes = new Set(running.map(laneOf));
        const queued = [...lanes.keys()].filter(
          (item) => !harness.started.includes(item),
        );
        if (running.length < concurrency) {
          expect(queued.every((item) => busyLanes.has(laneOf(item)))).toBe(
            true,
          );
        }
        await harness.finish(running[Math.floor(random() * running.length)]);
      }
      await done;
      expect([...harness.started].sort()).toEqual([...lanes.keys()].sort());
      expect(harness.stats().peak).toBeLessThanOrEqual(concurrency);
      expect(harness.stats().laneClashes).toBe(0);
    }
  });
});
