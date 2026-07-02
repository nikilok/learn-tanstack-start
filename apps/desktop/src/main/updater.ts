import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

// Long-running apps re-check on this cadence; the launch check fires immediately.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let downloadedVersion: string | null = null;

/** Starts background update checks (launch + every 4h) against the generic feed and reports each downloaded update. Packaged builds only. */
export function initAutoUpdates(
  onUpdateReady: (version: string) => void,
): void {
  if (!app.isPackaged) {
    // Dev affordance: the pill is otherwise unreachable in dev (updates need a packaged build).
    if (process.env.DESKTOP_SIMULATE_UPDATE)
      setTimeout(() => onUpdateReady('9.9.9-dev'), 2000);
    return;
  }
  autoUpdater.on('error', (err) => console.error('[updater]', err));
  // Downloaded + checksum-verified — quitAndInstall is safe from here, and
  // autoInstallOnAppQuit (default) still covers users who ignore the pill.
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version;
    onUpdateReady(info.version);
  });
  checkForUpdates();
  setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}

/** Fires a background feed check; a newer version starts downloading automatically. */
function checkForUpdates(): void {
  void autoUpdater
    .checkForUpdates()
    .catch((err) => console.error('[updater]', err));
}

/** Menu-triggered check: like the background check, but reports the outcome in a dialog. */
export async function checkForUpdatesFromMenu(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      void dialog.showMessageBox({
        type: 'info',
        message: 'Updates are not supported in this build.',
      });
    } else if (result.isUpdateAvailable) {
      void dialog.showMessageBox({
        type: 'info',
        message: `Version ${result.updateInfo.version} is available`,
        detail:
          'It is downloading in the background — an Update button will appear in the title bar when it is ready to install.',
      });
    } else {
      void dialog.showMessageBox({
        type: 'info',
        message: 'You are up to date',
        detail: `SponsorSearch ${app.getVersion()} is the latest version.`,
      });
    }
  } catch (err) {
    void dialog.showMessageBox({
      type: 'error',
      message: 'Could not check for updates',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Quits and restarts into the downloaded update (silent install, relaunch after). No-op until one is ready (incl. simulate mode). */
export function installPendingUpdate(): void {
  if (!app.isPackaged || !downloadedVersion) return;
  // Off the IPC stack so the sender's window can close cleanly first.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}
