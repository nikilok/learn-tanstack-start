import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

/** Checks the generic update feed (our own download API) on launch; installs on quit. Packaged builds only. */
export function initAutoUpdates(): void {
  if (!app.isPackaged) return;
  autoUpdater.on('error', (err) => console.error('[updater]', err));
  void autoUpdater
    .checkForUpdatesAndNotify()
    .catch((err) => console.error('[updater]', err));
}
