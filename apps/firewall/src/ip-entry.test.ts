import { describe, expect, test } from 'bun:test';

import { isCompleteIp, moveCursor, resolveIpEntry } from './ip-entry';

const MATCHES = ['66.249.66.68', '66.249.66.69', '66.249.66.67'];

describe('isCompleteIp', () => {
  test('a full dotted quad is complete', () => {
    expect(isCompleteIp('31.94.4.48')).toBe(true);
    expect(isCompleteIp('255.255.255.255')).toBe(true);
  });

  test('a fragment being typed to filter is not', () => {
    expect(isCompleteIp('66')).toBe(false);
    expect(isCompleteIp('66.249')).toBe(false);
    expect(isCompleteIp('66.249.66')).toBe(false);
    expect(isCompleteIp('')).toBe(false);
  });

  test('an out-of-range octet is not an address', () => {
    expect(isCompleteIp('999.1.1.1')).toBe(false);
  });

  test('IPv6 is recognised by its colons', () => {
    expect(isCompleteIp('2a01:4f8::1')).toBe(true);
  });
});

describe('resolveIpEntry', () => {
  test('a highlighted suggestion always wins', () => {
    expect(resolveIpEntry('', 1, MATCHES)).toBe('66.249.66.69');
    expect(resolveIpEntry('66.249.66.68', 2, MATCHES)).toBe('66.249.66.67');
  });

  test('a cursor past the end of the list falls back rather than yielding undefined', () => {
    // The list reflows as the filter narrows, so the cursor can outlive the row it pointed at.
    expect(resolveIpEntry('66.249.66.68', MATCHES.length, MATCHES)).toBe(
      '66.249.66.68',
    );
    expect(resolveIpEntry('66', MATCHES.length + 5, MATCHES)).toBe(MATCHES[0]);
    expect(resolveIpEntry('', 99, [])).toBe('');
  });

  test('typing a fragment then Enter resolves to the top match — that is what searching means', () => {
    expect(resolveIpEntry('66', -1, MATCHES)).toBe('66.249.66.68');
  });

  test('a complete address is taken literally even when it prefixes a busier one', () => {
    // Regression: '31.94.4.4' must not be swapped for a listed '31.94.4.48'.
    expect(resolveIpEntry('31.94.4.4', -1, ['31.94.4.48'])).toBe('31.94.4.4');
  });

  test('a complete address absent from the list still profiles', () => {
    expect(resolveIpEntry('8.8.8.8', -1, MATCHES)).toBe('8.8.8.8');
  });

  test('a fragment with no matches falls back to the typed text, so the error names it', () => {
    expect(resolveIpEntry('zz', -1, [])).toBe('zz');
  });

  test('an empty field with no matches yields empty, which submitIp rejects', () => {
    expect(resolveIpEntry('', -1, [])).toBe('');
  });

  test('surrounding whitespace never reaches the query', () => {
    expect(resolveIpEntry('  8.8.8.8  ', -1, [])).toBe('8.8.8.8');
  });
});

// The list is long enough now that the far end matters: reaching the quietest row should not mean
// holding an arrow through everything above it.
describe('moveCursor', () => {
  const down = (c: number, n = 3) => moveCursor(c, 1, n);
  const up = (c: number, n = 3) => moveCursor(c, -1, n);

  test('walks the rows in order', () => {
    expect(down(0)).toBe(1);
    expect(down(1)).toBe(2);
    expect(up(2)).toBe(1);
  });

  test('down past the last row reaches the input, then wraps to the top', () => {
    expect(down(2)).toBe(-1);
    expect(down(-1)).toBe(0);
  });

  test('up from the top reaches the input, then wraps to the bottom', () => {
    expect(up(0)).toBe(-1);
    expect(up(-1)).toBe(2);
  });

  test('the whole ring returns to where it started', () => {
    let c = -1;
    for (let i = 0; i < 4; i++) c = moveCursor(c, 1, 3);
    expect(c).toBe(-1);
    for (let i = 0; i < 4; i++) c = moveCursor(c, -1, 3);
    expect(c).toBe(-1);
  });

  test('a single row still cycles against the input', () => {
    expect(moveCursor(-1, 1, 1)).toBe(0);
    expect(moveCursor(0, 1, 1)).toBe(-1);
    expect(moveCursor(0, -1, 1)).toBe(-1);
  });

  test('an empty list has nowhere to go but the typed value', () => {
    // Not 0: highlighting row zero of nothing would make Enter submit an entry that is not there.
    expect(moveCursor(-1, 1, 0)).toBe(-1);
    expect(moveCursor(-1, -1, 0)).toBe(-1);
  });

  test('a cursor stranded past the end by a shrinking filter comes back in range', () => {
    expect(moveCursor(15, 1, 3)).toBe(0);
    expect(moveCursor(15, 1, 3)).toBeLessThan(3);
  });
});
