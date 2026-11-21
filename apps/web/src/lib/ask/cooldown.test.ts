import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import {
  askAgainWhen,
  clearCooldown,
  COOLDOWN_SECONDS,
  cooldownHold,
  cooldownNotice,
  heardCooldown,
  keepCooldown,
  laterCooldown,
  latestCooldown,
  loadCooldown,
  onCooldownKept,
  saveCooldown,
  storedCooldown,
  toldCooldown,
  waitAfter,
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

describe('laterCooldown', () => {
  test('with no wait known, the one told is kept', () => {
    expect(laterCooldown(null, NOW + HOUR)).toBe(NOW + HOUR);
  });

  test('the later of the known wait and the one told is kept, whichever came first', () => {
    expect(laterCooldown(NOW + 2 * HOUR, NOW + HOUR)).toBe(NOW + 2 * HOUR);
    expect(laterCooldown(NOW + HOUR, NOW + 2 * HOUR)).toBe(NOW + 2 * HOUR);
  });

  test('a wait told twice is kept as it is', () => {
    expect(laterCooldown(NOW + HOUR, NOW + HOUR)).toBe(NOW + HOUR);
  });
});

describe('toldCooldown', () => {
  test('a wait told that is still ahead is held as told', () => {
    expect(toldCooldown(NOW + HOUR, NOW)).toBe(NOW + HOUR);
    expect(toldCooldown(NOW + 1, NOW)).toBe(NOW + 1);
  });

  test('a wait told that this device’s clock says has passed is held a minute from now: it is never over as it is told', () => {
    expect(toldCooldown(NOW, NOW)).toBe(NOW + 60_000);
    expect(toldCooldown(NOW - 1, NOW)).toBe(NOW + 60_000);
    expect(toldCooldown(NOW - COOLDOWN, NOW)).toBe(NOW + 60_000);
  });

  test('what is held is a time the device’s record keeps and reads back', () => {
    for (const told of [NOW - HOUR, NOW, NOW + HOUR])
      expect(storedCooldown(String(toldCooldown(told, NOW)), NOW)).toBe(
        toldCooldown(told, NOW),
      );
  });
});

describe('latestCooldown', () => {
  test('a wait already shown that is later than the stored and the told one stands', () => {
    expect(latestCooldown(NOW + 3 * HOUR, NOW + 2 * HOUR, NOW + HOUR)).toBe(
      NOW + 3 * HOUR,
    );
  });

  test('with nothing stored, the later of the shown and the told one is kept', () => {
    expect(latestCooldown(NOW + 2 * HOUR, null, NOW + HOUR)).toBe(
      NOW + 2 * HOUR,
    );
    expect(latestCooldown(null, null, NOW + HOUR)).toBe(NOW + HOUR);
  });

  test('a told wait later than the shown and the stored one is kept', () => {
    expect(latestCooldown(NOW + HOUR, NOW + 2 * HOUR, NOW + 3 * HOUR)).toBe(
      NOW + 3 * HOUR,
    );
  });

  test('a stored wait later than the shown and the told one is kept', () => {
    expect(latestCooldown(NOW + HOUR, NOW + 3 * HOUR, NOW + 2 * HOUR)).toBe(
      NOW + 3 * HOUR,
    );
    expect(latestCooldown(null, NOW + 3 * HOUR, NOW + 2 * HOUR)).toBe(
      NOW + 3 * HOUR,
    );
  });
});

describe('waitAfter', () => {
  const ENDED = NOW + HOUR;

  test('with nothing stored, no wait is left', () => {
    expect(waitAfter(ENDED, null)).toBeNull();
  });

  test('a stored wait that is not later than the one that ended is not kept', () => {
    expect(waitAfter(ENDED, ENDED - 1)).toBeNull();
    expect(waitAfter(ENDED, ENDED)).toBeNull();
  });

  test('a later stored wait is the one still to keep', () => {
    expect(waitAfter(ENDED, ENDED + HOUR)).toBe(ENDED + HOUR);
  });
});

describe('heardCooldown', () => {
  const heard = (shown: number | null, stored: number | null, owner = false) =>
    heardCooldown({ owner, shown, stored, now: NOW });

  test('a wait another tab kept is shown where none was, and where an earlier one was', () => {
    expect(heard(null, NOW + HOUR)).toEqual({ show: NOW + HOUR, keep: null });
    expect(heard(NOW + HOUR, NOW + 2 * HOUR)).toEqual({
      show: NOW + 2 * HOUR,
      keep: null,
    });
  });

  test('an earlier wait written over a later one this document shows is put back, and the later one stays shown', () => {
    expect(heard(NOW + 2 * HOUR, NOW + HOUR)).toEqual({
      show: NOW + 2 * HOUR,
      keep: NOW + 2 * HOUR,
    });
  });

  test('a wait forgotten elsewhere while this document shows one still ahead is put back', () => {
    expect(heard(NOW + HOUR, null)).toEqual({
      show: NOW + HOUR,
      keep: NOW + HOUR,
    });
  });

  test('a wait shown that is over is not put back: the one kept, if any, is shown', () => {
    expect(heard(NOW, null)).toEqual({ show: NOW, keep: null });
    expect(heard(NOW - 1, null)).toEqual({ show: NOW - 1, keep: null });
    expect(heard(NOW, NOW + HOUR)).toEqual({ show: NOW + HOUR, keep: null });
  });

  test('the same wait kept as shown changes nothing, and neither does none at all', () => {
    expect(heard(NOW + HOUR, NOW + HOUR)).toEqual({
      show: NOW + HOUR,
      keep: null,
    });
    expect(heard(null, null)).toEqual({ show: null, keep: null });
  });

  test('the owner’s document shows and puts back nothing, whatever is kept', () => {
    expect(heard(null, NOW + HOUR, true)).toEqual({ show: null, keep: null });
    expect(heard(null, null, true)).toEqual({ show: null, keep: null });
  });
});

describe('onCooldownKept', () => {
  type Listener = (event: { key: string | null }) => void;
  // One global for every test file: put back exactly as it was found.
  const found = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let listeners: Listener[];

  beforeEach(() => {
    listeners = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        addEventListener: (type: string, listener: Listener) => {
          if (type === 'storage') listeners.push(listener);
        },
        removeEventListener: (type: string, listener: Listener) => {
          if (type === 'storage')
            listeners = listeners.filter((kept) => kept !== listener);
        },
      },
    });
  });
  afterEach(() => {
    if (found) Object.defineProperty(globalThis, 'window', found);
    else delete (globalThis as { window?: unknown }).window;
  });

  /** Tells every listener the store changed under a key. */
  const change = (key: string | null) => {
    for (const listener of listeners) listener({ key });
  };

  test('a change to the device’s wait is heard, and so is the whole store cleared', () => {
    let heard = 0;
    onCooldownKept(() => {
      heard += 1;
    });
    change('ss-ask-cooldown');
    change(null);
    expect(heard).toBe(2);
  });

  test('a change to anything else kept in the browser is not', () => {
    let heard = 0;
    onCooldownKept(() => {
      heard += 1;
    });
    change('hmrc-highlight');
    change('ss-ask-cooldown-other');
    expect(heard).toBe(0);
  });

  test('once stopped, nothing more is heard and no listener is left behind', () => {
    let heard = 0;
    const stop = onCooldownKept(() => {
      heard += 1;
    });
    expect(listeners).toHaveLength(1);
    stop();
    expect(listeners).toHaveLength(0);
    change('ss-ask-cooldown');
    expect(heard).toBe(0);
  });

  test('with no window there is nothing to hear, and stopping is harmless', () => {
    delete (globalThis as { window?: unknown }).window;
    const stop = onCooldownKept(() => {
      throw new Error('heard without a window');
    });
    expect(() => stop()).not.toThrow();
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

  test('a wait is kept unless a later one is kept already', () => {
    keepCooldown(NOW + 2 * HOUR, NOW);
    expect(loadCooldown(NOW)).toBe(NOW + 2 * HOUR);
    keepCooldown(NOW + HOUR, NOW);
    expect(loadCooldown(NOW)).toBe(NOW + 2 * HOUR);
    keepCooldown(NOW + 3 * HOUR, NOW);
    expect(loadCooldown(NOW)).toBe(NOW + 3 * HOUR);
  });

  test('a kept wait that has ended, or one nobody wrote, gives way to the next one kept', () => {
    saveCooldown(NOW - 1);
    keepCooldown(NOW + HOUR, NOW);
    expect(loadCooldown(NOW)).toBe(NOW + HOUR);
    saveCooldown(NOW + 3 * COOLDOWN);
    keepCooldown(NOW + 2 * HOUR, NOW);
    expect(loadCooldown(NOW)).toBe(NOW + 2 * HOUR);
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
    expect(() => keepCooldown(NOW + HOUR, NOW)).not.toThrow();
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
      'That’s the limit for questions for now. You can ask again after 14:05 on Sunday.',
    );
  });

  test('at the end of a question’s listing: when the rest can load', () => {
    expect(cooldownHold(NOW + COOLDOWN, LONDON)).toBe(
      'That’s the limit for questions for now. More matches can load after 14:05 on Sunday.',
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
