/**
 * Sending a request to one address of its host. The URL names the address,
 * and the host's name goes where a request by name puts it: the Host header
 * and, over TLS, the name asked for and checked against the certificate.
 */

import { connect, isIP } from 'node:net';

/** How long one address is given to accept a connection before the next is dialled as well. */
export const DIAL_STAGGER_MS = 250;

/** A request addressed to one of its host's addresses. */
export type Bound = {
  /** The request's URL, with the address in place of the host's name. */
  url: string;
  /** The Host header: the host as the request's own URL names it. */
  host: string;
  /** The name TLS asks for and checks the certificate against; none over plain HTTP, or when the URL names an address already. */
  serverName?: string;
};

/** A hostname without the brackets a URL puts around an IPv6 address. */
function bare(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

/** Address a request for `target` to one of its host's addresses. */
export function bindTo(target: URL, address: string): Bound {
  const literal = isIP(address) === 6 ? `[${address}]` : address;
  // Asked first: a URL handed a host it will not take keeps the one it had, and reads a short one as another address.
  if (isIP(address) === 0 || !URL.canParse(`http://${literal}/`)) {
    throw new Error(`not an address a request can be sent to: ${address}`);
  }
  const bound = new URL(target.href);
  bound.hostname = literal;
  const named = isIP(bare(target.hostname)) === 0;
  return {
    url: bound.href,
    host: target.host,
    ...(named &&
      target.protocol === 'https:' && { serverName: target.hostname }),
  };
}

/** The port a request for `target` connects to. */
export function portOf(target: URL): number {
  if (target.port !== '') return Number(target.port);
  return target.protocol === 'https:' ? 443 : 80;
}

/** A failure that names the URL a request was sent to, naming the URL that was asked for instead. */
export function asAsked(error: unknown, sent: string, asked: string): unknown {
  if (!(error instanceof Error) || !error.message.includes(sent)) return error;
  const renamed = new Error(error.message.replaceAll(sent, asked), {
    cause: error,
  });
  renamed.name = error.name;
  const { code } = error as { code?: unknown };
  if (code !== undefined) Object.assign(renamed, { code });
  return renamed;
}

/** Open a connection to an address and close it: settles once it is accepted, rejects when it is not, or when `signal` ends the attempt. */
export type Dial = (
  address: string,
  port: number,
  signal: AbortSignal,
) => Promise<void>;

/** Whether an address accepts a connection, by opening one and closing it. */
export const accepts: Dial = (address, port, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const socket = connect({ host: address, port });
    /** Close the attempt, then settle it; an attempt settles once, whatever comes after. */
    const end = (settle: () => void) => {
      socket.destroy();
      settle();
    };
    signal.addEventListener('abort', () => end(() => reject(signal.reason)), {
      once: true,
    });
    socket.once('connect', () => end(resolve));
    // Every error, not the first alone: one after the attempt has settled is still heard.
    socket.on('error', (error) => end(() => reject(error)));
  });

/** Resolves once a time has passed. */
export type Wait = (ms: number) => Promise<void>;

/** Resolves after `ms` on the clock. */
const pause: Wait = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The first of a host's addresses to accept a connection. They are dialled in
 * the order given, the next as soon as one fails or has had DIAL_STAGGER_MS, so
 * a host whose first address accepts is dialled once. Rejects when none
 * accepts, and with the limit's reason when the limit comes first.
 */
export async function firstToAccept(
  addresses: readonly string[],
  port: number,
  limit: AbortSignal,
  dial: Dial = accepts,
  wait: Wait = pause,
): Promise<string> {
  const others = new AbortController();
  const signal = AbortSignal.any([limit, others.signal]);
  let accepted: string | undefined;
  let announce: () => void = () => {};
  const anyAccepted = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const attempts: Promise<void>[] = [];
  for (const address of addresses) {
    // Inside a promise, so a dial that throws is one that failed.
    const attempt = new Promise<void>((resolve) =>
      resolve(dial(address, port, signal)),
    ).then(
      () => {
        accepted ??= address;
        announce();
      },
      // Refused, or ended: another may still accept.
      () => {},
    );
    attempts.push(attempt);
    await Promise.race([anyAccepted, attempt, wait(DIAL_STAGGER_MS)]);
    if (accepted !== undefined || limit.aborted) break;
  }
  await Promise.race([anyAccepted, Promise.all(attempts)]);
  others.abort();
  if (accepted !== undefined) return accepted;
  if (limit.aborted) throw limit.reason;
  throw new Error('no address accepted a connection');
}
