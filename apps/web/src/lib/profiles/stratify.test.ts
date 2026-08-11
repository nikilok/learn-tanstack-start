import { describe, expect, test } from 'bun:test';

import { allocateQuotas } from './stratify';

const sum = (quotas: Map<string, number>) =>
  [...quotas.values()].reduce((total, n) => total + n, 0);

describe('allocateQuotas', () => {
  test('proportional allocation lands exactly on size', () => {
    const quotas = allocateQuotas(
      new Map([
        ['a', 60],
        ['b', 30],
        ['c', 10],
      ]),
      10,
    );
    expect(sum(quotas)).toBe(10);
    expect(quotas.get('a')).toBe(6);
    expect(quotas.get('b')).toBe(3);
    expect(quotas.get('c')).toBe(1);
  });

  test('more strata than size never produces a negative quota', () => {
    const quotas = allocateQuotas(
      new Map(Array.from({ length: 20 }, (_, i) => [`s${i}`, 5])),
      10,
    );
    expect(sum(quotas)).toBe(10);
    expect([...quotas.values()].every((n) => n >= 0)).toBe(true);
  });

  test('size zero allocates nothing anywhere', () => {
    const quotas = allocateQuotas(
      new Map([
        ['a', 4],
        ['b', 4],
      ]),
      0,
    );
    expect(sum(quotas)).toBe(0);
    expect([...quotas.values()].every((n) => n === 0)).toBe(true);
  });

  test('a single stratum takes the whole size', () => {
    const quotas = allocateQuotas(new Map([['only', 500]]), 12);
    expect(quotas.get('only')).toBe(12);
  });

  test('empty cells allocate an empty map, not a division by zero', () => {
    expect(allocateQuotas(new Map(), 10).size).toBe(0);
  });

  test('a fractional or negative size fails fast instead of spinning', () => {
    expect(() => allocateQuotas(new Map([['a', 3]]), 1.5)).toThrow(
      /non-negative integer/,
    );
    expect(() => allocateQuotas(new Map([['a', 3]]), -1)).toThrow(
      /non-negative integer/,
    );
  });

  test('an empty stratum never receives the floor', () => {
    const quotas = allocateQuotas(
      new Map([
        ['full', 10],
        ['hollow', 0],
      ]),
      5,
    );
    expect(quotas.get('hollow')).toBe(0);
    expect(quotas.get('full')).toBe(5);
  });
});
