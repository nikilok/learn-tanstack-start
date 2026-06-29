import { next } from '@vercel/edge';

const ALLOWED_PREFIXES = [
  '/', // home
  '/company/', // detail pages
  '/privacy', // privacy policy
  '/download', // desktop app download page
  '/_server', // TanStack server functions
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

export default function middleware(request: Request) {
  const { pathname } = new URL(request.url);

  // Allow the exact root path
  if (pathname === '/') return next();

  // Allow known route prefixes
  if (
    ALLOWED_PREFIXES.some(
      (prefix) => prefix !== '/' && pathname.startsWith(prefix),
    )
  )
    return next();

  // Allow known static file types
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

  // Block everything else at the edge — no function invocation
  return new Response('', { status: 404 });
}
