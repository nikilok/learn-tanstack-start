import { next } from '@vercel/edge';

const ALLOWED_PREFIXES = [
  '/', // home
  '/company/', // detail pages
  '/privacy', // privacy policy
  '/_server', // TanStack server functions
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

  // Block everything else at the edge — no function invocation
  return new Response('', { status: 404 });
}
