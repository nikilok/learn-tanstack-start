import { next } from '@vercel/edge';

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
];

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

/** Serve an SSR document route: advertise llms.txt via a Link header and repair an Accept the render path would reject (it 500s unless Accept carries text/html or the wildcard range). */
function serveDocument(request: Request): Response {
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
  return next(init);
}

export default function middleware(request: Request) {
  const { pathname } = new URL(request.url);

  // Home + SSR document routes advertise llms.txt and get the Accept repair.
  if (pathname === '/') return serveDocument(request);

  // Server-function / API / discovery routes — pass through untouched. Checked before
  // DOCUMENT_PREFIXES so '/downloads/*' isn't caught by the '/download' prefix.
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
