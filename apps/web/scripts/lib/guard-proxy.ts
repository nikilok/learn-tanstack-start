/**
 * A loopback proxy a render's browser sends every connection through. It
 * resolves each host itself, refuses one that resolves to any private address,
 * and connects to the address it checked, so every hop of a redirect and every
 * socket a page opens is held to the fetcher's address rule.
 */

import { lookup } from 'node:dns/promises';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

import { isPrivateAddress } from '../../src/lib/websites/fetch-policy.ts';

/** Longest a connection may sit idle before it is dropped. */
const IDLE_MS = 20_000;

/** The ports a page's own traffic may reach: the web's. */
export const WEB_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);

/** The address to connect to for a host; null when it resolves nowhere or to any private address. */
export type Resolve = (host: string) => Promise<string | null>;

/** A host's address to connect to, IPv4 first; null when it resolves nowhere or to any private address. */
export async function publicAddress(host: string): Promise<string | null> {
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return null;
    if (addresses.some((a) => isPrivateAddress(a.address))) return null;
    return (addresses.find((a) => a.family === 4) ?? addresses[0]).address;
  } catch {
    return null;
  }
}

/** The host and port a CONNECT request names; null when malformed. */
export function connectTarget(
  target: string,
): { host: string; port: number } | null {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65_535) return null;
  return { host: match[1] ?? match[2], port };
}

/** Headers that belong to one connection, never passed on. */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
];

/** Headers without the hop-by-hop ones. */
function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const kept = { ...headers };
  for (const name of HOP_BY_HOP) delete kept[name];
  return kept;
}

export type GuardProxy = {
  /** Where the browser is pointed. */
  url: string;
  close(): Promise<void>;
};

/** Start a guard proxy on the loopback interface; a test passes its own resolver and ports. */
export async function startGuardProxy({
  resolve = publicAddress,
  ports = WEB_PORTS,
}: {
  resolve?: Resolve;
  ports?: ReadonlySet<number>;
} = {}): Promise<GuardProxy> {
  const server = createServer(async (req, res) => {
    req.on('error', () => res.destroy());
    res.on('error', () => {});
    const refuse = (status = 403) => {
      if (!res.headersSent) res.writeHead(status);
      res.end();
    };
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      return refuse();
    }
    if (target.protocol !== 'http:') return refuse();
    const port = Number(target.port || 80);
    if (!ports.has(port)) return refuse();
    const address = await resolve(target.hostname);
    if (!address) return refuse();
    const upstream = request(
      {
        host: address,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...endToEnd(req.headers), host: target.host },
        timeout: IDLE_MS,
      },
      (answer) => {
        answer.on('error', () => res.destroy());
        res.writeHead(answer.statusCode ?? 502, endToEnd(answer.headers));
        answer.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => (res.headersSent ? res.destroy() : refuse(502)));
    req.pipe(upstream);
  });

  server.on('connect', async (req, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy());
    const target = connectTarget(req.url ?? '');
    const address =
      target && ports.has(target.port) ? await resolve(target.host) : null;
    if (!target || !address) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(target.port, address);
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  // A page's own upgrade requests are tunnelled; a plain one is refused.
  server.on('upgrade', (_req, socket: Duplex) => socket.destroy());
  server.on('clientError', (_error, socket: Duplex) => socket.destroy());

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}
