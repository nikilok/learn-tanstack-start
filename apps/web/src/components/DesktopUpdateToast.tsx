import { Download, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';

// Session-scoped: a dismissed version stays hidden across hard reloads (the
// shell re-offers a pending update on every full document load).
const DISMISS_KEY = 'desktop-update-dismissed';

/**
 * Desktop-only toast (bottom-left) shown when the Electron shell has an update
 * ready. Two shapes: a downloaded update (Mac/Win/AppImage) that restarts into
 * itself on click, or a Linux .deb/.rpm "manual" update that opens /download —
 * electron-updater can't replace a package-manager install in place. On the web
 * and on older shells without the update bridge only the (invisible) live region
 * renders — it must pre-exist for the announcement to fire.
 */
export default function DesktopUpdateToast() {
  const [version, setVersion] = useState<string | null>(null);
  const [mode, setMode] = useState<'install' | 'download'>('install');

  useEffect(() => {
    return window.ssDesktop?.onUpdateReady?.((payload) => {
      // Older shells send a bare version string (install); newer ones send { version, mode }.
      const v = typeof payload === 'string' ? payload : payload.version;
      const m = typeof payload === 'string' ? 'install' : payload.mode;
      if (window.sessionStorage.getItem(DISMISS_KEY) !== v) {
        setVersion(v);
        setMode(m);
      }
    });
  }, []);

  const dismiss = () => {
    if (version) window.sessionStorage.setItem(DISMISS_KEY, version);
    setVersion(null);
  };

  const isDownload = mode === 'download';
  const Icon = isDownload ? Download : RefreshCw;
  const label = isDownload
    ? `Click to download v${version}`
    : `Click to update to v${version}`;
  const title = isDownload
    ? `Download v${version}`
    : `Restart to install v${version}`;
  const aria = isDownload
    ? `Update available — download v${version}`
    : `Update available — restart to install v${version}`;

  return (
    // Persistent live region so the toast's arrival is announced to assistive tech.
    <div role="status" className="fixed bottom-4 left-4 z-50">
      {version && (
        // Action and Dismiss are sibling native buttons: nesting either inside
        // the other is invalid (interactive content within a button role).
        <div className="relative w-64 animate-[update-toast-in_240ms_ease-out] rounded-xl border border-(--line) bg-(--bg-base) shadow-lg transition-shadow duration-200 hover:shadow-xl">
          <button
            type="button"
            aria-label={aria}
            title={title}
            className="w-full cursor-pointer rounded-xl px-4 py-3 text-left"
            onClick={() => {
              window.ssDesktop?.installUpdate?.();
              // Download opens an external tab and the app keeps running, so dismiss the
              // toast here; the install variant quits the app, making its removal moot.
              if (isDownload) dismiss();
            }}
          >
            <span className="block text-sm font-semibold">
              Update available
            </span>
            <span className="mt-1 flex items-center gap-2">
              <Icon size={13} className="shrink-0 text-(--logo-red)" />
              <span className="truncate text-xs opacity-70">{label}</span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            className="absolute top-3 right-4 grid size-5 cursor-pointer place-items-center rounded opacity-50 transition-opacity hover:opacity-100"
            onClick={dismiss}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
