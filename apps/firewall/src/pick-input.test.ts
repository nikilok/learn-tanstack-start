// The identity picker's input path. Two kinds share one field, and every rule here differs
// between them — which is exactly where a shared field goes wrong.

import { describe, expect, test } from 'bun:test';

import {
  busiestCap,
  filterIdentities,
  normalizeIdentity,
  resolveSubject,
  subjectsToOpen,
  typeIdentity,
} from './pick-input';

const DIGEST = 't13d1516h2_8daaf6152771_b0da82dd1658';

describe('normalizeIdentity', () => {
  test('a JA4 is lower-cased — dashboards render hashes upper-case', () => {
    expect(normalizeIdentity('ja4', DIGEST.toUpperCase())).toBe(DIGEST);
  });

  test('an IP is kept as written', () => {
    expect(normalizeIdentity('ip', '1.2.3.4')).toBe('1.2.3.4');
  });

  test('surrounding whitespace is dropped for both', () => {
    expect(normalizeIdentity('ip', '  1.2.3.4 ')).toBe('1.2.3.4');
    expect(normalizeIdentity('ja4', ` ${DIGEST} `)).toBe(DIGEST);
  });
});

describe('resolveSubject', () => {
  test('an IPv4 resolves', () => {
    expect(resolveSubject('ip', '1.2.3.4')).toEqual({
      subject: { kind: 'ip', value: '1.2.3.4' },
    });
  });

  test('an IPv6 resolves', () => {
    const out = resolveSubject('ip', '2a02:c7f:1234::1');
    expect('subject' in out).toBe(true);
  });

  test('a JA4 resolves lower-cased, whatever case it was pasted in', () => {
    expect(resolveSubject('ja4', DIGEST.toUpperCase())).toEqual({
      subject: { kind: 'ja4', value: DIGEST },
    });
  });

  test('a blank field is refused rather than opening an empty tab', () => {
    expect(resolveSubject('ip', '   ')).toEqual({ error: 'not an IP address' });
  });

  // A JA4 contains letters and underscores an IP never can, so the two must not share a check.
  test('a JA4 typed into the IP field is refused', () => {
    expect(resolveSubject('ip', DIGEST)).toEqual({
      error: 'not an IP address',
    });
  });

  test('an IP typed into the JA4 field is refused', () => {
    expect(resolveSubject('ja4', '1.2.3.4')).toEqual({
      error: 'not a JA4 digest',
    });
  });

  test('a truncated digest is refused rather than queried as a handle that matches nothing', () => {
    expect(resolveSubject('ja4', 't13d1516h2')).toEqual({
      error: 'not a JA4 digest',
    });
  });
});

describe('typeIdentity', () => {
  test('accepts the characters an address is made of', () => {
    expect(typeIdentity('ip', '', '1.2.3.4')).toBe('1.2.3.4');
    expect(typeIdentity('ip', '2a02:', 'c7f::1')).toBe('2a02:c7f::1');
  });

  // Requiring the whole chunk to match meant pasting an IP silently did nothing.
  test('a paste is filtered within the chunk, not rejected whole', () => {
    expect(typeIdentity('ip', '', 'ip 1.2.3.4')).toBe('1.2.3.4');
  });

  test('the JA4 field accepts letters and underscores the IP field must not', () => {
    expect(typeIdentity('ja4', '', DIGEST)).toBe(DIGEST);
    expect(typeIdentity('ip', '', DIGEST)).not.toBe(DIGEST);
  });

  test('the field is bounded at the longest address that exists', () => {
    expect(typeIdentity('ip', '', '1'.repeat(80)).length).toBe(45);
  });

  test('a newline does not survive into either field', () => {
    expect(typeIdentity('ip', '', '1.2.3.4\n')).toBe('1.2.3.4');
    expect(typeIdentity('ja4', '', `${DIGEST}\n`)).toBe(DIGEST);
  });
});

describe('filterIdentities', () => {
  const rows: [string, number][] = [
    ['1.2.3.4', 900],
    ['5.6.7.8', 500],
    ['10.0.3.44', 100],
  ];

  test('a blank query keeps everything, in rank order', () => {
    expect(filterIdentities(rows, '')).toEqual(rows);
  });

  // An IP is often recognised by its tail as much as its network part.
  test('matches on a substring, not just a prefix', () => {
    expect(filterIdentities(rows, '3.4').map(([id]) => id)).toEqual([
      '1.2.3.4',
      '10.0.3.44',
    ]);
  });

  test('no match yields nothing rather than the unfiltered list', () => {
    expect(filterIdentities(rows, '99')).toEqual([]);
  });

  test('the ranking survives filtering', () => {
    expect(filterIdentities(rows, '.').map(([, n]) => n)).toEqual([
      900, 500, 100,
    ]);
  });
});

describe('busiestCap', () => {
  test('a tall pane allows the maximum', () => {
    expect(busiestCap(40, 10, 10, 20)).toBe(20);
  });

  test('a short pane is still allowed the minimum, not zero rows', () => {
    // reportH bottoms out at 8, and a picker showing nothing is worse than one that overflows.
    expect(busiestCap(8, 10, 10, 20)).toBe(10);
  });

  test('the cap is never exceeded however tall the pane', () => {
    expect(busiestCap(500, 10, 10, 20)).toBe(20);
  });

  test('a mid-height pane gets the room it actually has', () => {
    expect(busiestCap(25, 10, 10, 20)).toBe(15);
  });
});

describe('subjectsToOpen', () => {
  const rows: [string, number][] = Array.from({ length: 12 }, (_, i) => [
    `1.2.3.${i}`,
    100 - i,
  ]);

  // Each subject costs a profile's worth of queries, so one keypress must stay bounded.
  test('opens at most the cap, however long the list', () => {
    expect(subjectsToOpen(rows, 'ip', 8)).toHaveLength(8);
  });

  test('takes the busiest first, matching what is on screen', () => {
    expect(subjectsToOpen(rows, 'ip', 3).map((s) => s.value)).toEqual([
      '1.2.3.0',
      '1.2.3.1',
      '1.2.3.2',
    ]);
  });

  test('a short list opens all of it', () => {
    expect(subjectsToOpen(rows.slice(0, 2), 'ip', 8)).toHaveLength(2);
  });

  test('an empty list opens nothing, so the keypress is a no-op', () => {
    expect(subjectsToOpen([], 'ip', 8)).toEqual([]);
  });

  test('JA4 subjects are normalized, so a tab is never opened on an unqueryable handle', () => {
    const out = subjectsToOpen([[DIGEST.toUpperCase(), 10]], 'ja4', 8);
    expect(out[0]).toEqual({ kind: 'ja4', value: DIGEST });
  });
});
