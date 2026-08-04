import { describe, expect, test } from 'bun:test';

import { MAX_WINDOW_DAYS, parseDate, resolveWindow, rollingWindow } from './time-window';

const NOW = new Date('2026-08-04T12:30:00.000Z');
const ok = (r: ReturnType<typeof resolveWindow>) => {
  if ('error' in r) throw new Error(`expected a window, got: ${r.error}`);
  return r.window;
};
const err = (r: ReturnType<typeof resolveWindow>) => {
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
};

describe('parseDate', () => {
  test('accepts mm dd yyyy and the usual separators', () => {
    for (const s of ['08 01 2026', '08/01/2026', '08-01-2026', '8.1.2026'])
      expect(parseDate(s)?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  test('rejects a day that does not exist in that month', () => {
    // Date would silently roll this into March.
    expect(parseDate('02 31 2026')).toBeNull();
    expect(parseDate('04 31 2026')).toBeNull();
  });

  test('accepts a real leap day and rejects a fake one', () => {
    expect(parseDate('02 29 2028')).not.toBeNull();
    expect(parseDate('02 29 2026')).toBeNull();
  });

  test('rejects nonsense and out-of-range months', () => {
    expect(parseDate('13 01 2026')).toBeNull();
    expect(parseDate('00 01 2026')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
    expect(parseDate('')).toBeNull();
  });
});

describe('resolveWindow', () => {
  test('a single date runs from that day to now', () => {
    const w = ok(resolveWindow('08 01 2026', NOW));
    expect(w.fromISO).toBe('2026-08-01T00:00:00.000Z');
    expect(w.toISO).toBe('2026-08-04T13:00:00.000Z'); // ceiled to the hour
  });

  test('a range includes the whole end day', () => {
    const w = ok(resolveWindow('08 01 2026 - 08 02 2026', NOW));
    expect(w.fromISO).toBe('2026-08-01T00:00:00.000Z');
    expect(w.toISO).toBe('2026-08-03T00:00:00.000Z');
    expect(w.hours).toBe(48);
  });

  test('a single-day range still covers 24h, not zero', () => {
    const w = ok(resolveWindow('08 02 2026 - 08 02 2026', NOW));
    expect(w.hours).toBe(24);
  });

  test('start and end are hour-aligned, as the API demands', () => {
    const w = ok(resolveWindow('08 01 2026', NOW));
    expect(new Date(w.fromISO).getUTCMinutes()).toBe(0);
    expect(new Date(w.toISO).getUTCMinutes()).toBe(0);
  });

  test('the label reads as the range the operator typed', () => {
    expect(ok(resolveWindow('08 01 2026 - 08 02 2026', NOW)).label).toBe('01 Aug - 02 Aug');
  });

  test('anything past the API limit is refused with the earliest date named', () => {
    const e = err(resolveWindow('07 01 2026', NOW));
    expect(e).toContain(`last ${MAX_WINDOW_DAYS} days`);
    expect(e).toContain('Jul'); // names the earliest servable date
  });

  test('a backwards range is refused', () => {
    expect(err(resolveWindow('08 03 2026 - 08 01 2026', NOW))).toContain(
      'before the end date',
    );
  });

  test('a future start is refused', () => {
    expect(err(resolveWindow('09 01 2026', NOW))).toContain('future');
  });

  test('an unparseable entry shows a usable example, not a grammar', () => {
    // A concrete example beats "mm dd yyyy [- mm dd yyyy]" — bracket notation reads as literal.
    expect(err(resolveWindow('last tuesday', NOW))).toContain('08 02 2026');
    expect(err(resolveWindow('', NOW))).toContain('mm dd yyyy');
  });

  test('a range ending in the future is clamped to now', () => {
    const w = ok(resolveWindow('08 03 2026 - 12 31 2026', NOW));
    expect(w.toISO).toBe('2026-08-04T13:00:00.000Z');
  });
});

describe('rollingWindow', () => {
  test('is hour-aligned and exactly the requested length', () => {
    const w = rollingWindow(24, NOW);
    expect(w.toISO).toBe('2026-08-04T13:00:00.000Z');
    expect(w.fromISO).toBe('2026-08-03T13:00:00.000Z');
    expect(w.hours).toBe(24);
    expect(w.label).toBe('last 24h');
  });
});

describe('resolveWindow — forgiving input', () => {
  const okw = (t: string) => {
    const r = resolveWindow(t, NOW);
    if ('error' in r) throw new Error(`expected a window for "${t}", got: ${r.error}`);
    return r.window;
  };

  test('a range works with a dash, with slashes, or with nothing but spaces', () => {
    const want = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-03T00:00:00.000Z' };
    for (const t of [
      '08 01 2026 - 08 02 2026',
      '08/01/2026 - 08/02/2026',
      '08 01 2026 08 02 2026',
      '08-01-2026 08-02-2026',
    ]) {
      expect(okw(t).fromISO).toBe(want.from);
      expect(okw(t).toISO).toBe(want.to);
    }
  });

  test('the wrong number of parts explains the format with a real example', () => {
    const e = err(resolveWindow('08 2026', NOW));
    expect(e).toContain('08 02 2026 - 08 04 2026');
  });

  test('a real-looking but impossible date says so specifically', () => {
    expect(err(resolveWindow('02 31 2026', NOW))).toContain('not a real date');
  });

  test('a two-digit year is refused rather than read as year 26', () => {
    expect(err(resolveWindow('08 01 26', NOW))).toContain('not a real date');
  });
});
