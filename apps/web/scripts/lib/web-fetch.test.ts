import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DIAL_STAGGER_MS } from './address-binding.ts';
import type { AddressGate, Outcome } from './address-gate.ts';
import { currentTurns } from './address-ledger.ts';
import {
  awaitTurn,
  checkFetchable,
  clearRobotsCache,
  configureFetch,
  fetchPage,
  fetchSite,
  forgetAnsweredAddresses,
  paceByAddress,
  USER_AGENT,
} from './web-fetch.ts';

// Documentation addresses and reserved names: nobody's.
const HOSTS: Record<string, string[]> = {
  'one.example': ['192.0.2.10', '192.0.2.11'],
  'www.one.example': ['192.0.2.10', '192.0.2.11'],
  'two.example': ['2001:db8::20'],
  'inside.example': ['10.0.0.8'],
  // Three more sites behind the first of one.example's addresses.
  'three.example': ['192.0.2.10'],
  'four.example': ['192.0.2.10'],
  'five.example': ['192.0.2.10'],
  // A name with the letters a TLS failure is told by.
  'ssl.example': ['192.0.2.30'],
};

/** What a URL answers with: a reply, or one made from the URL the request was sent to. */
type Reply = Response | Error | ((sentTo: string) => Response | Error);

/** A reply with a body and a status. */
const page = (body: string, status = 200, type = 'text/html') =>
  new Response(body, { status, headers: { 'content-type': type } });

/** A redirect to another URL. */
const moved = (location: string) =>
  new Response(null, { status: 301, headers: { location } });

let restore: (() => void) | undefined;
/** How each request of the newest fixture was sent. */
let sent: BunFetchRequestInit[] = [];
/** The URL each request of the newest fixture was sent to. */
let sentTo: string[] = [];
/** Each address the newest fixture dialled, with its port. */
let dialled: string[] = [];
afterEach(() => {
  restore?.();
  restore = undefined;
  clearRobotsCache();
  forgetAnsweredAddresses();
});

/**
 * The page a request is for: the URL it was sent to, with the Host header it
 * carried in place of the address. A request sent by name, or to an address
 * its host does not resolve to, fails here, whatever the test is about.
 */
function askedFor(
  url: string,
  init: BunFetchRequestInit,
  hosts: Record<string, string[]>,
): string {
  const to = new URL(url);
  const address = to.hostname.replace(/^\[|\]$/g, '');
  if (isIP(address) === 0) throw new Error(`sent by name: ${url}`);
  const { host } = init.headers as Record<string, string | undefined>;
  if (!host) throw new Error(`sent without a Host header: ${url}`);
  const asked = new URL(`${to.protocol}//${host}${to.pathname}${to.search}`);
  if (!hosts[asked.hostname]?.includes(address)) {
    throw new Error(`sent to an address ${asked.hostname} is not at: ${url}`);
  }
  return asked.href;
}

/**
 * The fetcher on a fake network: hosts resolve from HOSTS (or `hosts`), every
 * address accepts a connection unless it is in `refusing` or `unanswering`,
 * each URL answers from `replies` (a 404 otherwise), and everything that
 * happens is recorded in order, a dial only with `dials`. `refuse` makes the
 * gate refuse that many requests, then let the rest through; without `gated`
 * no gate is installed at all.
 */
function network(
  replies: Record<string, Reply>,
  {
    gated = true,
    refuse = 0,
    hosts = HOSTS,
    refusing = [],
    unanswering = [],
    dials = false,
  }: {
    gated?: boolean;
    refuse?: number;
    hosts?: Record<string, string[]>;
    refusing?: string[];
    unanswering?: string[];
    dials?: boolean;
  } = {},
) {
  const events: string[] = [];
  let refusals = refuse;
  const gate: AddressGate = {
    enter: async (addresses) => {
      const refused = refusals > 0;
      if (refused) refusals -= 1;
      events.push(`${refused ? 'refused' : 'turn'} ${addresses.join(',')}`);
      return !refused;
    },
    settle: (host, addresses, port, outcome: Outcome) => {
      events.push(`${outcome} ${host}:${port} at ${addresses.join(',')}`);
    },
    heldRequests: () => 0,
    paused: () => 0,
  };
  // One fixture at a time: the last one's undo puts back what was there before any.
  restore?.();
  sent = [];
  sentTo = [];
  dialled = [];
  restore = configureFetch({
    lookup: async (hostname) => {
      const addresses = hosts[hostname];
      if (!addresses) throw new Error('ENOTFOUND');
      return addresses.map((address) => ({ address }));
    },
    connect: (address, port, signal) => {
      dialled.push(`${address}:${port}`);
      if (dials) events.push(`dial ${address}:${port}`);
      if (refusing.includes(address)) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      if (!unanswering.includes(address)) return Promise.resolve();
      // Open until the request's time limit, or an address that accepted, ends it.
      return new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    },
    fetch: async (url, init) => {
      const asked = askedFor(url, init, hosts);
      events.push(`fetch ${asked}`);
      sent.push(init);
      sentTo.push(url);
      const reply = replies[asked] ?? page('', 404);
      const made = typeof reply === 'function' ? reply(url) : reply;
      if (made instanceof Error) throw made;
      return made;
    },
    gate: gated ? gate : null,
  });
  return events;
}

const ONE = '192.0.2.10,192.0.2.11';
/** Where a request to one.example goes: the first of its addresses, which accepts. */
const ASKED = 'one.example:443 at 192.0.2.10';

describe('fetchPage at the address gate', () => {
  test("robots.txt, then the page, each wait their turn at the host's addresses", async () => {
    const events = network({
      'https://one.example/': page('<p>Hello</p>'),
    });
    expect(await fetchPage('https://one.example/')).toMatchObject({
      ok: true,
      html: '<p>Hello</p>',
    });
    expect(events).toEqual([
      `turn ${ONE}`,
      'fetch https://one.example/robots.txt',
      `answered ${ASKED}`,
      `turn ${ONE}`,
      'fetch https://one.example/',
      `answered ${ASKED}`,
    ]);
    // Sent as ever: under our name, with a time limit, and redirects left for the fetcher to follow by hand.
    expect(sent.map((init) => init.headers)).toEqual([
      { 'user-agent': USER_AGENT, host: 'one.example' },
      {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        host: 'one.example',
      },
    ]);
    expect(sent.map((init) => init.redirect)).toEqual(['manual', 'manual']);
    expect(sent.every((init) => init.signal instanceof AbortSignal)).toBe(true);
  });

  test("a request's time limit starts when its turn comes, not while it waits for one", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    let events = network({ 'https://one.example/': page('<p>Hello</p>') });
    const limit = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      events.push(`limit ${ms}`);
      return real(ms);
    });
    try {
      await fetchPage('https://one.example/');
      expect(events.filter((event) => !event.startsWith('answered'))).toEqual([
        `turn ${ONE}`,
        'limit 8000',
        'fetch https://one.example/robots.txt',
        `turn ${ONE}`,
        'limit 12000',
        'fetch https://one.example/',
      ]);
      // A turn that is refused starts no limit at all.
      events = network({}, { refuse: 1 });
      await fetchPage('https://one.example/');
      expect(events).toEqual([`refused ${ONE}`]);
    } finally {
      limit.mockRestore();
    }
  });

  test("a redirect to another host takes its turn at that host's addresses", async () => {
    const events = network({
      'https://one.example/': moved('https://two.example/home'),
      'https://two.example/home': page('<p>Moved</p>'),
    });
    expect(await fetchPage('https://one.example/')).toMatchObject({
      ok: true,
      url: 'https://two.example/home',
    });
    expect(events.filter((event) => event.startsWith('turn'))).toEqual([
      `turn ${ONE}`,
      `turn ${ONE}`,
      'turn 2001:db8::20',
      'turn 2001:db8::20',
    ]);
  });

  test('what a request came to is reported: any status is an answer, a timeout is silence, anything else neither', async () => {
    const answered = network({
      'https://one.example/robots.txt': page('', 500),
      'https://one.example/': page('', 503),
    });
    expect(await fetchPage('https://one.example/')).toEqual({
      ok: false,
      reason: 'http_error',
      status: 503,
    });
    expect(
      answered.filter((event) => /^[a-z]+ one\.example/.test(event)),
    ).toEqual([`answered ${ASKED}`, `answered ${ASKED}`]);
    clearRobotsCache();

    const silent = network({
      'https://one.example/robots.txt': new Error('The operation timed out.'),
      'https://one.example/': new Error('The operation timed out.'),
    });
    expect(await fetchPage('https://one.example/')).toEqual({
      ok: false,
      reason: 'timeout',
    });
    expect(
      silent.filter((event) => /^[a-z]+ one\.example/.test(event)),
    ).toEqual([`silent ${ASKED}`, `silent ${ASKED}`]);
    clearRobotsCache();

    const neither = network({
      'https://one.example/robots.txt': new Error('ECONNREFUSED'),
      'https://one.example/': new Error('certificate has expired'),
    });
    expect(await fetchPage('https://one.example/')).toEqual({
      ok: false,
      reason: 'tls',
    });
    expect(
      neither.filter((event) => /^[a-z]+ one\.example/.test(event)),
    ).toEqual([`other ${ASKED}`, `other ${ASKED}`]);
  });

  test('a host we may not ask takes no turn', async () => {
    const events = network({});
    expect(await fetchPage('https://inside.example/')).toEqual({
      ok: false,
      reason: 'private_address',
    });
    expect(await fetchPage('https://nowhere.example/')).toEqual({
      ok: false,
      reason: 'dns_or_refused',
    });
    expect(events).toEqual([]);
  });

  test('without a gate, as every caller but a walk runs, nothing waits', async () => {
    const events = network(
      { 'https://one.example/': page('<p>Hello</p>') },
      { gated: false },
    );
    expect((await fetchPage('https://one.example/')).ok).toBe(true);
    expect(events).toEqual([
      'fetch https://one.example/robots.txt',
      'fetch https://one.example/',
    ]);
  });
});

describe('a request is sent to an address its host resolved to', () => {
  test('robots.txt and the page go to that address, under the name of the host', async () => {
    network({ 'https://three.example/team?page=2': page('<p>Team</p>') });
    expect(await fetchPage('https://three.example/team?page=2')).toEqual({
      ok: true,
      url: 'https://three.example/team?page=2',
      status: 200,
      html: '<p>Team</p>',
    });
    expect(sentTo).toEqual([
      'https://192.0.2.10/robots.txt',
      'https://192.0.2.10/team?page=2',
    ]);
    expect(sent.map((init) => init.tls)).toEqual([
      { serverName: 'three.example' },
      { serverName: 'three.example' },
    ]);
    // One address: there is nothing to choose between, so nothing is dialled.
    expect(dialled).toEqual([]);
  });

  test('an IPv6 address is one too', async () => {
    network({ 'https://two.example/': page('<p>Six</p>') });
    expect((await fetchPage('https://two.example/')).ok).toBe(true);
    expect(sentTo).toEqual([
      'https://[2001:db8::20]/robots.txt',
      'https://[2001:db8::20]/',
    ]);
  });

  test('plain HTTP on a port of its own keeps the port, in the URL and in the Host header, and has no TLS name', async () => {
    network({ 'http://three.example:8080/a': page('<p>Plain</p>') });
    expect((await fetchPage('http://three.example:8080/a')).ok).toBe(true);
    expect(sentTo).toEqual([
      'http://192.0.2.10:8080/robots.txt',
      'http://192.0.2.10:8080/a',
    ]);
    expect(
      sent.map((init) => (init.headers as Record<string, string>).host),
    ).toEqual(['three.example:8080', 'three.example:8080']);
    expect(sent.map((init) => 'tls' in init)).toEqual([false, false]);
  });

  test('each hop of a redirect goes to an address of the host that hop names', async () => {
    network({
      'https://three.example/': moved('https://two.example/home'),
      'https://two.example/home': page('<p>Moved</p>'),
    });
    expect(await fetchPage('https://three.example/')).toMatchObject({
      ok: true,
      url: 'https://two.example/home',
    });
    expect(sentTo).toEqual([
      'https://192.0.2.10/robots.txt',
      'https://192.0.2.10/',
      'https://[2001:db8::20]/robots.txt',
      'https://[2001:db8::20]/home',
    ]);
    expect(sent.map((init) => init.tls)).toEqual([
      { serverName: 'three.example' },
      { serverName: 'three.example' },
      { serverName: 'two.example' },
      { serverName: 'two.example' },
    ]);
  });

  test('a failure that names the URL it was sent to is read as one that names the page, as a request by name was', async () => {
    network({
      'https://ssl.example/': (to) =>
        new Error(`SomeFailure fetching "${to}". For more information`),
    });
    // Read from the page's URL, whose host has the letters a TLS failure is told by.
    expect(await fetchPage('https://ssl.example/')).toEqual({
      ok: false,
      reason: 'tls',
    });
    expect(sentTo).toEqual([
      'https://192.0.2.30/robots.txt',
      'https://192.0.2.30/',
    ]);
  });
});

describe('a host on several addresses', () => {
  test('is dialled within the time limit of its request, the next address when one refuses, and asked at the first to accept', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const events = network(
      { 'http://one.example:8080/': page('<p>Hello</p>') },
      { dials: true, refusing: ['192.0.2.10'] },
    );
    const limit = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      events.push(`limit ${ms}`);
      return real(ms);
    });
    try {
      expect((await fetchPage('http://one.example:8080/')).ok).toBe(true);
    } finally {
      limit.mockRestore();
    }
    expect(events.filter((event) => !event.startsWith('answered'))).toEqual([
      `turn ${ONE}`,
      'limit 8000',
      'dial 192.0.2.10:8080',
      'dial 192.0.2.11:8080',
      'fetch http://one.example:8080/robots.txt',
      `turn ${ONE}`,
      'limit 12000',
      'fetch http://one.example:8080/',
    ]);
    expect(sentTo).toEqual([
      'http://192.0.2.11:8080/robots.txt',
      'http://192.0.2.11:8080/',
    ]);
  });

  test('is asked again at the address it last answered at, without another dial', async () => {
    network({ 'https://one.example/': page('<p>Hello</p>') });
    await fetchPage('https://one.example/');
    await fetchPage('https://one.example/about');
    // Its first address accepted, so the second was never dialled.
    expect(dialled).toEqual(['192.0.2.10:443']);
    expect(sentTo).toEqual([
      'https://192.0.2.10/robots.txt',
      'https://192.0.2.10/',
      'https://192.0.2.10/about',
    ]);
  });

  test('is dialled afresh for another origin of the same host', async () => {
    network({});
    await fetchPage('https://one.example/');
    await fetchPage('http://one.example/');
    expect(dialled).toEqual(['192.0.2.10:443', '192.0.2.10:80']);
  });

  test('is dialled again once a request to it has failed', async () => {
    network({
      'https://one.example/': page('<p>Hello</p>'),
      'https://one.example/gone': new Error('ECONNRESET'),
    });
    await fetchPage('https://one.example/');
    expect(dialled).toHaveLength(1);
    expect(await fetchPage('https://one.example/gone')).toEqual({
      ok: false,
      reason: 'dns_or_refused',
    });
    expect(dialled).toHaveLength(1);
    await fetchPage('https://one.example/');
    expect(dialled).toHaveLength(2);
  });

  test('is dialled again when it no longer resolves to the address it answered at', async () => {
    network({});
    await fetchPage('https://one.example/');
    expect(sentTo.at(-1)).toBe('https://192.0.2.10/');
    network({}, { hosts: { 'one.example': ['192.0.2.11', '192.0.2.12'] } });
    await fetchPage('https://one.example/about');
    expect(dialled).toEqual(['192.0.2.11:443']);
    expect(sentTo).toEqual(['https://192.0.2.11/about']);
  });

  test('when none of them accepts a connection, nothing is sent or reported, and it fails as a refused connection does', async () => {
    const events = network(
      { 'https://one.example/': page('<p>Hello</p>') },
      { refusing: ['192.0.2.10', '192.0.2.11'] },
    );
    expect(await fetchPage('https://one.example/')).toEqual({
      ok: false,
      reason: 'dns_or_refused',
    });
    expect(events).toEqual([`turn ${ONE}`, `turn ${ONE}`]);
  });

  test('when none of them accepts within the time limit, it is the silence a timeout is at each one dialled and left unanswered: not at one that refused, nor at one never dialled', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const wide = '192.0.2.10,192.0.2.11,192.0.2.12,192.0.2.13';
    const events = network(
      {},
      {
        hosts: { 'wide.example': wide.split(',') },
        refusing: ['192.0.2.10'],
        unanswering: ['192.0.2.11', '192.0.2.12', '192.0.2.13'],
      },
    );
    // Time to dial the second and, a stagger later, the third; never the fourth.
    const limit = spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      real(DIAL_STAGGER_MS + 100),
    );
    try {
      expect(await fetchPage('https://wide.example/')).toEqual({
        ok: false,
        reason: 'timeout',
      });
    } finally {
      limit.mockRestore();
    }
    expect(dialled).toEqual([
      '192.0.2.10:443',
      '192.0.2.11:443',
      '192.0.2.12:443',
      '192.0.2.10:443',
      '192.0.2.11:443',
      '192.0.2.12:443',
    ]);
    expect(events).toEqual([
      `turn ${wide}`,
      'silent wide.example:443 at 192.0.2.11,192.0.2.12',
      `turn ${wide}`,
      'silent wide.example:443 at 192.0.2.11,192.0.2.12',
    ]);
  });

  test('when the first of them does not accept within the time limit, nothing is sent, and it is the silence a timeout is', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const events = network(
      { 'https://one.example/': page('<p>Hello</p>') },
      { unanswering: ['192.0.2.10', '192.0.2.11'] },
    );
    const limit = spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      real(20),
    );
    try {
      expect(await fetchPage('https://one.example/')).toEqual({
        ok: false,
        reason: 'timeout',
      });
    } finally {
      limit.mockRestore();
    }
    expect(events).toEqual([
      `turn ${ONE}`,
      `silent ${ASKED}`,
      `turn ${ONE}`,
      `silent ${ASKED}`,
    ]);
  });

  test('one that does not answer costs a moment, not the request, while another accepts', async () => {
    network(
      { 'https://one.example/': page('<p>Hello</p>') },
      { unanswering: ['192.0.2.10'] },
    );
    expect((await fetchPage('https://one.example/')).ok).toBe(true);
    expect(dialled).toEqual(['192.0.2.10:443', '192.0.2.11:443']);
    expect(sentTo).toEqual([
      'https://192.0.2.11/robots.txt',
      'https://192.0.2.11/',
    ]);
  });
});

describe('a paused address', () => {
  test('nothing is sent to it, and no host or scheme variant is tried', async () => {
    const events = network(
      { 'https://one.example/': page('<p>Hello</p>') },
      { refuse: Number.POSITIVE_INFINITY },
    );
    expect(await fetchSite('https://one.example', () => {})).toEqual({
      ok: false,
      reason: 'address_paused',
      attempts: 1,
      attemptedUrl: 'https://one.example',
    });
    expect(events).toEqual([`refused ${ONE}`]);
  });

  test('a page whose turn is refused after its robots.txt was read is not sent', async () => {
    network({ 'https://one.example/': page('<p>Hello</p>') });
    await fetchPage('https://one.example/');
    const events = network(
      { 'https://one.example/': page('<p>Hello</p>') },
      { refuse: 1 },
    );
    expect(await fetchPage('https://one.example/')).toEqual({
      ok: false,
      reason: 'address_paused',
    });
    expect(events).toEqual([`refused ${ONE}`]);
  });

  test('a robots.txt it kept us from asking for is not read as no restrictions, nor remembered', async () => {
    const events = network(
      {
        'https://one.example/robots.txt': page(
          'User-agent: *\nDisallow: /private',
          200,
          'text/plain',
        ),
        'https://one.example/private': page('<p>Closed</p>'),
      },
      { refuse: 1 },
    );
    expect(await fetchPage('https://one.example/private')).toEqual({
      ok: false,
      reason: 'address_paused',
    });
    expect(events).toEqual([`refused ${ONE}`]);
    // Asked for now that it may be, and obeyed.
    expect(await fetchPage('https://one.example/private')).toEqual({
      ok: false,
      reason: 'blocked_by_robots',
    });
    expect(events.slice(1)).toEqual([
      `turn ${ONE}`,
      'fetch https://one.example/robots.txt',
      `answered ${ASKED}`,
    ]);
  });
});

describe('a page opened some other way', () => {
  test('awaitTurn takes its turn after the guards; checkFetchable takes none', async () => {
    const events = network({});
    expect(await awaitTurn('https://one.example/about')).toBeNull();
    expect(events.filter((event) => event.startsWith('turn'))).toHaveLength(2);
    expect(await checkFetchable('https://one.example/about')).toBeNull();
    expect(events.filter((event) => event.startsWith('turn'))).toHaveLength(2);
  });

  test('awaitTurn is refused at a paused address, and takes no turn for a page the guards close', async () => {
    network({});
    await awaitTurn('https://one.example/');
    const paused = network({}, { refuse: 1 });
    expect(await awaitTurn('https://one.example/about')).toBe('address_paused');
    expect(paused).toEqual([`refused ${ONE}`]);

    clearRobotsCache();
    const closed = network({
      'https://one.example/robots.txt': page(
        'User-agent: *\nDisallow: /',
        200,
        'text/plain',
      ),
    });
    expect(await awaitTurn('https://one.example/about')).toBe(
      'blocked_by_robots',
    );
    expect(closed.filter((event) => event.startsWith('turn'))).toHaveLength(1);
    expect(await awaitTurn('https://inside.example/')).toBe('private_address');
    expect(await awaitTurn('not a url')).toBe('dns_or_refused');
  });
});

describe('configureFetch', () => {
  test('a test that installs several fixtures leaves none of them behind', async () => {
    const before: string[] = [];
    const undo = configureFetch({
      lookup: async () => [{ address: '192.0.2.10' }],
      fetch: async (url) => {
        before.push(url);
        return page('');
      },
      gate: null,
    });
    try {
      const first = network({});
      const second = network({});
      restore?.();
      restore = undefined;
      await fetchPage('https://one.example/');
      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(before).toHaveLength(2);
    } finally {
      undo();
    }
  });

  test('gives back what undoes it, to whatever was installed before', async () => {
    const outer = network({});
    const undo = configureFetch({
      fetch: async () => page('<p>Inner</p>'),
      gate: null,
    });
    expect(await fetchPage('https://one.example/')).toMatchObject({
      html: '<p>Inner</p>',
    });
    expect(outer).toEqual([]);
    undo();
    clearRobotsCache();
    expect((await fetchPage('https://one.example/')).ok).toBe(false);
    expect(outer.filter((event) => event.startsWith('fetch'))).toHaveLength(2);
  });
});

describe('paceByAddress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-fetch-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("installs a gate on the ledger in the directory it is given, so a request takes its turn in the walks' shared file", async () => {
    const events = network({}, { gated: false });
    // Its robots.txt is read first, so the paced request is the only one.
    await fetchPage('https://two.example/');
    const before = Date.now();
    const gate = paceByAddress(60_000, () => {}, dir);
    await fetchPage('https://two.example/');
    expect(events).toHaveLength(3);
    const turns = currentTurns(dir);
    expect(Object.keys(turns)).toEqual(['2001:db8::20']);
    expect(turns['2001:db8::20']).toBeGreaterThanOrEqual(before + 60_000);
    expect(gate.heldRequests()).toBe(0);
    expect(gate.paused()).toBe(0);
  });

  test('the fetcher and the gate together: an address that stops answering is paused, announced by count, and its sites are then not asked', async () => {
    const silence = new Error('The operation timed out.');
    const down = Object.fromEntries(
      ['three', 'four', 'five'].flatMap((site) => [
        [`https://${site}.example/robots.txt`, silence],
        [`https://${site}.example/`, silence],
      ]),
    );
    const events = network(
      { 'https://one.example/': page('<p>Hello</p>'), ...down },
      { gated: false },
    );
    const logs: string[] = [];
    const gate = paceByAddress(0, (message) => logs.push(message), dir);
    expect((await fetchPage('https://one.example/')).ok).toBe(true);
    for (const site of ['three', 'four']) {
      expect(await fetchPage(`https://${site}.example/`)).toEqual({
        ok: false,
        reason: 'timeout',
      });
    }
    expect(gate.paused()).toBe(0);
    // The third site's robots.txt goes unanswered, so its page is never asked for.
    expect(await fetchPage('https://five.example/')).toEqual({
      ok: false,
      reason: 'address_paused',
    });
    expect(gate.paused()).toBe(1);
    expect(logs).toEqual([
      '  a hosting address stopped answering and is left alone for the rest of this run (1 so far)',
    ]);
    const sent = events.length;
    expect(await fetchSite('https://one.example', () => {})).toMatchObject({
      ok: false,
      reason: 'address_paused',
      attempts: 1,
    });
    expect(events).toHaveLength(sent);
    expect((await fetchPage('https://two.example/')).ok).toBe(false);
    expect(events.length).toBeGreaterThan(sent);
  });

  // An address of their own, and one that another site is at.
  const OWN = '192.0.2.60';
  const SHARED = '192.0.2.70';
  const silence = new Error('The operation timed out.');
  /** Robots.txt and the home page of each site, on `origin`'s scheme and port, going unanswered. */
  const unanswered = (sites: string[], origin: (site: string) => string) =>
    Object.fromEntries(
      sites.flatMap((site) => [
        [`${origin(site)}/robots.txt`, silence],
        [`${origin(site)}/`, silence],
      ]),
    );

  test('what a request came to counts at the address it was sent to, never at another its host resolves to', async () => {
    const hosts = {
      'shared.example': [SHARED],
      'alpha.example': [OWN, SHARED],
      'beta.example': [OWN, SHARED],
      'gamma.example': [OWN, SHARED],
      'delta.example': [OWN, SHARED],
    };
    network(
      {
        'https://shared.example/': page('<p>Hello</p>'),
        'https://shared.example/about': page('<p>About</p>'),
        'https://alpha.example/': page('<p>Hello</p>'),
        ...unanswered(
          ['beta', 'gamma', 'delta'],
          (site) => `https://${site}.example`,
        ),
      },
      { gated: false, hosts },
    );
    const gate = paceByAddress(0, () => {}, dir);
    expect((await fetchPage('https://shared.example/')).ok).toBe(true);
    expect((await fetchPage('https://alpha.example/')).ok).toBe(true);
    expect(sentTo.at(-1)).toBe(`https://${OWN}/`);
    for (const site of ['beta', 'gamma', 'delta']) {
      expect((await fetchPage(`https://${site}.example/`)).ok).toBe(false);
    }
    // The address that went unanswered is paused, and it alone.
    expect(gate.paused()).toBe(1);
    expect(await fetchPage('https://alpha.example/')).toEqual({
      ok: false,
      reason: 'address_paused',
    });
    expect((await fetchPage('https://shared.example/about')).ok).toBe(true);
  });

  test('a timeout on a port an address was never heard on does not count against it', async () => {
    const hosts = {
      'shared.example': [SHARED],
      'alpha.example': [SHARED],
      'beta.example': [SHARED],
      'gamma.example': [SHARED],
    };
    network(
      {
        'https://shared.example/': page('<p>Hello</p>'),
        'https://shared.example/about': page('<p>About</p>'),
        ...unanswered(
          ['alpha', 'beta', 'gamma'],
          (site) => `http://${site}.example:81`,
        ),
      },
      { gated: false, hosts },
    );
    const gate = paceByAddress(0, () => {}, dir);
    expect((await fetchPage('https://shared.example/')).ok).toBe(true);
    for (const site of ['alpha', 'beta', 'gamma']) {
      expect(await fetchPage(`http://${site}.example:81/`)).toEqual({
        ok: false,
        reason: 'timeout',
      });
    }
    expect(gate.paused()).toBe(0);
    expect((await fetchPage('https://shared.example/about')).ok).toBe(true);
  });
});
