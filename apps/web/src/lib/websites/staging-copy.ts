/**
 * A preview, dev or staging copy of a site that has its own domain: the site's
 * host under one more label. Such a copy points at the main domain, so a
 * source that lists the copy is read as naming the site. No I/O.
 */

import { siteOf } from './normalise-url';

/** Host labels that mark a copy of a site rather than a site of its own. */
const COPY_LABELS: ReadonlySet<string> = new Set([
  'dev',
  'preview',
  'stage',
  'staging',
  'stg',
  'test',
  'uat',
]);

/** An address as two of them are compared: site, port and path, without scheme, `www.` or trailing slash; null when it will not parse. */
function addressOf(
  url: string,
): { site: string; port: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return {
    site: siteOf(parsed.hostname),
    port: parsed.port,
    path: parsed.pathname.replace(/\/+$/, ''),
  };
}

/** Whether `url` is a preview, dev or staging copy of the site at `mainUrl`: that site's host under one copy label, at the same address or a page under it. */
export function isStagingCopyOf(
  url: string | null,
  mainUrl: string | null,
): boolean {
  if (!url || !mainUrl) return false;
  const copy = addressOf(url);
  const main = addressOf(mainUrl);
  if (!copy || !main || copy.port !== main.port) return false;
  const dot = copy.site.indexOf('.');
  if (dot < 0 || !COPY_LABELS.has(copy.site.slice(0, dot))) return false;
  // `staging.www.` and `www.staging.` name the same copy.
  if (siteOf(copy.site.slice(dot + 1)) !== main.site) return false;
  return copy.path === main.path || copy.path.startsWith(`${main.path}/`);
}
