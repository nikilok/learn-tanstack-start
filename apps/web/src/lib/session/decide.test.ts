import { describe, expect, test } from 'bun:test';

import { decide, documentMode } from './decide';
import { parseRanges } from './ranges';
import { issueSession } from './token';

const secret = 'test-secret-not-a-real-one';
const ranges = parseRanges(['66.249.64.0/27']);
const visitor = '81.2.69.160';

function request(ip: string | null, cookie?: string): Headers {
  const headers = new Headers();
  if (ip) headers.set('x-real-ip', ip);
  if (cookie) headers.set('cookie', `ss-session=${cookie}`);
  return headers;
}

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

describe('decide', () => {
  test('a crawler address gets the full document, with or without a session', async () => {
    expect(
      await decide({ headers: request('66.249.64.10'), ranges, secret }),
    ).toEqual({ render: 'server', why: 'crawler' });
  });

  test('a session held for this address gets the full document', async () => {
    expect(
      await decide({
        headers: request(visitor, await session('person')),
        ranges,
        secret,
      }),
    ).toEqual({ render: 'server', why: 'session' });
  });

  test('no session, or one from another address, gets the shell', async () => {
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

  test('an unverified session gets the shell', async () => {
    expect(
      await decide({
        headers: request(visitor, await session('unverified')),
        ranges,
        secret,
      }),
    ).toEqual({ render: 'client', why: 'unverified' });
  });

  test('whatever it cannot place gets the full document', async () => {
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
