import { app, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';

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

/** The dev update-simulation value ("0"/"false" count as off); returns the raw value so 'download' can pick the manual-download variant. */
function simulateUpdateValue(): string | null {
  const value = process.env.DESKTOP_SIMULATE_UPDATE;
  return value && value !== '0' && value !== 'false' ? value : null;
}

/** True on a Linux install electron-updater can't replace in place (.deb/.rpm — no AppImage to swap; detected via the AppImage-only APPIMAGE env). */
function isManualUpdateLinux(): boolean {
  return process.platform === 'linux' && !process.env.APPIMAGE;
}

/** Numeric x.y.z compare — true when `feed` is a higher version than `current` (pre-release suffixes ignored; our releases are always clean). */
function isNewer(feed: string, current: string): boolean {
  const f = feed.split('-')[0].split('.').map(Number);
  const c = current.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = f[i] ?? 0;
    const b = c[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** deb/rpm can't self-update, so read the feed version directly and, if newer, offer a manual-download toast instead of failing silently. */
async function checkManualUpdate(
  onUpdateReady: (u: PendingUpdate) => void,
): Promise<void> {
  try {
    const res = await fetch(`${feedBase}/latest-linux.yml`, {
      cache: 'no-store',
    });
    if (!res.ok) return;
    const version = (await res.text()).match(/^version:\s*(.+)$/m)?.[1]?.trim();
    if (version && isNewer(version, app.getVersion())) {
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

/** Menu-triggered check: like the background check, but reports the outcome in a dialog. (macOS only — Win/Linux have no menu bar.) */
export async function checkForUpdatesFromMenu(): Promise<void> {
  if (!app.isPackaged) {
    showDialog('info', 'Updates are not supported in this build.');
    return;
  }
  // Already have a pending update -> act on it directly.
  if (pending) {
    if (pending.mode === 'download') {
      void shell.openExternal(downloadUrl);
      return;
    }
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

/** Acts on the pending update: restart into a downloaded one, or open /download for a Linux manual update. No-op until one is ready; simulate mode just logs. */
export function installPendingUpdate(): void {
  if (!pending) return;
  if (pending.mode === 'download') {
    void shell.openExternal(downloadUrl);
    return;
  }
  if (!app.isPackaged) {
    console.log('[updater] simulated install requested for', pending.version);
    return;
  }
  installRequested = true;
  // Off the IPC stack so the sender's window can close cleanly first.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}
