import { next } from '@vercel/edge';

// SSR document routes (TanStack Start). Accept-repaired in serveDocument and where
// we advertise llms.txt to agents. The exact root '/' is handled inline below.
const DOCUMENT_PREFIXES = [
  '/company/', // detail pages
  '/privacy', // privacy policy
  '/download', // download page + /downloads/* installer redirects (startsWith covers both)
];

// Server-function / Nitro API / discovery routes — passed through untouched so they
// keep their own JSON/binary content negotiation.
const API_PREFIXES = [
  '/_server', // TanStack server functions
  '/api/releases', // Nitro desktop-release write endpoint
  '/api/revalidate', // Nitro cache revalidation endpoint
  '/api/tiles/', // Nitro Stadia Maps tile proxy
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

/**
 * Serve an SSR document route: advertise llms.txt via a Link header and repair a
 * non-HTML Accept so the render path returns HTML instead of its hardcoded 500.
 */
function serveDocument(request: Request): Response {
  const accept = request.headers.get('accept');
  // TanStack Start's document handler 500s unless Accept carries text/html or */*.
  if (accept && !accept.includes('text/html') && !accept.includes('*/*')) {
    const headers = new Headers(request.headers);
    headers.set('accept', `${accept}, text/html`);
    return next({ headers: { Link: AGENT_LINK }, request: { headers } });
  }
  return next({ headers: { Link: AGENT_LINK } });
}

export default function middleware(request: Request) {
  const { pathname } = new URL(request.url);

  // Home + SSR document routes.
  if (
    pathname === '/' ||
    DOCUMENT_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  )
    return serveDocument(request);

  // Server-function / API / discovery routes — pass through untouched.
  if (API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next();

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
