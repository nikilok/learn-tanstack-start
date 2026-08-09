import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import type { BlockState } from '../shared/blocked';

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
  onFilters: (cb: (count: number) => void) => subscribe('titlebar:filters', cb),
  onCopied: (cb: () => void) => subscribe('titlebar:copied', () => cb()),
  // The page's screensaver has taken the window — fade the chrome out of its way.
  onScreenSaver: (cb: (on: boolean) => void) =>
    subscribe('titlebar:screensaver', cb),
  command: (cmd: string) => ipcRenderer.send('titlebar:command', cmd),
  // Bar view reports which button is hovered (+ its x); the tooltip view receives what + where to show.
  showTooltip: (payload: { kind: string; x: number } | null) =>
    ipcRenderer.send('titlebar:tooltip', payload),
  onTooltip: (cb: (payload: { kind: string; caretX: number } | null) => void) =>
    subscribe('tooltip:show', cb),
  // The launch splash: reporting its first painted frame (what the window waits for),
  // told when to finish, and reporting back once it has.
  splashPainted: () => ipcRenderer.send('splash:painted'),
  onSplashDismiss: (cb: () => void) => subscribe('splash:dismiss', () => cb()),
  splashDone: () => ipcRenderer.send('splash:done'),
  // The local stand-in screen: why it is up and when the next check runs, plus "check now".
  onBlocked: (cb: (state: BlockState | null) => void) =>
    subscribe('blocked:state', cb),
  retryBlocked: () => ipcRenderer.send('blocked:retry'),
  // Reported once the stand-in screen has a frame on the glass, so the launch splash knows
  // there is something behind it to hand over to.
  blockedPainted: () => ipcRenderer.send('blocked:painted'),
  // Window chrome: which OS we're on, the custom min/max/close actions, and maximise state.
  platform: process.platform,
  windowControl: (action: string) =>
    ipcRenderer.send('titlebar:window-control', action),
  onMaximized: (cb: (max: boolean) => void) =>
    subscribe('titlebar:maximized', cb),
});
