import { next, rewrite } from '@vercel/edge';

import { BROWSER_CHECK_PATH } from './src/lib/device/browser-check-config';
import { sessionSuspendedKeys } from './src/lib/device/suspended';
import {
  CLIENT_RENDER,
  RENDER_PARAM,
  SESSION_CALL_PATH,
  SESSION_HEADER,
  SESSION_PATH,
  SESSION_REQUIRED,
} from './src/lib/session/calls';
import { decide, decideDocument, documentMode } from './src/lib/session/decide';
import { ownerRequest } from './src/lib/session/owner';
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

// A company page by its slug, one segment, matched on the routed path: the documents served by
// session (companyDocument). The legacy two-segment URL only ever redirects, and a trailing slash
// is the router's own 307.
const COMPANY_DOCUMENT_RE = /^\/company\/([^/]+)$/;

/**
 * A path as the app's router resolves it: percent-decoded as the framework decodes it
 * (`decodeURI`) and lower-cased, as route segments match in any case. The session gate matches
 * on this, never on the spelling a client sent. Null when the path does not decode.
 */
function routedPath(pathname: string): string | null {
  try {
    return decodeURI(pathname).toLowerCase();
  } catch {
    return null;
  }
}

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

/** Whether a session call goes through: the owner's, or by session (`src/lib/session/decide.ts`). */
async function decision(request: Request) {
  return decide({
    headers: request.headers,
    ranges: await crawlerRanges(),
    secret: sessionSecret(),
    owner: await ownerRequest(request.headers),
    suspended: await sessionSuspendedKeys(),
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
 * A company page under DOCUMENT_MODE: the full document for the owner and a crawler, the app shell
 * for anyone else, session or not, whose data comes through its own data call. The shell has its
 * own URL, so the two never share a cache entry. `observe` only logs.
 */
async function companyDocument(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = documentMode();
  if (mode) {
    const decided = decideDocument({
      headers: request.headers,
      ranges: await crawlerRanges(),
      owner: await ownerRequest(request.headers),
    });
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
 * A session call (a company page's data, a search listing): under `enforce`, refused here without
 * a session, ahead of the cache. The refusal is never cached and names itself, so the browser
 * renews its session and calls again. `observe` logs every decision and refuses nothing.
 */
async function sessionCall(request: Request): Promise<Response> {
  const mode = documentMode();
  if (!mode) return next();
  const decided = await decision(request);
  if (mode === 'observe') {
    console.info(`[call] ${decided.render} (${decided.why})`);
    return next();
  }
  if (decided.render === 'server') return next();
  console.info(`[call] refused (${decided.why})`);
  return new Response(null, {
    status: 403,
    headers: {
      [SESSION_HEADER]: SESSION_REQUIRED,
      'cache-control': 'private, no-store',
    },
  });
}

/**
 * The edge's answer to every request, ahead of the cache: company pages decided by who asks and
 * the session calls by session, the other documents with the Accept repair, known API and static
 * routes passed through, and an edge 404 for anything else.
 */
export default function middleware(
  request: Request,
): Response | Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  // Home + SSR document routes advertise llms.txt and get the Accept repair.
  if (pathname === '/') return serveDocument(request);

  const routed = routedPath(pathname);
  if (routed === null) return new Response('', { status: 400 });

  // The session calls, by session. Ahead of API_PREFIXES, which '/_serverFn' is under.
  if (routed.startsWith(SESSION_CALL_PATH.toLowerCase()))
    return sessionCall(request);

  // A company page, at its one spelling: any other spelling the router would resolve to it
  // (case, escapes) is redirected there first, so every page is decided.
  const company = COMPANY_DOCUMENT_RE.exec(routed);
  if (company) {
    const canonical = `/company/${encodeURIComponent(company[1] ?? '')}`;
    if (pathname !== canonical)
      return Response.redirect(new URL(`${canonical}${url.search}`, url), 301);
    return companyDocument(request);
  }

  // Server-function / API / discovery routes — pass through untouched. Checked before
  // DOCUMENT_PREFIXES so '/downloads/*' isn't caught by the '/download' prefix.
  if (API_EXACT.has(pathname)) return next();
  if (DEVICE_PING_RE.test(pathname)) return next();
  if (API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next();

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
