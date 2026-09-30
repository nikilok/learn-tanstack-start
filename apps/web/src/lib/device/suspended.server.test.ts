import { describe, expect, spyOn, test } from 'bun:test';

import { isSuspended } from './suspended.server';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const OTHER_KEY = 'f'.repeat(32);

/** A read answering with a fixed value, as the store would. */
const answering = (value: unknown) => async () => value;

describe('isSuspended', () => {
  test('a listed key is suspended, and only that key', async () => {
    const read = answering([OTHER_KEY, KEY]);
    expect(await isSuspended(KEY, read)).toBe(true);
    expect(await isSuspended('a'.repeat(32), read)).toBe(false);
  });

  test('an empty list suspends nobody', async () => {
    expect(await isSuspended(KEY, answering([]))).toBe(false);
  });

  test('a value that is not a list suspends nobody', async () => {
    for (const value of [undefined, null, KEY, { [KEY]: true }, 1])
      expect(await isSuspended(KEY, answering(value))).toBe(false);
  });

  test('a read that fails suspends nobody, and says so', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = async () => {
        throw new Error('network down');
      };
      expect(await isSuspended(KEY, failing)).toBe(false);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[1])).toContain('network down');
    } finally {
      logged.mockRestore();
    }
  });

  test('with no store connected, the default read suspends nobody and logs nothing', async () => {
    const saved = {
      GLOBAL_CONFIG: process.env.GLOBAL_CONFIG,
      EDGE_CONFIG: process.env.EDGE_CONFIG,
    };
    delete process.env.GLOBAL_CONFIG;
    delete process.env.EDGE_CONFIG;
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await isSuspended(KEY)).toBe(false);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      for (const [name, value] of Object.entries(saved))
        if (value !== undefined) process.env[name] = value;
    }
  });
});
