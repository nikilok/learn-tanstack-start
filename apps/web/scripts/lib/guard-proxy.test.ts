import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import { connect } from 'node:net';

import {
  connectTarget,
  type GuardProxy,
  publicAddress,
  startGuardProxy,
  WEB_PORTS,
} from './guard-proxy.ts';

describe('connectTarget', () => {
  test('reads a host and port, an IPv6 literal in brackets', () => {
    expect(connectTarget('qmx.co.uk:443')).toEqual({
      host: 'qmx.co.uk',
      port: 443,
    });
    expect(connectTarget('[2001:db8::1]:443')).toEqual({
      host: '2001:db8::1',
      port: 443,
    });
  });

  test('refuses a target without a port, or with one out of range', () => {
    expect(connectTarget('qmx.co.uk')).toBeNull();
    expect(connectTarget('qmx.co.uk:0')).toBeNull();
    expect(connectTarget('qmx.co.uk:70000')).toBeNull();
    expect(connectTarget('2001:db8::1:443')).toBeNull();
  });
});

describe('publicAddress', () => {
  test('a loopback, private or link-local address is never one', async () => {
    expect(await publicAddress('127.0.0.1')).toBeNull();
    expect(await publicAddress('10.0.0.8')).toBeNull();
    expect(await publicAddress('169.254.169.254')).toBeNull();
    expect(await publicAddress('localhost')).toBeNull();
  });
});

describe('startGuardProxy', () => {
  // Loopback only: the site and the proxy both listen on 127.0.0.1, and the
  // test resolver lets one made-up host reach the site.
  const resolve = async (host: string) =>
    host === 'qmx.test' ? '127.0.0.1' : null;
  let proxy: GuardProxy;
  let site: ReturnType<typeof createServer>;
  let sitePort = 0;
  const seen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    site = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`page ${req.url}`);
    });
    await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
    const address = site.address();
    sitePort = typeof address === 'object' && address ? address.port : 0;
    proxy = await startGuardProxy({
      resolve,
      ports: new Set([sitePort]),
    });
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((done) => site.close(() => done()));
  });

  /** A plain request sent through a proxy, as a browser sends one. */
  const viaProxy = (url: string, through: GuardProxy = proxy) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const { port } = new URL(through.url);
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(port),
          path: url,
          headers: { 'proxy-connection': 'keep-alive' },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  /** A proxy's answer to a CONNECT, and what the tunnel then carries back. */
  const tunnel = (target: string, through: GuardProxy = proxy) =>
    new Promise<string>((resolve, reject) => {
      const { port } = new URL(through.url);
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      });
      let received = '';
      let asked = false;
      socket.on('data', (chunk) => {
        received += chunk;
        if (!asked && received.startsWith('HTTP/1.1 200')) {
          asked = true;
          socket.write(
            'GET /tunnelled HTTP/1.1\r\nHost: qmx.test\r\nConnection: close\r\n\r\n',
          );
        }
      });
      socket.on('close', () => resolve(received));
      socket.on('error', reject);
    });

  test('a plain request reaches a host that resolves publicly, named as itself', async () => {
    const answer = await viaProxy(`http://qmx.test:${sitePort}/about?x=1`);
    expect(answer).toEqual({ status: 200, body: 'page /about?x=1' });
    expect(seen.at(-1)?.host).toBe(`qmx.test:${sitePort}`);
    expect(seen.at(-1)?.['proxy-connection']).toBeUndefined();
  });

  test('a plain request to a host that does not is refused', async () => {
    expect((await viaProxy('http://127.0.0.1/')).status).toBe(403);
    expect((await viaProxy(`https://qmx.test:${sitePort}/`)).status).toBe(403);
    expect((await viaProxy(`http://elsewhere.test:${sitePort}/`)).status).toBe(
      403,
    );
  });

  test('a tunnel opens to a host that resolves publicly, and to no other', async () => {
    const open = await tunnel(`qmx.test:${sitePort}`);
    expect(open).toStartWith('HTTP/1.1 200 Connection Established');
    expect(open).toContain('page /tunnelled');
    expect(await tunnel(`127.0.0.1:${sitePort}`)).toStartWith('HTTP/1.1 403');
    expect(await tunnel('qmx.test')).toStartWith('HTTP/1.1 403');
  });

  test('only the web ports are reachable', () => {
    expect([...WEB_PORTS]).toEqual([80, 443, 8080, 8443]);
  });

  test('a port that is not a web one is refused on either path, before any connection', async () => {
    const webOnly = await startGuardProxy({ resolve });
    try {
      expect(
        (await viaProxy(`http://qmx.test:${sitePort}/`, webOnly)).status,
      ).toBe(403);
      expect(await tunnel(`qmx.test:${sitePort}`, webOnly)).toStartWith(
        'HTTP/1.1 403',
      );
    } finally {
      await webOnly.close();
    }
  });
});
