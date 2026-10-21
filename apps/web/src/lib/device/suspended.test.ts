import { describe, expect, spyOn, test } from 'bun:test';

import {
  createSuspendedReader,
  SESSION_SUSPENDED_KEYS_ITEM,
  SUSPENDED_KEYS_ITEM,
  suspendedKeysOf,
} from './suspended';

describe('the two lists', () => {
  test("sessions read a list of their own, never the extras' list", () => {
    expect(SESSION_SUSPENDED_KEYS_ITEM).not.toBe(SUSPENDED_KEYS_ITEM);
  });
});

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';
const OTHER_KEY = 'f'.repeat(32);

describe('suspendedKeysOf', () => {
  test('a list names its well-formed keys; anything else names none', () => {
    expect([
      ...suspendedKeysOf([KEY, 'nope', 42, KEY.toUpperCase(), OTHER_KEY]),
    ]).toEqual([KEY, OTHER_KEY]);
    for (const value of [undefined, null, KEY, { [KEY]: true }, 1])
      expect(suspendedKeysOf(value).size).toBe(0);
  });
});

describe('createSuspendedReader', () => {
  test('a list read is reused for a minute, then read again', async () => {
    let reads = 0;
    const list = [[KEY], [KEY, OTHER_KEY]];
    const keys = createSuspendedReader(async () => list[reads++]);
    expect([...(await keys(0))]).toEqual([KEY]);
    expect([...(await keys(59_999))]).toEqual([KEY]);
    expect(reads).toBe(1);
    expect([...(await keys(60_000))]).toEqual([KEY, OTHER_KEY]);
    expect(reads).toBe(2);
  });

  test('calls that find the list due while a read is out share that read', async () => {
    let reads = 0;
    let answer: (value: unknown) => void = () => {};
    const keys = createSuspendedReader(
      () =>
        new Promise((resolve) => {
          reads++;
          answer = resolve;
        }),
    );
    const first = keys(0);
    const second = keys(10);
    answer([KEY]);
    expect([...(await first)]).toEqual([KEY]);
    expect([...(await second)]).toEqual([KEY]);
    expect(reads).toBe(1);
  });

  test('a read that takes too long counts as failed: the last list read stands', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      let hang = false;
      const keys = createSuspendedReader(
        async () => (hang ? new Promise(() => {}) : [KEY]),
        60_000,
        5,
      );
      expect([...(await keys(0))]).toEqual([KEY]);
      hang = true;
      expect([...(await keys(60_000))]).toEqual([KEY]);
      expect(String(logged.mock.calls[0]?.[1])).toContain('no answer in 5 ms');
    } finally {
      logged.mockRestore();
    }
  });

  test('a read that fails keeps the last list read, and before any is read suspends nobody', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      let fail = true;
      const keys = createSuspendedReader(async () => {
        if (fail) throw new Error('network down');
        return [KEY];
      });
      expect((await keys(0)).size).toBe(0);
      fail = false;
      expect([...(await keys(60_000))]).toEqual([KEY]);
      fail = true;
      expect([...(await keys(120_000))]).toEqual([KEY]);
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });
});
