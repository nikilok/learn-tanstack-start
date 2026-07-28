import { app, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';

import { APP_VERSION_HEADER } from './feed';
import { isNewer } from './version';

// Long-running apps re-check on this cadence; the launch check fires immediately.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** How a ready update is applied: quit+install (self-updating builds), or open /download (Linux .deb/.rpm, which electron-updater can't replace in place). */
export type UpdateMode = 'install' | 'download';

/** A ready update: a downloaded one to restart into, or (Linux .deb/.rpm) a newer version to fetch by hand. */
export interface PendingUpdate {
  version: string;
  mode: UpdateMode;
}

let pending: PendingUpdate | null = null;
let feedBase = ''; // <appUrl>/downloads/latest — set in initAutoUpdates
let downloadUrl = ''; // <appUrl>/download — set in initAutoUpdates
let installRequested = false; // install failures only surface via the 'error' event

/** The pending update, if any — single source of truth for the toast and its action. */
export function getPendingUpdate(): PendingUpdate | null {
  return pending;
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

/** Opens the /download page in the user's browser (the Linux manual-update action); surfaces a launch failure so a dropped promise never leaves the user with a dismissed toast and no browser. */
function openDownloadPage(): void {
  void shell
    .openExternal(downloadUrl)
    .catch((err) =>
      showDialog(
        'error',
        'Could not open your browser',
        `Visit ${downloadUrl} to download the latest version.\n\n${errorDetail(err)}`,
      ),
    );
}

/** The dev update-simulation value ("0"/"false" count as off); returns the raw value so 'download' can pick the manual-download variant. */
function simulateUpdateValue(): string | null {
  const value = process.env.DESKTOP_SIMULATE_UPDATE;
  return value && value !== '0' && value !== 'false' ? value : null;
}

/** True on a Linux install electron-updater can't replace in place (.deb/.rpm — no AppImage to swap; detected via the AppImage-only APPIMAGE env). */
function isManualUpdateLinux(): boolean {
  return process.platform === 'linux' && !process.env.APPIMAGE;
}

/** deb/rpm can't self-update, so read the feed version directly and, if newer, offer a manual-download toast instead of failing silently. Sets `pending` and notifies on a hit; logs (never throws) on any miss so a stuck check is diagnosable. */
async function checkManualUpdate(
  onUpdateReady: (u: PendingUpdate) => void,
): Promise<void> {
  try {
    const res = await fetch(`${feedBase}/latest-linux.yml`, {
      cache: 'no-store',
      // Explicit app UA (no 'Electron' token) so the feed request is a known-good identity, not a bot suspect.
      headers: {
        'User-Agent': `SponsorSearchDesktop/${app.getVersion()}`,
        [APP_VERSION_HEADER]: app.getVersion(),
      },
    });
    if (!res.ok) {
      console.error('[updater] linux feed check failed:', res.status);
      return;
    }
    const version = (await res.text()).match(/^version:\s*(.+)$/m)?.[1]?.trim();
    if (!version) {
      console.error('[updater] linux feed: no version field');
      return;
    }
    if (isNewer(version, app.getVersion())) {
      pending = { version, mode: 'download' };
      onUpdateReady(pending);
    }
  } catch (err) {
    console.error('[updater]', err);
  }
}

/** Starts background update checks (launch + every 4h). On deb/rpm Linux — which can't self-update — it offers a manual-download toast instead. Packaged builds only. */
export function initAutoUpdates(
  appUrl: string,
  onUpdateReady: (update: PendingUpdate) => void,
): void {
  feedBase = `${appUrl}/downloads/latest`;
  downloadUrl = `${appUrl}/download`;

  if (!app.isPackaged) {
    // Dev affordance: the toast is otherwise unreachable in dev (updates need a
    // packaged build). DESKTOP_SIMULATE_UPDATE=download exercises the Linux variant.
    const sim = simulateUpdateValue();
    if (sim) {
      const mode: UpdateMode = sim === 'download' ? 'download' : 'install';
      setTimeout(() => {
        pending = { version: '9.9.9-dev', mode };
        onUpdateReady(pending);
      }, 2000);
    }
    return;
  }

  // deb/rpm Linux can't be replaced in place -> notify + point at /download rather than silent-fail.
  if (isManualUpdateLinux()) {
    void checkManualUpdate(onUpdateReady);
    setInterval(() => void checkManualUpdate(onUpdateReady), CHECK_INTERVAL_MS);
    return;
  }

  // Every feed request (poll and installer fetch) then carries the version being
  // updated from, which is what makes an update distinguishable from a download
  // in the server logs. Merged with electron-updater's own headers, so the
  // 'electron-builder' UA the feed keys on is unchanged.
  autoUpdater.requestHeaders = {
    ...autoUpdater.requestHeaders,
    [APP_VERSION_HEADER]: app.getVersion(),
  };

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
    pending = { version: info.version, mode: 'install' };
    onUpdateReady(pending);
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

/** Menu-triggered check: like the background check, but reports the outcome in a dialog. (macOS only in practice — Win/Linux have no menu bar; the Linux branch is defensive.) */
export async function checkForUpdatesFromMenu(): Promise<void> {
  if (!app.isPackaged) {
    showDialog('info', 'Updates are not supported in this build.');
    return;
  }
  // deb/rpm Linux must never engage electron-updater's package path (it would download a
  // .deb and arm a privileged install on quit); re-check by hand and offer /download.
  if (isManualUpdateLinux()) {
    if (!pending) await checkManualUpdate(() => {});
    if (pending) openDownloadPage();
    else
      showDialog(
        'info',
        'You are up to date',
        `SponsorSearch ${app.getVersion()} is the latest version.`,
      );
    return;
  }
  // Already have a downloaded update -> offer the restart directly.
  if (pending) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `Version ${pending.version} is ready to install`,
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

/** Acts on the pending update: restart into a downloaded one, or open /download for a Linux manual update. No-op until one is ready; unpackaged (dev/simulate) just logs, so no real action fires in dev. */
export function installPendingUpdate(): void {
  if (!pending) return;
  if (!app.isPackaged) {
    console.log('[updater] simulated update requested for', pending.version);
    return;
  }
  if (pending.mode === 'download') {
    openDownloadPage();
    return;
  }
  installRequested = true;
  // Off the IPC stack so the sender's window can close cleanly first.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}
