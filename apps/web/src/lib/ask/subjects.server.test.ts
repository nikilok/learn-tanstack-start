import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import { DEVICE_KEY_RE } from '../device/key';
import { deviceKey } from '../device/rpc-input';
import { deployment, networkKey, siteKey } from './subjects.server';

const SECRET = 'test-secret';
const ENV = {
  NODE_ENV: 'production',
  VERCEL_ENV: 'production',
  ENGAGE_TOKEN_SECRET: SECRET,
};
const ADDRESS = '192.0.2.10';
const OTHER = '192.0.2.77';
const NET_KEY_RE = /^net:[0-9a-f]{32}$/;

/** Headers naming one client address, as the platform sets it. */
function at(address: string): Headers {
  return new Headers({ 'x-real-ip': address });
}

describe('deployment', () => {
  test('is the platform’s name for the deployment', () => {
    expect(deployment({ VERCEL_ENV: 'production' })).toBe('production');
    expect(deployment({ VERCEL_ENV: 'preview' })).toBe('preview');
  });

  test('a run the platform does not name is local, and so is an empty name', () => {
    expect(deployment({})).toBe('local');
    expect(deployment({ VERCEL_ENV: '' })).toBe('local');
  });
});

describe('siteKey', () => {
  test('is all: and the deployment', () => {
    expect(siteKey({ VERCEL_ENV: 'production' })).toBe('all:production');
    expect(siteKey({})).toBe('all:local');
  });

  test('each deployment keeps its own site total', () => {
    const keys = [
      { VERCEL_ENV: 'production' },
      { VERCEL_ENV: 'preview' },
      {},
    ].map(siteKey);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('networkKey', () => {
  test('is net: and 32 lowercase hex', () => {
    expect(networkKey(at(ADDRESS), ENV)).toMatch(NET_KEY_RE);
    expect(networkKey(at('2001:db8:1:2::1'), ENV)).toMatch(NET_KEY_RE);
  });

  test('is the first 32 hex of the hash keyed with the secret over the deployment and the address’s scope', () => {
    const hash = createHmac('sha256', SECRET)
      .update(`ask-usage|production|${ADDRESS}`)
      .digest('hex');
    expect(networkKey(at(ADDRESS), ENV)).toBe(`net:${hash.slice(0, 32)}`);
  });

  test('the same address, secret and deployment give the same key', () => {
    expect(networkKey(at(ADDRESS), ENV)).toBe(networkKey(at(ADDRESS), ENV));
  });

  test('a different address, secret or deployment gives a different key', () => {
    const key = networkKey(at(ADDRESS), ENV);
    expect(networkKey(at(OTHER), ENV)).not.toBe(key);
    expect(
      networkKey(at(ADDRESS), { ...ENV, ENGAGE_TOKEN_SECRET: 'other-secret' }),
    ).not.toBe(key);
    expect(networkKey(at(ADDRESS), { ...ENV, VERCEL_ENV: 'preview' })).not.toBe(
      key,
    );
    expect(networkKey(at(ADDRESS), { ...ENV, VERCEL_ENV: undefined })).not.toBe(
      key,
    );
  });

  test('a development run with an address counts it as any run does', () => {
    expect(networkKey(at(ADDRESS), { ...ENV, NODE_ENV: 'development' })).toBe(
      networkKey(at(ADDRESS), ENV),
    );
  });

  test('the platform’s x-real-ip is read before x-forwarded-for', () => {
    const both = new Headers({
      'x-real-ip': ADDRESS,
      'x-forwarded-for': OTHER,
    });
    expect(networkKey(both, ENV)).toBe(networkKey(at(ADDRESS), ENV));
    expect(networkKey(both, ENV)).not.toBe(networkKey(at(OTHER), ENV));
  });

  test('without x-real-ip, the first address of x-forwarded-for is the one counted', () => {
    const forwarded = new Headers({
      'x-forwarded-for': `${ADDRESS}, ${OTHER}`,
    });
    expect(networkKey(forwarded, ENV)).toBe(networkKey(at(ADDRESS), ENV));
  });

  test('two IPv6 addresses in one /64 share a network, and one in another /64 does not', () => {
    const one = networkKey(at('2001:db8:1:2::1'), ENV);
    expect(networkKey(at('2001:db8:1:2:ffff:ee:dd:9'), ENV)).toBe(one);
    expect(networkKey(at('2001:db8:1:3::1'), ENV)).not.toBe(one);
  });

  test('with no secret there is no key', () => {
    expect(
      networkKey(at(ADDRESS), { ...ENV, ENGAGE_TOKEN_SECRET: undefined }),
    ).toBeNull();
    expect(
      networkKey(at(ADDRESS), { ...ENV, ENGAGE_TOKEN_SECRET: '' }),
    ).toBeNull();
  });

  test('with no usable address there is no key outside development', () => {
    for (const NODE_ENV of ['production', 'test', undefined])
      for (const headers of [
        new Headers(),
        at('unknown'),
        new Headers({ 'x-forwarded-for': 'not-an-address' }),
      ])
        expect(networkKey(headers, { ...ENV, NODE_ENV })).toBeNull();
  });

  test('a development run with no usable address counts as one network, under a key of its own', () => {
    const env = { ...ENV, NODE_ENV: 'development' };
    const key = networkKey(new Headers(), env);
    expect(key).toMatch(NET_KEY_RE);
    expect(networkKey(at('unknown'), env)).toBe(key);
    expect(networkKey(new Headers(), env)).toBe(key);
    expect(networkKey(at(ADDRESS), env)).not.toBe(key);
  });

  test('the key never carries the address', () => {
    for (const address of [ADDRESS, '2001:db8:1:2::1'])
      expect(networkKey(at(address), ENV)).not.toContain(address);
  });
});

describe('the keys of a network and of the site', () => {
  test('are never device keys in form, so no device key read from a payload is one', () => {
    const keys = [
      siteKey({ VERCEL_ENV: 'production' }),
      siteKey({}),
      networkKey(at(ADDRESS), ENV),
      networkKey(at('2001:db8:1:2::1'), ENV),
      networkKey(new Headers(), { ...ENV, NODE_ENV: 'development' }),
    ];
    for (const key of keys) {
      if (key === null) throw new Error('no key');
      expect(DEVICE_KEY_RE.test(key)).toBe(false);
      expect(() => deviceKey({ key })).toThrow('Invalid input');
    }
  });
});
