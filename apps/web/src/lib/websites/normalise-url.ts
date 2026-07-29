/**
 * Canonicalises a discovered website into the single form stored in
 * company_websites.url, so two sources naming the same site produce the same
 * string and decideWebsite's equality check means what it says. No I/O.
 *
 * Registry data is messy in specific ways this has to absorb: every one of the
 * 15,695 CQC provider web addresses is scheme-less (`www.example.co.uk`), and
 * 665 carry a path that is load-bearing — `www.caremark.co.uk/arun` is one
 * franchise, so collapsing to the origin would point every Caremark franchise
 * at the national site. Paths are kept; query strings and fragments are not.
 */

/** Social profiles are not a company website — they are a page about one. */
const DENIED_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'linkedin.com',
  'www.linkedin.com',
  'uk.linkedin.com',
  'twitter.com',
  'www.twitter.com',
  'x.com',
  'www.x.com',
  'instagram.com',
  'www.instagram.com',
]);

/** Guards against a pathological value bloating the row; real URLs are short. */
const MAX_URL_LENGTH = 500;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Normalise a raw website value to `https://host[/path]`, or null when it is
 * not a usable public website.
 */
export function normaliseWebsiteUrl(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;

  // Scheme-less is the common case in registry data, so assume https rather
  // than rejecting. http is upgraded for the same reason we would not render a
  // mixed-content link; phase 2 revalidation demotes anything that does not
  // actually serve https.
  //
  // Any other scheme is rejected up front rather than after parsing: an
  // authority-less scheme like `mailto:care@example.co.uk` survives having
  // `https://` prepended, and URL then reads `mailto:care` as userinfo and
  // yields `https://example.co.uk` — a real address, invented out of an email.
  const hasWebScheme = /^https?:\/\//i.test(trimmed);
  if (!hasWebScheme && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(hasWebScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // `https://evil.example/@real.co.uk` reads as real.co.uk to a human; never
  // store a URL whose rendered host is not where the link goes.
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
  // A host with no dot is a bare label (localhost, an intranet name); an IPv4
  // or bracketed IPv6 literal is never a company's published website.
  if (!host.includes('.') || IPV4.test(host) || host.includes(':')) return null;
  if (DENIED_HOSTS.has(host)) return null;

  const path = parsed.pathname.replace(/\/+$/, '');
  return `https://${host}${path}`;
}

/**
 * Whether two normalised URLs point at the same site, ignoring a `www.` host
 * prefix.
 *
 * The prefix is not stripped during normalisation because the bare domain does
 * not always resolve, so we store the host the registry actually gave us. It
 * still must not read as a disagreement when two registries name one site.
 */
export function isSameSite(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  const strip = (u: string) => u.replace(/^https:\/\/www\./, 'https://');
  return strip(a) === strip(b);
}
