import { describe, expect, spyOn, test } from 'bun:test';

import { createRangesReader, inRanges, parseRanges } from './ranges';

describe('parseRanges', () => {
  test('reads IPv4 and IPv6 ranges and bare addresses', () => {
    const ranges = parseRanges([
      '66.249.64.0/27',
      '2001:4860:4801:10::/64',
      '157.55.39.1',
    ]);
    expect(ranges?.v4).toHaveLength(2);
    expect(ranges?.v6).toHaveLength(1);
  });

  test('is all or nothing: one bad entry and there is no list', () => {
    expect(parseRanges(['66.249.64.0/27', 'not-a-range'])).toBeNull();
    expect(parseRanges(['66.249.64.0/33'])).toBeNull();
    expect(parseRanges(['2001:db8::/129'])).toBeNull();
    expect(parseRanges(['66.249.64.0/-1'])).toBeNull();
    expect(parseRanges(['66.249.64.0/27', 7])).toBeNull();
  });

  test('an empty list, or none, is no list', () => {
    expect(parseRanges([])).toBeNull();
    expect(parseRanges(undefined)).toBeNull();
    expect(parseRanges({ prefixes: [] })).toBeNull();
  });
});

describe('inRanges', () => {
  const ranges = parseRanges([
    '66.249.64.0/27',
    '40.77.167.0/24',
    '2001:4860:4801:10::/64',
  ]);
  if (!ranges) throw new Error('fixture failed to parse');

  test('holds the addresses inside a range, edges included', () => {
    for (const ip of ['66.249.64.0', '66.249.64.31', '40.77.167.200'])
      expect(inRanges(ranges, ip)).toBe(true);
    expect(inRanges(ranges, '2001:4860:4801:10::abcd')).toBe(true);
  });

  test('and nothing outside them', () => {
    for (const ip of ['66.249.64.32', '66.249.63.255', '49.37.152.56'])
      expect(inRanges(ranges, ip)).toBe(false);
    expect(inRanges(ranges, '2001:4860:4801:11::1')).toBe(false);
    expect(inRanges(ranges, 'garbage')).toBe(false);
  });

  test('a /0 holds everything of its family', () => {
    const all = parseRanges(['0.0.0.0/0']);
    expect(all && inRanges(all, '203.0.113.9')).toBe(true);
    expect(all && inRanges(all, '2001:db8::1')).toBe(false);
  });
});

describe('createRangesReader', () => {
  test('reads at most once a minute', async () => {
    let reads = 0;
    const read = createRangesReader(async () => {
      reads++;
      return ['66.249.64.0/27'];
    });
    await read(0);
    await read(59_999);
    expect(reads).toBe(1);
    await read(60_000);
    expect(reads).toBe(2);
  });

  test('a failed read keeps the last list read whole', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      let fail = false;
      const read = createRangesReader(async () => {
        if (fail) throw new Error('store unreachable');
        return ['66.249.64.0/27'];
      });
      const first = await read(0);
      fail = true;
      expect(await read(120_000)).toBe(first);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test('a failed first read, or a missing list, is no list', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failing = createRangesReader(async () => {
        throw new Error('store unreachable');
      });
      expect(await failing(0)).toBeNull();
      expect(await createRangesReader(async () => undefined)(0)).toBeNull();
    } finally {
      logged.mockRestore();
    }
  });
});
