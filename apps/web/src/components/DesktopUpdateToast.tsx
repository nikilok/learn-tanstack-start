import { RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';

// Session-scoped: a dismissed version stays hidden across hard reloads (the
// shell re-offers a pending update on every full document load).
const DISMISS_KEY = 'desktop-update-dismissed';

/**
 * Desktop-only toast (bottom-left) shown when the Electron shell has a new
 * version downloaded and ready; clicking it restarts into the update. On the
 * web and on older shells without the update bridge only the (invisible) live
 * region renders — it must pre-exist for the announcement to fire.
 */
export default function DesktopUpdateToast() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    return window.ssDesktop?.onUpdateReady?.((v) => {
      if (window.sessionStorage.getItem(DISMISS_KEY) !== v) setVersion(v);
    });
  }, []);

  return (
    // Persistent live region so the toast's arrival is announced to assistive tech.
    <div role="status" className="fixed bottom-4 left-4 z-50">
      {version && (
        // Install and Dismiss are sibling native buttons: nesting either inside
        // the other is invalid (interactive content within a button role).
        <div className="relative w-64 animate-[update-toast-in_240ms_ease-out] rounded-xl border border-(--line) bg-(--bg-base) shadow-lg transition-shadow duration-200 hover:shadow-xl">
          <button
            type="button"
            aria-label={`Update available — restart to install v${version}`}
            title={`Restart to install v${version}`}
            className="w-full cursor-pointer rounded-xl px-4 py-3 text-left"
            onClick={() => window.ssDesktop?.installUpdate?.()}
          >
            <span className="block text-sm font-semibold">
              Update available
            </span>
            <span className="mt-1 flex items-center gap-2">
              <RefreshCw size={13} className="shrink-0 text-(--logo-red)" />
              <span className="truncate text-xs opacity-70">
                Click to update to v{version}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            className="absolute top-3 right-4 grid size-5 cursor-pointer place-items-center rounded opacity-50 transition-opacity hover:opacity-100"
            onClick={() => {
              window.sessionStorage.setItem(DISMISS_KEY, version);
              setVersion(null);
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
