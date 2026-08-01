/**
 * Locating the CQC care-directory file on the CQC data page.
 *
 * Pure, and separate from the importer, because this is the part that breaks:
 * the URL carries a publication date so it cannot be constructed, the page is
 * scraped, and CQC changes both the path and the file naming without notice.
 * Extracted so the breakage has a test rather than a monthly cron failure.
 */

/**
 * The care directory with filters, under either path prefix.
 *
 * CQC moved these files from /sites/default/files/ to /system/files/, which
 * broke discovery silently until the next run (observed 2026-08-01, the file
 * itself unchanged). Both forms stay matched rather than one replacing the
 * other, because government feeds here have reverted a format change within
 * days before.
 *
 * The YYYY-MM folder is captured because it, not the whole URL, orders them.
 */
export const CQC_ODS_LINK =
  /https:\/\/www\.cqc\.org\.uk\/(?:sites\/default\/files|system\/files)\/([0-9]{4}-[0-9]{2})\/[^"'\s]*HSCA_Active_Locations\.ods/g;

/**
 * The most recently published care-directory URL on the page, or null when the
 * page carries none.
 *
 * Ordered by the YYYY-MM folder, NOT by the whole URL. With two path prefixes
 * matched, a lexical sort on the string ranks every /sites/... above every
 * /system/..., so in any month where one prefix lags the other it would
 * silently return the older file — which reads as a successful import of stale
 * data rather than as a failure.
 */
export function newestCqcOdsUrl(html: string): string | null {
  const matches = [...html.matchAll(CQC_ODS_LINK)];
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b[1].localeCompare(a[1]))[0][0];
}
