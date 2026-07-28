/**
 * The update feed's request contract.
 *
 * Kept electron-free (and out of updater.ts, which imports `electron`) so the
 * constant the web side mirrors can be locked by a test on this side too.
 */

/**
 * Carries the running app's version on every feed request. electron-updater
 * sends a fixed `electron-builder` User-Agent with no version, so without this
 * the feed cannot tell which version a machine is updating FROM. Mirrored as
 * APP_VERSION_HEADER in apps/web/server/utils/updaterLog.ts — renaming one side
 * silently drops `from=` from every log line, so both copies are locked by
 * matching tests.
 */
export const APP_VERSION_HEADER = 'x-app-version';
