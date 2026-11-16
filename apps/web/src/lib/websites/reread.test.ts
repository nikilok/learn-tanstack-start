import { describe, expect, test } from 'bun:test';

import { rereadCutoff } from './reread';

const now = new Date('2026-11-16T13:00:00Z');

describe('rereadCutoff', () => {
  test('a date is the start of that day', () => {
    expect(rereadCutoff('2026-11-16', now)).toBe('2026-11-16 00:00:00');
  });

  test('a date and time is kept to the second', () => {
    expect(rereadCutoff('2026-11-03T08:40', now)).toBe('2026-11-03 08:40:00');
    expect(rereadCutoff('2026-11-03 08:40:15', now)).toBe(
      '2026-11-03 08:40:15',
    );
  });

  test('a time that has not passed is refused, so no row is read twice in a run', () => {
    expect(() => rereadCutoff('2026-11-16T13:01', now)).toThrow(/not passed/);
    expect(() => rereadCutoff('2026-11-17', now)).toThrow(/not passed/);
  });

  test('a date that does not exist is refused, not rolled over', () => {
    expect(() => rereadCutoff('2026-02-31', now)).toThrow(/no such date/);
    expect(() => rereadCutoff('2026-11-03T25:00', now)).toThrow(/no such date/);
  });

  test('anything else is refused', () => {
    for (const raw of [
      '',
      'yesterday',
      '16/11/2026',
      '2026-11-16T',
      "2026-11-16'; --",
    ]) {
      expect(() => rereadCutoff(raw, now)).toThrow(/use YYYY-MM-DD/);
    }
  });
});
