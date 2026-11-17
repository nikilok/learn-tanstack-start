import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';

import {
  accepts,
  asAsked,
  bindTo,
  DIAL_STAGGER_MS,
  type Dial,
  firstToAccept,
  portOf,
  type Wait,
} from './address-binding.ts';

// Documentation addresses and reserved names: nobody's.
const A = '192.0.2.10';
const SIX = '2001:db8::20';

describe('bindTo', () => {
  test('the URL names the address; the Host header and the TLS name keep the host', () => {
    expect(bindTo(new URL('https://site.example/team?page=2'), A)).toEqual({
      url: `https://${A}/team?page=2`,
      host: 'site.example',
      serverName: 'site.example',
    });
  });

  test('an IPv6 address goes in brackets', () => {
    expect(bindTo(new URL('https://site.example/'), SIX)).toEqual({
      url: `https://[${SIX}]/`,
      host: 'site.example',
      serverName: 'site.example',
    });
  });

  test('a port that is not the default stays in the URL and in the Host header, never in the TLS name', () => {
    expect(bindTo(new URL('https://site.example:8443/a'), A)).toEqual({
      url: `https://${A}:8443/a`,
      host: 'site.example:8443',
      serverName: 'site.example',
    });
  });

  test('plain HTTP has no TLS name', () => {
    expect(bindTo(new URL('http://site.example/a'), A)).toEqual({
      url: `http://${A}/a`,
      host: 'site.example',
    });
  });

  test('a URL that names an address already has no TLS name either', () => {
    expect(bindTo(new URL(`https://${A}/a`), A)).toEqual({
      url: `https://${A}/a`,
      host: A,
    });
    expect(bindTo(new URL(`https://[${SIX}]/a`), SIX)).toEqual({
      url: `https://[${SIX}]/a`,
      host: `[${SIX}]`,
    });
  });

  test('the URL asked for is left as it was', () => {
    const target = new URL('https://site.example/team');
    bindTo(target, A);
    expect(target.href).toBe('https://site.example/team');
  });

  test('what is not an address is refused, never sent by name or to another address instead', () => {
    // The last two are what a URL would take for a host: an address with a zone, and a short form of another address.
    for (const address of ['', 'other.example', 'fe80::1%en0', '192.0.2']) {
      expect(() => bindTo(new URL('https://site.example/'), address)).toThrow(
        'not an address a request can be sent to',
      );
    }
  });
});

describe('portOf', () => {
  test("the URL's own port, else its scheme's", () => {
    expect(portOf(new URL('https://site.example/'))).toBe(443);
    expect(portOf(new URL('http://site.example/'))).toBe(80);
    expect(portOf(new URL('https://site.example:8443/'))).toBe(8443);
    expect(portOf(new URL('http://site.example:8080/'))).toBe(8080);
    // A port the URL names is the port, whatever it is.
    expect(portOf(new URL('http://site.example:0/'))).toBe(0);
  });
});

describe('asAsked', () => {
  const sent = `https://${A}/team`;
  const asked = 'https://site.example/team';

  test('a failure that names the URL it was sent to names the URL asked for, and is otherwise the same failure', () => {
    const failure = Object.assign(
      new TypeError(`SomeFailure fetching "${sent}". More after "${sent}"`),
      { code: 'SomeFailure' },
    );
    const renamed = asAsked(failure, sent, asked) as Error & { code?: string };
    expect(renamed.message).toBe(
      `SomeFailure fetching "${asked}". More after "${asked}"`,
    );
    expect(renamed.name).toBe('TypeError');
    expect(renamed.code).toBe('SomeFailure');
    expect(renamed.cause).toBe(failure);
  });

  test('a failure that names no URL is handed back as it is', () => {
    const failure = new Error('The operation timed out.');
    expect(asAsked(failure, sent, asked)).toBe(failure);
    expect(asAsked('not an error', sent, asked)).toBe('not an error');
  });

  test('a failure without a code gains none', () => {
    const renamed = asAsked(new Error(`fetching "${sent}"`), sent, asked);
    expect(renamed).not.toHaveProperty('code');
  });
});

/** A dial whose every attempt the test settles by hand; one ended from outside rejects as a real one does. */
function dialler() {
  const open = new Map<string, { accept(): void; refuse(): void }>();
  const dialled: string[] = [];
  const ended: string[] = [];
  const dial: Dial = (address, port, signal) => {
    dialled.push(`${address}:${port}`);
    return new Promise<void>((resolve, reject) => {
      /** Ended from outside while still open. */
      const end = () => {
        ended.push(address);
        reject(signal.reason);
      };
      if (signal.aborted) {
        end();
        return;
      }
      signal.addEventListener('abort', end);
      open.set(address, {
        accept: () => {
          signal.removeEventListener('abort', end);
          resolve();
        },
        refuse: () => {
          signal.removeEventListener('abort', end);
          reject(new Error('ECONNREFUSED'));
        },
      });
    });
  };
  return { dial, dialled, ended, open };
}

/** A stagger the test runs out by hand, oldest first. */
function staggers() {
  const running: (() => void)[] = [];
  const asked: number[] = [];
  const wait: Wait = (ms) =>
    new Promise<void>((resolve) => {
      asked.push(ms);
      running.push(resolve);
    });
  return { wait, asked, runOut: () => running.shift()?.() };
}

/** Let every settled promise's handlers run. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A limit that never comes. */
const never = () => new AbortController().signal;

describe('firstToAccept', () => {
  test('an address is given a quarter of a second before the next is dialled as well', async () => {
    expect(DIAL_STAGGER_MS).toBe(250);
    const { dial, open } = dialler();
    const { wait, asked } = staggers();
    const first = firstToAccept(['a', 'b'], 443, never(), dial, wait);
    expect(asked).toEqual([250]);
    open.get('a')?.accept();
    await first;
  });

  test('the first address is dialled alone, and when it accepts no other is', async () => {
    const { dial, dialled, open } = dialler();
    const { wait } = staggers();
    const first = firstToAccept(['a', 'b', 'c'], 443, never(), dial, wait);
    await settled();
    expect(dialled).toEqual(['a:443']);
    open.get('a')?.accept();
    expect(await first).toBe('a');
    await settled();
    expect(dialled).toEqual(['a:443']);
  });

  test('the next is dialled as soon as one refuses, without waiting out its time', async () => {
    const { dial, dialled, open } = dialler();
    const { wait } = staggers();
    const first = firstToAccept(['a', 'b'], 80, never(), dial, wait);
    open.get('a')?.refuse();
    await settled();
    expect(dialled).toEqual(['a:80', 'b:80']);
    open.get('b')?.accept();
    expect(await first).toBe('b');
  });

  test('the next is dialled as well once one has had its time; whichever accepts first is the one, and the others are ended', async () => {
    const { dial, dialled, ended, open } = dialler();
    const { wait, runOut } = staggers();
    const first = firstToAccept(['a', 'b', 'c'], 443, never(), dial, wait);
    await settled();
    expect(dialled).toEqual(['a:443']);
    runOut();
    await settled();
    expect(dialled).toEqual(['a:443', 'b:443']);
    runOut();
    await settled();
    expect(dialled).toEqual(['a:443', 'b:443', 'c:443']);
    open.get('b')?.accept();
    expect(await first).toBe('b');
    expect([...ended].sort()).toEqual(['a', 'c']);
  });

  test('an address that accepts after the next was dialled is still the one', async () => {
    const { dial, ended, open } = dialler();
    const { wait, runOut } = staggers();
    const first = firstToAccept(['a', 'b', 'c'], 443, never(), dial, wait);
    runOut();
    await settled();
    open.get('a')?.accept();
    expect(await first).toBe('a');
    expect(ended).toEqual(['b']);
  });

  test('of two that accept together, the one that accepted first is the one', async () => {
    const { dial, open } = dialler();
    const { wait, runOut } = staggers();
    const first = firstToAccept(['a', 'b'], 443, never(), dial, wait);
    runOut();
    await settled();
    open.get('b')?.accept();
    open.get('a')?.accept();
    expect(await first).toBe('b');
  });

  test('when none accepts, it fails once the last still open has refused, and not before', async () => {
    const { dial, open } = dialler();
    const { wait, runOut } = staggers();
    let failure: unknown;
    const first = firstToAccept(['a', 'b'], 443, never(), dial, wait).catch(
      (error: unknown) => {
        failure = error;
      },
    );
    runOut();
    await settled();
    // The second refuses while the first is still open.
    open.get('b')?.refuse();
    await settled();
    expect(failure).toBeUndefined();
    open.get('a')?.refuse();
    await first;
    expect(failure).toEqual(new Error('no address accepted a connection'));
  });

  test('with no address at all, it fails at once', async () => {
    const { dial } = dialler();
    await expect(firstToAccept([], 443, never(), dial)).rejects.toThrow(
      'no address accepted a connection',
    );
  });

  test('a dial that throws is an address that did not accept', async () => {
    const { dial, open } = dialler();
    const { wait } = staggers();
    const throwing: Dial = (address, port, signal) => {
      if (address === 'a') throw new Error('could not dial');
      return dial(address, port, signal);
    };
    const first = firstToAccept(['a', 'b'], 443, never(), throwing, wait);
    await settled();
    open.get('b')?.accept();
    expect(await first).toBe('b');
  });

  test('the limit ends every attempt, and is the failure', async () => {
    const { dial, dialled, ended } = dialler();
    const { wait, runOut } = staggers();
    const limit = new AbortController();
    const first = firstToAccept(['a', 'b', 'c'], 443, limit.signal, dial, wait);
    runOut();
    await settled();
    const reason = new DOMException('The operation timed out.', 'TimeoutError');
    limit.abort(reason);
    await expect(first).rejects.toBe(reason);
    expect([...ended].sort()).toEqual(['a', 'b']);
    // The address not yet dialled never is.
    expect(dialled).toEqual(['a:443', 'b:443']);
  });

  test('a limit already reached is the failure, and no second address is dialled', async () => {
    const limit = new AbortController();
    const reason = new DOMException('The operation timed out.', 'TimeoutError');
    limit.abort(reason);
    const { dial, dialled } = dialler();
    await expect(
      firstToAccept(['a', 'b', 'c'], 443, limit.signal, dial),
    ).rejects.toBe(reason);
    expect(dialled).toEqual(['a:443']);
  });

  test('on the real clock, a second address is dialled a quarter of a second after one that does not answer', async () => {
    const { dial, dialled, open } = dialler();
    const started = Date.now();
    const first = firstToAccept(['a', 'b'], 443, never(), dial);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(dialled).toEqual(['a:443']);
    for (let waited = 0; waited < 100 && dialled.length < 2; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(dialled).toEqual(['a:443', 'b:443']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(DIAL_STAGGER_MS - 5);
    open.get('b')?.accept();
    expect(await first).toBe('b');
  });
});

describe('accepts', () => {
  let server: Server;
  let port = 0;
  let connections = 0;
  let closed = 0;
  beforeAll(async () => {
    server = createServer((socket) => {
      connections += 1;
      socket.on('close', () => {
        closed += 1;
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });
  afterAll(() => {
    server.close();
  });

  test('a listening address accepts, and the connection is closed again', async () => {
    await accepts('127.0.0.1', port, never());
    for (let waited = 0; waited < 100 && closed < 1; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(connections).toBe(1);
    expect(closed).toBe(1);
  });

  test('an address nothing listens at does not', async () => {
    const idle = createServer();
    await new Promise<void>((resolve) =>
      idle.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = idle.address();
    const free = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => idle.close(() => resolve()));
    await expect(accepts('127.0.0.1', free, never())).rejects.toThrow();
  });

  test('an attempt ended before it starts opens nothing', async () => {
    const before = connections;
    const ended = new AbortController();
    const reason = new Error('ended');
    ended.abort(reason);
    await expect(accepts('127.0.0.1', port, ended.signal)).rejects.toBe(reason);
    await settled();
    expect(connections).toBe(before);
  });

  test('an attempt ended while it is open fails with the reason it was ended for, whatever the address would have done', async () => {
    const ended = new AbortController();
    const attempt = accepts('127.0.0.1', port, ended.signal);
    const reason = new Error('ended');
    // Ended before the connection can have been accepted.
    ended.abort(reason);
    await expect(attempt).rejects.toBe(reason);
  });
});
