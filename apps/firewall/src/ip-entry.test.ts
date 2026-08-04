import { describe, expect, test } from 'bun:test';

import { isCompleteIp, resolveIpEntry } from './ip-entry';

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
