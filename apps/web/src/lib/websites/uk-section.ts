/**
 * The UK section of a site that serves several countries, such as a group's
 * site with an `/en-gb/` section: the page a company page links to instead of
 * the global home. No I/O.
 *
 * The homepage's own en-GB alternate first, then a link whose first path
 * segment is a UK locale. Either way the section is put on the origin it was
 * read from, so the link stays on the site every check reads.
 */

/** A first path segment naming the UK: en-gb, en-uk, uk, gb, uk-en or gb-en. */
const UK_SEGMENT = /^\/(en[-_](?:gb|uk)|(?:uk|gb)(?:[-_]en)?)(?:\/|$)/i;

/** An hreflang naming English for the UK. */
const UK_HREFLANG = /^en[-_](?:gb|uk)$/i;

const LINK_TAG = /<link\b[^>]*>/gi;
const ANCHOR_TAG = /<a\b[^>]*>/gi;

/** One attribute's value from a tag, quoted or bare. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '').trim() : null;
}

/** Host compared www-insensitively, as the walk reads a site. */
function siteOf(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** A same-site href's path, or null for another site's, the home itself or an unreadable one. */
function sitePath(href: string, origin: URL): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (siteOf(url.hostname) !== siteOf(origin.hostname)) return null;
  return url.pathname === '/' ? null : url.pathname;
}

/** The UK section of the site at `origin`, read off its homepage html, or null when it shows none. */
export function ukSection(origin: string, html: string): string | null {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  for (const [tag] of html.matchAll(LINK_TAG)) {
    const rel = attribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    if (!rel.includes('alternate')) continue;
    if (!UK_HREFLANG.test(attribute(tag, 'hreflang') ?? '')) continue;
    const path = sitePath(attribute(tag, 'href') ?? '', base);
    if (path) return `${base.origin}${path}`;
  }
  for (const [tag] of html.matchAll(ANCHOR_TAG)) {
    const path = sitePath(attribute(tag, 'href') ?? '', base);
    const segment = path ? UK_SEGMENT.exec(path) : null;
    if (segment) return `${base.origin}/${segment[1]}/`;
  }
  return null;
}
