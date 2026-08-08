// These values are the reason the module exists. A silent fallback would put them back in the
// repo, and a permissive one would widen what gets profiled without anyone noticing.

import { afterEach, describe, expect, test } from 'bun:test';

import { volumeFloor } from './ban-advice';
import { screenFloor, watchHours, watchIntervalMs } from './tuning';

const VARS = [
  'FW_WATCH_MIN_REQUESTS',
  'FW_WATCH_HOURS',
  'FW_WATCH_INTERVAL_MIN',
] as const;
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe.each([
  ['FW_WATCH_MIN_REQUESTS', screenFloor, 250, 250],
  ['FW_WATCH_HOURS', watchHours, 24, 24],
  ['FW_WATCH_INTERVAL_MIN', watchIntervalMs, 5, 5 * 60_000],
] as const)('%s', (name, read, set, want) => {
  test('reads the environment', () => {
    process.env[name] = String(set);
    expect(read()).toBe(want);
  });

  test('throws when unset rather than falling back', () => {
    // A default here is the whole thing being avoided: it publishes the number to the repo.
    delete process.env[name];
    expect(() => read()).toThrow(name);
  });

  test('throws on values that are not a positive integer', () => {
    for (const bad of ['', '  ', '0', '-5', '2.5', 'abc', 'NaN']) {
      process.env[name] = bad;
      expect(() => read()).toThrow(name);
    }
  });

  test('accepts exponent notation, which is a real integer', () => {
    // `1e3` is 1000. Odd to write in a .env file, but rejecting it would be a surprise, and
    // Number.isInteger is the thing being asserted rather than the spelling.
    process.env[name] = '1e3';
    expect(() => read()).not.toThrow();
  });
});

test('the message says where to set it, without printing a value', () => {
  delete process.env.FW_WATCH_MIN_REQUESTS;
  expect(() => screenFloor()).toThrow('.env.local');
});

// The screen floor and the advisory's volume floor used to disagree by the window length: the
// screen was absolute, the advisory scaled. Over 6 days the screen demanded 6x what the advisory
// needed, so nothing was ever profiled and the tool looked quiet.
describe('screenFloor scales with the window', () => {
  const withEnv = <T>(perDay: string, fn: () => T): T => {
    const prior = process.env.FW_WATCH_MIN_REQUESTS;
    process.env.FW_WATCH_MIN_REQUESTS = perDay;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env.FW_WATCH_MIN_REQUESTS;
      else process.env.FW_WATCH_MIN_REQUESTS = prior;
    }
  };

  test('the env value is a rate per day, not an absolute count', () => {
    withEnv('200', () => {
      expect(screenFloor(24 * 60)).toBe(200);
      expect(screenFloor(144 * 60)).toBe(1200);
    });
  });

  test('it never drops below what the advisory needs for the same window', () => {
    // Profiling an identity the advisory cannot reach a verdict on spends ~21 queries to
    // produce "not enough traffic to say".
    withEnv('1', () =>
      expect(screenFloor(144 * 60)).toBe(volumeFloor(144 * 60)),
    );
  });

  test('a higher rate is honoured — profiling less is a legitimate choice', () => {
    withEnv('2000', () => expect(screenFloor(24 * 60)).toBe(2000));
  });

  test('the two agree at every window when set to the advisory rate', () => {
    withEnv('200', () => {
      for (const h of [6, 24, 72, 144])
        expect(screenFloor(h * 60)).toBe(volumeFloor(h * 60));
    });
  });
});
