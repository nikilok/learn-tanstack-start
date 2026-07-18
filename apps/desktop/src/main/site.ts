/**
 * Pure string transforms for the hosted-site view: the WAF-safe user-agent and
 * the title-bar title. Electron-free so they're unit-testable — callers pass the
 * app name/version in.
 */

/** Chrome-like UA with the "Electron" and productName tokens stripped (so the WAF sees a normal browser), plus a desktop marker. A broken strip would leak `Electron/<v>` and risk the WAF blocking the app, so this is exercised by tests. */
export function desktopUserAgent(
  defaultUA: string,
  appName: string,
  appVersion: string,
): string {
  const chromeUA = defaultUA
    .replace(/ Electron\/[\d.]+/, '')
    .replace(new RegExp(` ${appName}\\/[\\d.]+`), '');
  return `${chromeUA} SponsorSearchDesktop/${appVersion}`;
}

/** Strips the SEO site-name suffix so the title-bar pill shows just the meaningful title. Mirrored in apps/web `utils.ts` cleanTitle — keep the regexes identical (both copies are covered by matching tests). */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[|—–-]\s*SponsorSearch(\.co\.uk)?\s*$/i, '')
    .replace(/\s*-\s*UK Visa Sponsor\s*$/i, '')
    .trim();
}
