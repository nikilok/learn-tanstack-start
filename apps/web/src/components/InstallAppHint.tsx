import { useCallback, useEffect, useState } from 'react';

import styles from './InstallAppHint.module.css';

const DISMISS_KEY = 'ss-install-hint-dismissed';
const INSTALLED_MODES = [
  'standalone',
  'minimal-ui',
  'fullscreen',
  'window-controls-overlay',
];

/** Chrome's deferred install prompt — not in the standard DOM lib types. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Captured at module load (earliest possible) — the event fires before React
// mounts. We stash it and notify any listening component via a custom event.
let deferredPrompt: BeforeInstallPromptEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    window.dispatchEvent(new Event('ss:installable'));
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
  });
}

/** True when running as an installed app, where there's nothing to install. */
function isInstalledApp() {
  return (
    INSTALLED_MODES.some(
      (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
    ) || (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Desktop-Chrome install card. Driven by `beforeinstallprompt` (needs the
 * service worker), so it only appears when Chrome actually considers the app
 * installable — its "Install app" button opens Chrome's native install dialog.
 * Never shown inside the installed app, on mobile, or once dismissed.
 */
export default function InstallAppHint() {
  const [show, setShow] = useState(false);

  /** Hide for good and remember the choice. */
  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage unavailable (private mode) — fall back to in-memory hide */
    }
    setShow(false);
  }, []);

  /** Open Chrome's native install dialog, then retire the card. */
  const install = useCallback(async () => {
    const prompt = deferredPrompt;
    deferredPrompt = null;
    dismiss();
    if (prompt) {
      try {
        await prompt.prompt();
      } catch {
        /* prompt can only be called once; ignore re-invocation errors */
      }
    }
  }, [dismiss]);

  // Register the service worker (enables the install prompt + offline fallback).
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* registration is best-effort; the page works fine without it */
      });
    }
  }, []);

  useEffect(() => {
    if (isInstalledApp()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch {
      /* ignore storage errors and continue */
    }

    // Desktop Chrome only — the card is a desktop-corner affordance.
    const isChrome = document.documentElement.dataset.browser === 'chrome';
    const isMobile =
      (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
        .userAgentData?.mobile ??
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (!isChrome || isMobile) return;

    const reveal = () => {
      if (deferredPrompt && !isInstalledApp()) setShow(true);
    };
    reveal(); // in case the prompt fired before this mounted
    window.addEventListener('ss:installable', reveal);
    window.addEventListener('appinstalled', dismiss);
    return () => {
      window.removeEventListener('ss:installable', reveal);
      window.removeEventListener('appinstalled', dismiss);
    };
  }, [dismiss]);

  if (!show) return null;

  return (
    <aside className={styles.card} aria-label="Install SponsorSearch as an app">
      <button
        type="button"
        className={styles.close}
        onClick={dismiss}
        aria-label="Dismiss"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6 18 18 M18 6 6 18" />
        </svg>
      </button>

      <div className={styles.head}>
        <span className={styles.tile} aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21 16 16" />
          </svg>
        </span>
        <span className={styles.eyebrow}>Install app</span>
        <h2 className={styles.title}>Add SponsorSearch to your desktop</h2>
      </div>

      <p className={styles.body}>
        Launch it in its own window and keep 126K+ sponsors one click away.
      </p>

      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={install}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="M7 11 12 16 17 11" />
            <path d="M5 20h14" />
          </svg>
          Install app
        </button>
        <button type="button" className={styles.secondary} onClick={dismiss}>
          Not now
        </button>
      </div>
    </aside>
  );
}
