import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// Subscribes to a channel and returns an unsubscribe fn (so React effects clean up).
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Bridges the title-bar renderer to the main process: nav actions out, state in.
contextBridge.exposeInMainWorld('titlebar', {
  back: () => ipcRenderer.send('titlebar:nav', 'back'),
  forward: () => ipcRenderer.send('titlebar:nav', 'forward'),
  ready: () => ipcRenderer.send('titlebar:ready'),
  onNavState: (
    cb: (s: { canGoBack: boolean; canGoForward: boolean }) => void,
  ) => subscribe('titlebar:navstate', cb),
  onTitle: (cb: (t: string) => void) => subscribe('titlebar:title', cb),
  onTheme: (cb: (t: { dark: boolean; mode: string }) => void) =>
    subscribe('titlebar:theme', cb),
  onCursor: (cb: (on: boolean) => void) => subscribe('titlebar:cursor', cb),
  onCopied: (cb: () => void) => subscribe('titlebar:copied', () => cb()),
  command: (cmd: string) => ipcRenderer.send('titlebar:command', cmd),
  // Bar view reports which arrow is hovered (+ its x); the tooltip view receives what to show.
  hoverNav: (payload: { kind: string; x: number } | null) =>
    ipcRenderer.send('titlebar:hover-nav', payload),
  onNavTooltip: (cb: (payload: { kind: string } | null) => void) =>
    subscribe('tooltip:nav', cb),
  // Window chrome: which OS we're on, the custom min/max/close actions, and maximise state.
  platform: process.platform,
  windowControl: (action: string) =>
    ipcRenderer.send('titlebar:window-control', action),
  onMaximized: (cb: (max: boolean) => void) =>
    subscribe('titlebar:maximized', cb),
});
