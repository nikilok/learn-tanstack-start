import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import { connect } from 'node:net';

import {
  connectTarget,
  type GuardProxy,
  publicAddress,
  startGuardProxy,
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
    proxy = await startGuardProxy(async (host) =>
      host === 'qmx.test' ? '127.0.0.1' : null,
    );
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((done) => site.close(() => done()));
  });

  /** A plain request sent through the proxy, as a browser sends one. */
  const viaProxy = (url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const { port } = new URL(proxy.url);
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

  /** The proxy's answer to a CONNECT, and what the tunnel then carries back. */
  const tunnel = (target: string) =>
    new Promise<string>((resolve, reject) => {
      const { port } = new URL(proxy.url);
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
});
