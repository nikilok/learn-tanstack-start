import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

// Long-running apps re-check on this cadence; the launch check fires immediately.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let downloadedVersion: string | null = null;
let installRequested = false; // install failures only surface via the 'error' event

/** The downloaded-and-ready version, if any — single source of truth for the pending update. */
export function getPendingUpdateVersion(): string | null {
  return downloadedVersion;
}

/** Fire-and-forget one-line dialog. */
function showDialog(
  type: 'info' | 'error',
  message: string,
  detail?: string,
): void {
  void dialog.showMessageBox({ type, message, detail });
}

/** Human-readable detail line for an updater error. */
function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when the dev update simulation is explicitly enabled ("0"/"false" count as off). */
function simulateUpdateEnabled(): boolean {
  const value = process.env.DESKTOP_SIMULATE_UPDATE;
  return !!value && value !== '0' && value !== 'false';
}

/** Starts background update checks (launch + every 4h) against the generic feed and reports each downloaded update. Packaged builds only. */
export function initAutoUpdates(
  onUpdateReady: (version: string) => void,
): void {
  if (!app.isPackaged) {
    // Dev affordance: the toast is otherwise unreachable in dev (updates need a packaged build).
    if (simulateUpdateEnabled())
      setTimeout(() => {
        downloadedVersion = '9.9.9-dev';
        onUpdateReady('9.9.9-dev');
      }, 2000);
    return;
  }
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err);
    if (installRequested) {
      installRequested = false;
      showDialog('error', 'Could not install the update', errorDetail(err));
    }
  });
  // Downloaded + checksum-verified — quitAndInstall is safe from here, and
  // autoInstallOnAppQuit (default) still covers users who ignore the toast.
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
  if (!app.isPackaged) {
    showDialog('info', 'Updates are not supported in this build.');
    return;
  }
  // Already downloaded (e.g. the toast was dismissed) -> offer the restart directly.
  if (downloadedVersion) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `Version ${downloadedVersion} is ready to install`,
      detail: 'Restart SponsorSearch to finish updating.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) installPendingUpdate();
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) {
      showDialog('info', 'Updates are not supported in this build.');
    } else if (result.isUpdateAvailable) {
      showDialog(
        'info',
        `Version ${result.updateInfo.version} is available`,
        'It is downloading in the background — an update prompt will appear in the bottom-left corner when it is ready to install.',
      );
      // The user was promised a prompt; a failed download must not stay silent.
      void result.downloadPromise?.catch((err) =>
        showDialog('error', 'Could not download the update', errorDetail(err)),
      );
    } else {
      showDialog(
        'info',
        'You are up to date',
        `SponsorSearch ${app.getVersion()} is the latest version.`,
      );
    }
  } catch (err) {
    showDialog('error', 'Could not check for updates', errorDetail(err));
  }
}

/** Quits and restarts into the downloaded update (silent install, relaunch after). No-op until one is ready; simulate mode just logs. */
export function installPendingUpdate(): void {
  if (!downloadedVersion) return;
  if (!app.isPackaged) {
    console.log('[updater] simulated install requested for', downloadedVersion);
    return;
  }
  installRequested = true;
  // Off the IPC stack so the sender's window can close cleanly first.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}
