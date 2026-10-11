import { next, rewrite } from '@vercel/edge';

import { BROWSER_CHECK_PATH } from './src/lib/device/browser-check-config';
import {
  CLIENT_RENDER,
  RENDER_PARAM,
  SESSION_CALL_PATH,
  SESSION_HEADER,
  SESSION_PATH,
  SESSION_REQUIRED,
} from './src/lib/session/calls';
import { decide, documentMode } from './src/lib/session/decide';
import { crawlerRanges } from './src/lib/session/ranges';
import { sessionSecret } from './src/lib/session/token';

// SSR document routes (TanStack Start). Accept-repaired in serveDocument and where
// we advertise llms.txt to agents. The exact root '/' is handled inline below.
const DOCUMENT_PREFIXES = [
  '/company/', // detail pages
  '/privacy', // privacy policy
  '/download', // download PAGE only — '/downloads/*' is a pass-through API route below
  '/filters', // filter form page (applies onto the home listing)
];

// Server-function / Nitro API / discovery routes — passed through untouched so they
// keep their own JSON/binary content negotiation. Checked BEFORE DOCUMENT_PREFIXES so
// the binary '/downloads/*' route isn't swallowed by the '/download' document prefix.
const API_PREFIXES = [
  '/_server', // TanStack server functions
  '/api/releases', // Nitro desktop-release write endpoint
  '/api/revalidate', // Nitro cache revalidation endpoint
  '/api/tiles/', // Nitro Stadia Maps tile proxy
  '/downloads/', // Nitro installer redirects + electron-updater feed (302/binary)
  '/.well-known/vercel/', // Vercel Flags Explorer discovery endpoint
  // Vercel BotID's challenge script and every call it makes, proxied to Vercel by the
  // Nitro route rules. Its calls carry no file extension and no HTML Accept, so the edge
  // 404 below would answer them, and the challenge could never complete.
  `${BROWSER_CHECK_PATH}/`,
];

// Routes with no sub-paths are matched exactly, so a look-alike such as `/api/engaged-x`
// still takes the edge 404 below instead of spending a function invocation on Nitro's own 404.
const API_EXACT = new Set([
  '/api/engaged', // Nitro engagement ping (sendBeacon sends a wildcard Accept — the document fallback below would 404 it)
  SESSION_PATH, // Nitro session endpoint (a JSON POST — the document fallback below would 404 it)
]);

// A company page by its slug, one segment: the documents served by session (companyDocument).
// The legacy two-segment URL only ever redirects, and a trailing slash is the router's own 307.
const COMPANY_DOCUMENT_RE = /^\/company\/[^/]+$/;

// Device-keyed pings (Nitro /api/p|v|e/:hash): exactly one 32-hex segment, so a
// malformed key takes the edge 404 without spending a function invocation.
const DEVICE_PING_RE = /^\/api\/[pve]\/[0-9a-f]{32}$/;

const STATIC_EXTENSIONS = new Set([
  'svg',
  'png',
  'ico',
  'xml',
  'json',
  'txt',
  'webmanifest',
  'js',
  'css',
  'jpg',
  'jpeg',
  'webp',
  'woff2',
]);

// RFC 8288 discovery hint pointing agents at the site's llms.txt guide.
const AGENT_LINK = '</llms.txt>; rel="describedby"';

/** Mirror of TanStack Start's document-handler Accept test (createStartHandler): true iff some comma-part, trimmed, starts with text/html or the wildcard media range. */
function acceptsHtml(accept: string): boolean {
  return accept.split(',').some((part) => {
    const type = part.trim();
    return type.startsWith('text/html') || type.startsWith('*/*');
  });
}

/** Serve an SSR document route: advertise llms.txt via a Link header and repair an Accept the render path would reject (it 500s unless Accept carries text/html or the wildcard range). With a `destination`, the document is rendered from that URL instead of the one asked for. */
function serveDocument(request: Request, destination?: URL): Response {
  const init: {
    headers: Record<string, string>;
    request?: { headers: Headers };
  } = { headers: { Link: AGENT_LINK } };

  const accept = request.headers.get('accept');
  if (accept && !acceptsHtml(accept)) {
    const headers = new Headers(request.headers);
    headers.set('accept', `${accept}, text/html`);
    init.request = { headers };
  }
  return destination ? rewrite(destination, init) : next(init);
}

/** How the request is served by session (`src/lib/session/decide.ts`). */
async function decision(request: Request) {
  return decide({
    headers: request.headers,
    ranges: await crawlerRanges(),
    secret: sessionSecret(),
  });
}

/** The URL a company page is rendered from as the app shell: its path and search term, marked. Other parameters are left off, so the router has none to redirect away. */
function shellUrl(url: URL): URL {
  const shell = new URL(url.pathname, url.origin);
  const search = url.searchParams.get('search');
  if (search) shell.searchParams.set('search', search);
  shell.searchParams.set(RENDER_PARAM, CLIENT_RENDER);
  return shell;
}

/**
 * A company page under DOCUMENT_MODE: the full document for a crawler or a session holder, the app
 * shell otherwise. The shell has its own URL, so the two never share a cache entry. `observe` only
 * logs.
 */
async function companyDocument(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = documentMode();
  if (mode) {
    const decided = await decision(request);
    console.info(`[document] ${decided.render} (${decided.why})`);
    if (mode === 'enforce' && decided.render === 'client')
      return serveDocument(request, shellUrl(url));
  }
  if (url.searchParams.get(RENDER_PARAM) !== CLIENT_RENDER)
    return serveDocument(request);
  url.searchParams.delete(RENDER_PARAM);
  return serveDocument(request, url);
}

/**
 * A company data call: under `enforce`, refused here without a session, ahead of the cache. The
 * refusal is never cached and names itself, so the browser renews its session and calls again.
 * `observe` only logs.
 */
async function sessionCall(request: Request): Promise<Response> {
  const mode = documentMode();
  if (!mode) return next();
  const decided = await decision(request);
  if (decided.render === 'server') return next();
  console.info(
    `[call] ${mode === 'enforce' ? 'refused' : 'would refuse'} (${decided.why})`,
  );
  if (mode === 'observe') return next();
  return new Response(null, {
    status: 403,
    headers: {
      [SESSION_HEADER]: SESSION_REQUIRED,
      'cache-control': 'private, no-store',
    },
  });
}

export default function middleware(
  request: Request,
): Response | Promise<Response> {
  const { pathname } = new URL(request.url);

  // Home + SSR document routes advertise llms.txt and get the Accept repair.
  if (pathname === '/') return serveDocument(request);

  // A company page's data calls, by session. Ahead of API_PREFIXES, which '/_serverFn' is under.
  if (pathname.startsWith(SESSION_CALL_PATH)) return sessionCall(request);

  // Server-function / API / discovery routes — pass through untouched. Checked before
  // DOCUMENT_PREFIXES so '/downloads/*' isn't caught by the '/download' prefix.
  if (API_EXACT.has(pathname)) return next();
  if (DEVICE_PING_RE.test(pathname)) return next();
  if (API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next();

  if (COMPANY_DOCUMENT_RE.test(pathname)) return companyDocument(request);
  if (DOCUMENT_PREFIXES.some((prefix) => pathname.startsWith(prefix)))
    return serveDocument(request);

  // Allow known static file types.
  const dot = pathname.lastIndexOf('.');
  if (dot > pathname.lastIndexOf('/')) {
    const ext = pathname.slice(dot + 1).toLowerCase();
    if (STATIC_EXTENSIONS.has(ext)) return next();
  }

  // Let document navigations (any browser requesting HTML) reach the app's 404 page.
  // Keyed on Accept, not Sec-Fetch-Mode: iOS Safari doesn't reliably send the latter,
  // so it was still hitting the empty edge 404. Asset/API/bot probes (no text/html in
  // Accept) still get a cheap edge 404 with no function invocation; the Vercel firewall
  // remains the primary bot defense.
  const accept = request.headers.get('accept') || '';
  if (accept.includes('text/html')) return next();

  // Block everything else at the edge — no function invocation.
  return new Response('', { status: 404 });
}
