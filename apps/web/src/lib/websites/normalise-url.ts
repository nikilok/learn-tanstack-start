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

/** Social profiles are not a company website — they are a page about one.
 *  Matched as domain suffixes, never exact hosts: registry data captured on a
 *  phone routinely carries `m.facebook.com/...` or `en-gb.facebook.com/...`,
 *  which an exact-host set waves through and stores at the top tier. */
const DENIED_DOMAINS = [
  'facebook.com',
  'fb.com',
  'fb.me',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'wa.me',
  'whatsapp.com',
];

/** Guards against a pathological value bloating the row; real URLs are short. */
const MAX_URL_LENGTH = 500;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Tab, CR and LF are STRIPPED by the WHATWG URL parser rather than rejected,
 *  so a cell holding two addresses on separate lines silently fuses into one
 *  invented hostname. Every C0 control is refused before parsing. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** True when `host` is the denied domain or a subdomain of it. */
function isDeniedHost(host: string): boolean {
  return DENIED_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

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
  // Must precede new URL(): the parser deletes these rather than failing, so
  // `a.co.uk\nb.co.uk` would silently become the host `a.co.ukb.co.uk`.
  if (hasControlChars(trimmed)) return null;

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
  if (isDeniedHost(host)) return null;

  // An explicit port is part of where the link goes. Dropping it rewrites the
  // destination silently, which is the same hazard the userinfo check above
  // exists to prevent — a default-port host that happens to answer would be
  // marked live and rendered in place of the address the registry published.
  const port = parsed.port ? `:${parsed.port}` : '';
  const path = parsed.pathname.replace(/\/+$/, '');
  return `https://${host}${port}${path}`;
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
  // Scheme-insensitive as well as www-insensitive. The revalidation sweep may
  // adopt an `http://` variant when a site serves no https at all, and a
  // comparison that only understood `https://www.` then read that stored URL
  // and the next registry import's `https://` form as two different sites —
  // recording a spurious conflict, or churning checked_at on every import.
  const strip = (u: string) =>
    u.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return strip(a) === strip(b);
}
