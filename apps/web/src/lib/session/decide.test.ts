import { describe, expect, test } from 'bun:test';

import { decide, decideDocument, documentMode } from './decide';
import { parseRanges } from './ranges';
import { issueSession } from './token';

const secret = 'test-secret-not-a-real-one';
const ranges = parseRanges(['66.249.64.0/27']);
const visitor = '81.2.69.160';

/** A request's headers from `ip`, holding the session `cookie` if one is given. */
function request(ip: string | null, cookie?: string): Headers {
  const headers = new Headers();
  if (ip) headers.set('x-real-ip', ip);
  if (cookie) headers.set('cookie', `ss-session=${cookie}`);
  return headers;
}

/** A valid session value of the given standing for `scope`. */
async function session(standing: 'person' | 'unverified', scope = visitor) {
  return (await issueSession({ scope, standing, secret })).value;
}

describe('documentMode', () => {
  test('only the two named modes turn it on', () => {
    expect(documentMode('observe')).toBe('observe');
    expect(documentMode('enforce')).toBe('enforce');
    for (const off of [undefined, '', 'on', '1', 'ENFORCE'])
      expect(documentMode(off)).toBeNull();
  });
});

describe('decideDocument', () => {
  test('a crawler address gets the full document', () => {
    expect(
      decideDocument({
        headers: request('66.249.64.10'),
        ranges,
        owner: false,
      }),
    ).toEqual({ render: 'server', why: 'crawler' });
  });

  test('the owner gets the full document, from any address', () => {
    for (const ip of [visitor, null])
      expect(
        decideDocument({ headers: request(ip), ranges, owner: true }),
      ).toEqual({ render: 'server', why: 'owner' });
  });

  test('anyone else gets the shell, a session held for their address included', async () => {
    expect(
      decideDocument({ headers: request(visitor), ranges, owner: false }),
    ).toEqual({ render: 'client', why: 'visitor' });
    expect(
      decideDocument({
        headers: request(visitor, await session('person')),
        ranges,
        owner: false,
      }),
    ).toEqual({ render: 'client', why: 'visitor' });
  });

  test('whatever it cannot place gets the full document', () => {
    expect(
      decideDocument({ headers: request(visitor), ranges: null, owner: false }),
    ).toEqual({ render: 'server', why: 'no crawler ranges' });
    expect(
      decideDocument({ headers: request(null), ranges, owner: false }),
    ).toEqual({ render: 'server', why: 'no address' });
  });
});

describe('decide', () => {
  test("the owner's data call goes through without a session", async () => {
    expect(
      await decide({ headers: request(visitor), ranges, secret, owner: true }),
    ).toEqual({ render: 'server', why: 'owner' });
  });

  test("a crawler address's call goes through, with or without a session", async () => {
    expect(
      await decide({ headers: request('66.249.64.10'), ranges, secret }),
    ).toEqual({ render: 'server', why: 'crawler' });
  });

  test('a session held for this address lets the call through', async () => {
    expect(
      await decide({
        headers: request(visitor, await session('person')),
        ranges,
        secret,
      }),
    ).toEqual({ render: 'server', why: 'session' });
  });

  test('a call with no session, or one from another address, is refused', async () => {
    expect(await decide({ headers: request(visitor), ranges, secret })).toEqual(
      {
        render: 'client',
        why: 'no session',
      },
    );
    expect(
      await decide({
        headers: request(visitor, await session('person', '81.2.69.161')),
        ranges,
        secret,
      }),
    ).toEqual({ render: 'client', why: 'elsewhere' });
  });

  test('a call with an unverified session is refused', async () => {
    expect(
      await decide({
        headers: request(visitor, await session('unverified')),
        ranges,
        secret,
      }),
    ).toEqual({ render: 'client', why: 'unverified' });
  });

  test('a session issued to a device suspended since is refused; another device, or none, goes through', async () => {
    const device = 'a'.repeat(32);
    const suspended = new Set([device]);
    const issued = async (named: string | null) =>
      (
        await issueSession({
          scope: visitor,
          standing: 'person',
          secret,
          device: named,
        })
      ).value;
    expect(
      await decide({
        headers: request(visitor, await issued(device)),
        ranges,
        secret,
        suspended,
      }),
    ).toEqual({ render: 'client', why: 'suspended' });
    for (const named of ['b'.repeat(32), null])
      expect(
        await decide({
          headers: request(visitor, await issued(named)),
          ranges,
          secret,
          suspended,
        }),
      ).toEqual({ render: 'server', why: 'session' });
    // With no list read, nobody is suspended.
    expect(
      await decide({
        headers: request(visitor, await issued(device)),
        ranges,
        secret,
      }),
    ).toEqual({ render: 'server', why: 'session' });
  });

  test('a call it cannot place goes through', async () => {
    expect(
      await decide({ headers: request(visitor), ranges: null, secret }),
    ).toEqual({ render: 'server', why: 'no crawler ranges' });
    expect(await decide({ headers: request(null), ranges, secret })).toEqual({
      render: 'server',
      why: 'no address',
    });
    expect(
      await decide({ headers: request(visitor), ranges, secret: undefined }),
    ).toEqual({ render: 'server', why: 'no secret' });
  });
});
