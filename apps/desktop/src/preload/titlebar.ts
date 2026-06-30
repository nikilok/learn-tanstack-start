import { contextBridge, ipcRenderer } from 'electron';

// Bridges the title-bar renderer to the main process: nav actions out, state in.
contextBridge.exposeInMainWorld('titlebar', {
  back: () => ipcRenderer.send('titlebar:nav', 'back'),
  forward: () => ipcRenderer.send('titlebar:nav', 'forward'),
  ready: () => ipcRenderer.send('titlebar:ready'),
  onNavState: (
    cb: (s: { canGoBack: boolean; canGoForward: boolean }) => void,
  ) => ipcRenderer.on('titlebar:navstate', (_e, s) => cb(s)),
  onTitle: (cb: (t: string) => void) =>
    ipcRenderer.on('titlebar:title', (_e, t) => cb(t)),
  onTheme: (cb: (t: { dark: boolean }) => void) =>
    ipcRenderer.on('titlebar:theme', (_e, t) => cb(t)),
});
