/**
 * Display helper for the confirmed company website shown on the detail page.
 *
 * The rendered section is the domain and nothing else: how a URL was confirmed
 * is not page copy, since a caption explaining the check would spell it out for
 * every visitor. The gate itself lives in api/companyWebsite.ts.
 */

/** Strips exactly one leading `www.`, leaving lookalikes like `wwww.` alone. */
function stripWww(host: string) {
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * The link's visible label: the destination with the scheme and a bare trailing
 * slash removed, so a reader sees where they are going rather than the word
 * "Website". Keeps the path, port and query, which are part of the destination;
 * an unparseable value falls back to the raw string so the link never renders
 * blank.
 */
export function displayDomain(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${stripWww(parsed.host)}${path}${parsed.search}`;
}
