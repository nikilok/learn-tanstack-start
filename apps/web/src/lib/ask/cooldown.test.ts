import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import {
  askAgainWhen,
  clearCooldown,
  COOLDOWN_SECONDS,
  cooldownHold,
  cooldownNotice,
  loadCooldown,
  saveCooldown,
  storedCooldown,
} from './cooldown';

const HOUR = 60 * 60 * 1000;
const COOLDOWN = COOLDOWN_SECONDS * 1000;
// 21 November 2026, 14:05 in London (GMT).
const NOW = Date.UTC(2026, 10, 21, 14, 5);
const LONDON = { locale: 'en-GB', timeZone: 'Europe/London' };

describe('storedCooldown', () => {
  test('a time still ahead holds', () => {
    expect(storedCooldown(String(NOW + HOUR), NOW)).toBe(NOW + HOUR);
    expect(storedCooldown(String(NOW + COOLDOWN), NOW)).toBe(NOW + COOLDOWN);
  });

  test('a time that has come, or passed, holds nothing', () => {
    expect(storedCooldown(String(NOW), NOW)).toBeNull();
    expect(storedCooldown(String(NOW - 1), NOW)).toBeNull();
  });

  test('a time further ahead than two cooldowns is nobody’s: a clock put back never closes asking for good', () => {
    expect(storedCooldown(String(NOW + 2 * COOLDOWN), NOW)).toBe(
      NOW + 2 * COOLDOWN,
    );
    expect(storedCooldown(String(NOW + 2 * COOLDOWN + 1), NOW)).toBeNull();
    expect(storedCooldown('99999999999999999', NOW)).toBeNull();
  });

  test('anything that is not a stored time holds nothing', () => {
    for (const value of [
      null,
      undefined,
      '',
      'tomorrow',
      'NaN',
      'Infinity',
      NOW + HOUR,
      {},
    ])
      expect(storedCooldown(value, NOW)).toBeNull();
  });
});

describe('the device’s record', () => {
  // Every test file shares one global: the property goes back exactly as it was found, or a file
  // that assigns its own storage afterwards finds it read-only.
  const found = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let kept: Map<string, string>;

  beforeEach(() => {
    kept = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => void kept.set(key, value),
        removeItem: (key: string) => void kept.delete(key),
      },
    });
  });
  afterEach(() => {
    if (found) Object.defineProperty(globalThis, 'localStorage', found);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test('a cooldown kept is the one read back, until it ends', () => {
    saveCooldown(NOW + HOUR);
    expect(loadCooldown(NOW)).toBe(NOW + HOUR);
    expect(loadCooldown(NOW + HOUR)).toBeNull();
  });

  test('nothing kept is no cooldown, and a cleared one is gone', () => {
    expect(loadCooldown(NOW)).toBeNull();
    saveCooldown(NOW + HOUR);
    clearCooldown();
    expect(loadCooldown(NOW)).toBeNull();
  });

  test('storage that throws is no cooldown known, and nothing is thrown on', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage denied');
      },
    });
    expect(loadCooldown(NOW)).toBeNull();
    expect(() => saveCooldown(NOW + HOUR)).not.toThrow();
    expect(() => clearCooldown()).not.toThrow();
  });
});

describe('askAgainWhen', () => {
  test('a cooldown ends at the same clock time the next day, and the day is named', () => {
    // Saturday 21 November; a day on is a Sunday.
    expect(askAgainWhen(NOW + COOLDOWN, LONDON)).toBe('14:05 on Sunday');
    expect(askAgainWhen(NOW + 2 * COOLDOWN, LONDON)).toBe('14:05 on Monday');
  });

  test('a page left open past midnight still reads true: nothing in it is counted from the time it is read', () => {
    const until = NOW + COOLDOWN;
    const clock = spyOn(Date, 'now');
    try {
      // Read at 23:30 the evening before, and again at 00:30 on the day itself.
      const read = [
        Date.UTC(2026, 10, 21, 23, 30),
        Date.UTC(2026, 10, 22, 0, 30),
      ].map((at) => {
        clock.mockReturnValue(at);
        return [
          askAgainWhen(until, LONDON),
          cooldownNotice(until, LONDON),
          cooldownHold(until, LONDON),
        ];
      });
      expect(read[1]).toEqual(read[0]);
      for (const line of read[0]) expect(line).not.toMatch(/today|tomorrow/);
    } finally {
      clock.mockRestore();
    }
  });

  test('the day is the visitor’s own: late evening in London is already the next day in Tokyo', () => {
    const late = Date.UTC(2026, 10, 21, 23, 30);
    expect(askAgainWhen(late, LONDON)).toBe('23:30 on Saturday');
    expect(
      askAgainWhen(late, { locale: 'en-GB', timeZone: 'Asia/Tokyo' }),
    ).toBe('08:30 on Sunday');
  });

  test('the time is said as the visitor’s locale says it, the day in the language of the line', () => {
    expect(
      askAgainWhen(NOW + COOLDOWN, {
        locale: 'en-US',
        timeZone: 'America/New_York',
      }),
    ).toMatch(/^9:05\sAM on Sunday$/);
    expect(
      askAgainWhen(NOW + COOLDOWN, {
        locale: 'fr-FR',
        timeZone: 'Europe/Paris',
      }),
    ).toBe('15:05 on Sunday');
  });

  test('the clocks changing overnight does not move the day', () => {
    // 24 October 2026, 20:00 BST; the clocks go back at 02:00 on the 25th, a Sunday.
    const before = Date.UTC(2026, 9, 24, 19, 0);
    expect(askAgainWhen(before + COOLDOWN, LONDON)).toBe('19:00 on Sunday');
  });
});

describe('what a waiting visitor is told', () => {
  test('where an ask would have gone: the limit, and when asking opens again', () => {
    expect(cooldownNotice(NOW + COOLDOWN, LONDON)).toBe(
      'You’ve reached the limit for questions for now. You can ask again after 14:05 on Sunday.',
    );
  });

  test('at the end of a question’s listing: when the rest can load', () => {
    expect(cooldownHold(NOW + COOLDOWN, LONDON)).toBe(
      'You’ve reached the limit for questions for now. More matches can load after 14:05 on Sunday.',
    );
  });

  test('no em dash in either line', () => {
    for (const line of [
      cooldownNotice(NOW + COOLDOWN, LONDON),
      cooldownHold(NOW + COOLDOWN, LONDON),
    ])
      expect(line).not.toContain('—');
  });
});
