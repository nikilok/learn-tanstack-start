import { describe, expect, test } from 'bun:test';

import { addressScope, clientAddress, ipv6Groups, isIPv4 } from './address';

describe('clientAddress', () => {
  test('reads the address the platform set, ahead of the forwarded chain', () => {
    const headers = new Headers({
      'x-real-ip': '81.2.69.160',
      'x-forwarded-for': '10.0.0.1, 81.2.69.160',
    });
    expect(clientAddress(headers)).toBe('81.2.69.160');
  });

  test('falls back to the first forwarded address, and to IPv6', () => {
    expect(
      clientAddress(new Headers({ 'x-forwarded-for': ' 2a00:23c5::1, x' })),
    ).toBe('2a00:23c5::1');
  });

  test('is null with no address, or one that is not an address', () => {
    expect(clientAddress(new Headers())).toBeNull();
    expect(clientAddress(new Headers({ 'x-real-ip': 'unknown' }))).toBeNull();
    expect(clientAddress(new Headers({ 'x-real-ip': '256.1.1.1' }))).toBeNull();
  });
});

describe('addressScope', () => {
  test('binds an IPv4 address whole', () => {
    expect(addressScope('49.37.152.56')).toBe('49.37.152.56');
  });

  test('binds an IPv6 address by its /64, however it is written', () => {
    const scope = '2a00:23c5:e0b1:2701::/64';
    expect(addressScope('2a00:23c5:e0b1:2701:1c4f:9e8a:6b2d:1')).toBe(scope);
    // Another address in the same /64, written compressed: the same scope.
    expect(addressScope('2a00:23c5:e0b1:2701::abcd')).toBe(scope);
    expect(addressScope('2a00:23c5:e0b1:2702::abcd')).not.toBe(scope);
  });

  test('is null for anything else', () => {
    expect(addressScope('not-an-address')).toBeNull();
  });
});

describe('ipv6Groups', () => {
  test('expands the compressed forms, a zone and an IPv4 tail', () => {
    expect(ipv6Groups('::1')).toEqual([
      '0000',
      '0000',
      '0000',
      '0000',
      '0000',
      '0000',
      '0000',
      '0001',
    ]);
    expect(ipv6Groups('fe80::1%en0')?.[0]).toBe('fe80');
    expect(ipv6Groups('::ffff:1.2.3.4')?.slice(6)).toEqual(['0102', '0304']);
  });

  test('refuses what is not an address', () => {
    for (const bad of [
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      '::1:2:3:4:5:6:7:8',
      'g::1',
      '1.2.3.4',
    ])
      expect(ipv6Groups(bad)).toBeNull();
  });
});

test('isIPv4 takes dotted quads only', () => {
  expect(isIPv4('0.0.0.0')).toBe(true);
  expect(isIPv4('255.255.255.255')).toBe(true);
  for (const bad of ['01.2.3.4', '1.2.3', '1.2.3.4.5', '1.2.3.256'])
    expect(isIPv4(bad)).toBe(false);
});
