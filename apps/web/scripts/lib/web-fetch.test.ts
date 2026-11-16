import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AddressGate, Outcome } from './address-gate.ts';
import { currentTurns } from './address-ledger.ts';
import {
  awaitTurn,
  checkFetchable,
  clearRobotsCache,
  configureFetch,
  fetchPage,
  fetchSite,
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
};

type Reply = Response | Error;

/** A reply with a body and a status. */
const page = (body: string, status = 200, type = 'text/html') =>
  new Response(body, { status, headers: { 'content-type': type } });

/** A redirect to another URL. */
const moved = (location: string) =>
  new Response(null, { status: 301, headers: { location } });

let restore: (() => void) | undefined;
/** How each request of the newest fixture was sent. */
let sent: RequestInit[] = [];
afterEach(() => {
  restore?.();
  restore = undefined;
  clearRobotsCache();
});

/**
 * The fetcher on a fake network: hosts resolve from HOSTS, each URL answers
 * from `replies` (a 404 otherwise), and everything that happens is recorded in
 * order. `refuse` makes the gate refuse that many requests, then let the rest
 * through; without `gated` no gate is installed at all.
 */
function network(
  replies: Record<string, Reply>,
  { gated = true, refuse = 0 }: { gated?: boolean; refuse?: number } = {},
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
    settle: (host, addresses, outcome: Outcome) => {
      events.push(`${outcome} ${host} ${addresses.join(',')}`);
    },
    heldRequests: () => 0,
    paused: () => 0,
  };
  // One fixture at a time: the last one's undo puts back what was there before any.
  restore?.();
  sent = [];
  restore = configureFetch({
    lookup: async (hostname) => {
      const addresses = HOSTS[hostname];
      if (!addresses) throw new Error('ENOTFOUND');
      return addresses.map((address) => ({ address }));
    },
    fetch: async (url, init) => {
      events.push(`fetch ${url}`);
      sent.push(init);
      const reply = replies[url] ?? page('', 404);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    gate: gated ? gate : null,
  });
  return events;
}

const ONE = '192.0.2.10,192.0.2.11';

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
      `answered one.example ${ONE}`,
      `turn ${ONE}`,
      'fetch https://one.example/',
      `answered one.example ${ONE}`,
    ]);
    // Sent as ever: under our name, with a time limit, and redirects left for the fetcher to follow by hand.
    expect(sent.map((init) => init.headers)).toEqual([
      { 'user-agent': USER_AGENT },
      { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
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
    ).toEqual([`answered one.example ${ONE}`, `answered one.example ${ONE}`]);
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
    ).toEqual([`silent one.example ${ONE}`, `silent one.example ${ONE}`]);
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
    ).toEqual([`other one.example ${ONE}`, `other one.example ${ONE}`]);
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
      `answered one.example ${ONE}`,
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
});
