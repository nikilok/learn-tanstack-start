import { describe, expect, test } from 'bun:test';

import { type Args, hoursFrom, parseArgs } from './profile';

describe('hoursFrom', () => {
  test('defaults to a day', () => {
    expect(hoursFrom(undefined)).toBe(24);
  });

  test('rejects non-positive-integer input', () => {
    expect(() => hoursFrom('0')).toThrow(/positive integer/);
    expect(() => hoursFrom('-3')).toThrow(/positive integer/);
    expect(() => hoursFrom('2.5')).toThrow(/positive integer/);
    expect(() => hoursFrom('yesterday')).toThrow(/positive integer/);
  });

  test('rejects a window past what the free tier serves', () => {
    expect(hoursFrom('144')).toBe(144);
    expect(() => hoursFrom('145')).toThrow(/observability window/);
  });
});

describe('parseArgs', () => {
  const profile = (a: Args) => a as Extract<Args, { mode: 'profile' }>;
  const top = (a: Args) => a as Extract<Args, { mode: 'top' }>;

  test('bare IP profiles it over the default window', () => {
    const a = profile(parseArgs(['31.94.4.48']));
    expect(a.mode).toBe('profile');
    expect(a.ip).toBe('31.94.4.48');
    expect(a.hours).toBe(24);
  });

  test('IP plus hours — the positional after the IP is NOT eaten by --limit', () => {
    // Regression: indexOf('--limit') returns -1 when absent, and -1+1 === 0 dropped the IP.
    const a = profile(parseArgs(['31.94.4.48', '72']));
    expect(a.ip).toBe('31.94.4.48');
    expect(a.hours).toBe(72);
  });

  test('--top defaults hours and limit', () => {
    const a = top(parseArgs(['--top']));
    expect(a.mode).toBe('top');
    expect(a.hours).toBe(24);
    expect(a.limit).toBe(30);
  });

  test('--top with hours and an explicit limit', () => {
    const a = top(parseArgs(['--top', '6', '--limit', '40']));
    expect(a.hours).toBe(6);
    expect(a.limit).toBe(40);
  });

  test("--limit's value never reads back as hours", () => {
    const a = top(parseArgs(['--top', '--limit', '40']));
    expect(a.limit).toBe(40);
    expect(a.hours).toBe(24);
  });

  test('rejects a bad --limit', () => {
    expect(() => parseArgs(['--top', '--limit', '0'])).toThrow(/--limit/);
    expect(() => parseArgs(['--top', '--limit', 'lots'])).toThrow(/--limit/);
  });

  test('no args, or help, prints usage', () => {
    expect(parseArgs([]).mode).toBe('help');
    expect(parseArgs(['--help']).mode).toBe('help');
    expect(parseArgs(['-h']).mode).toBe('help');
    expect(parseArgs(['--limit', '5']).mode).toBe('help'); // no IP given
  });
});
