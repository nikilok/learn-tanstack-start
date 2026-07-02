import { app, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import { checkForUpdatesFromMenu } from './updater';

/** Builds and installs the native application menu. */
export function setupMenu(appUrl: string): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => void checkForUpdatesFromMenu(),
        },
        { type: 'separator' },
        {
          label: 'Open SponsorSearch in Browser',
          click: () => void shell.openExternal(appUrl),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
