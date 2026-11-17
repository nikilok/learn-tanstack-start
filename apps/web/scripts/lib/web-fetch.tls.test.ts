/**
 * The fetcher against real TLS, on loopback: a request sent to an address is
 * still asked for under the name of its host, and its certificate is still
 * checked against that name. The certificates are made here with openssl and
 * thrown away.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearRobotsCache,
  configureFetch,
  fetchPage,
  forgetAnsweredAddresses,
} from './web-fetch.ts';

// A documentation address, standing for the one address every site here is at.
const ADDRESS = '192.0.2.7';
// Where the stand-ins listen: an address the fetcher itself will not ask.
const LOOPBACK = '127.0.0.1';

type Pair = { key: string; cert: string };
type StandIn = ReturnType<typeof Bun.serve>;

const dir = mkdtempSync(join(tmpdir(), 'web-fetch-tls-'));

/** A self-signed certificate for one name or address, made with openssl. */
function certificateFor(file: string, subjectAltName: string): Pair {
  const base = join(dir, file);
  writeFileSync(
    `${base}.cnf`,
    [
      '[req]',
      'distinguished_name=dn',
      'x509_extensions=v3',
      'prompt=no',
      '[dn]',
      `CN=${file}`,
      '[v3]',
      `subjectAltName=${subjectAltName}`,
      '',
    ].join('\n'),
  );
  const made = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-keyout',
    `${base}.key`,
    '-out',
    `${base}.crt`,
    '-config',
    `${base}.cnf`,
  ]);
  if (made.exitCode !== 0) {
    throw new Error(
      `these tests make their certificates with openssl: ${made.stderr.toString()}`,
    );
  }
  return {
    key: readFileSync(`${base}.key`, 'utf8'),
    cert: readFileSync(`${base}.crt`, 'utf8'),
  };
}

/** What a stand-in saw of a request: the Host header, and the port it came from. */
type Seen = { host: string | null; from: number | null };

/** A stand-in that answers every page with what it saw of the request, and has no robots.txt. */
function standIn(tls?: Pair | (Pair & { serverName: string })[]): StandIn {
  return Bun.serve({
    port: 0,
    hostname: LOOPBACK,
    tls,
    fetch(request, server) {
      if (new URL(request.url).pathname === '/robots.txt') {
        return new Response('', { status: 404 });
      }
      const seen: Seen = {
        host: request.headers.get('host'),
        from: server.requestIP(request)?.port ?? null,
      };
      return new Response(JSON.stringify(seen), {
        headers: { 'content-type': 'text/plain' },
      });
    },
  });
}

/** What the stand-in saw of the request a fetched page came from. */
function seenBy(fetched: Awaited<ReturnType<typeof fetchPage>>): Seen {
  if (!fetched.ok) throw new Error(`not read: ${fetched.reason}`);
  return JSON.parse(fetched.html) as Seen;
}

let sites: StandIn;
let anotherName: StandIn;
let addressOnly: StandIn;
let plain: StandIn;
let restore: (() => void) | undefined;

beforeAll(() => {
  const site = certificateFor('site', 'DNS:site.example');
  const second = certificateFor('second', 'DNS:second.example');
  const other = certificateFor('other', 'DNS:other.example');
  const address = certificateFor('address', `IP:${LOOPBACK}`);
  // One address, two sites: the certificate presented is the one for the name asked for.
  sites = standIn([
    { serverName: 'site.example', ...site },
    { serverName: 'second.example', ...second },
  ]);
  anotherName = standIn(other);
  addressOnly = standIn(address);
  plain = standIn();
  // Every certificate here is trusted, so a failure is about the name alone.
  const ca = [site.cert, second.cert, other.cert, address.cert];
  restore = configureFetch({
    lookup: async () => [{ address: ADDRESS }],
    // The request as the fetcher sends it, to where the stand-ins are, trusting their certificates.
    fetch: (url, init) =>
      fetch(url.replace(ADDRESS, LOOPBACK), {
        ...init,
        ...(init.tls && { tls: { ...init.tls, ca } }),
      }),
    gate: null,
  });
});

afterEach(() => {
  clearRobotsCache();
  forgetAnsweredAddresses();
});

afterAll(async () => {
  restore?.();
  await Promise.all(
    [sites, anotherName, addressOnly, plain].map((server) =>
      server?.stop(true),
    ),
  );
  rmSync(dir, { recursive: true, force: true });
});

describe('a request sent to an address, over real TLS', () => {
  test('is asked for under the name of its host, and answered with the certificate for that name', async () => {
    // The second of the two sites: read only if its own name was asked for.
    const fetched = await fetchPage(
      `https://second.example:${sites.port}/team`,
    );
    expect(fetched).toMatchObject({
      ok: true,
      url: `https://second.example:${sites.port}/team`,
    });
    expect(seenBy(fetched).host).toBe(`second.example:${sites.port}`);
  });

  test('fails on a certificate for another name', async () => {
    expect(
      await fetchPage(`https://site.example:${anotherName.port}/`),
    ).toEqual({ ok: false, reason: 'tls' });
  });

  test('fails on a certificate for the address it was sent to: the name is what is checked', async () => {
    expect(
      await fetchPage(`https://site.example:${addressOnly.port}/`),
    ).toEqual({ ok: false, reason: 'tls' });
  });

  test('is never let in on the connection of another site at the same address', async () => {
    const first = await fetchPage(`https://site.example:${sites.port}/`);
    expect(first.ok).toBe(true);
    // A name the stand-in has no certificate for: it presents another site's.
    expect(await fetchPage(`https://nocert.example:${sites.port}/`)).toEqual({
      ok: false,
      reason: 'tls',
    });
    const other = await fetchPage(`https://second.example:${sites.port}/`);
    expect(seenBy(other).from).not.toBe(seenBy(first).from);
  });

  test('keeps the connection of its own site for the next request to it', async () => {
    const first = await fetchPage(`https://site.example:${sites.port}/team`);
    const next = await fetchPage(`https://site.example:${sites.port}/about`);
    expect(seenBy(next).from).toBe(seenBy(first).from);
  });
});

describe('a request sent to an address, over plain HTTP', () => {
  test('is asked for under the name of its host', async () => {
    const fetched = await fetchPage(`http://site.example:${plain.port}/team`);
    expect(seenBy(fetched).host).toBe(`site.example:${plain.port}`);
  });
});
