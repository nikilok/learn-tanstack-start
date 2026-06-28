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

type InstallPromptWindow = Window & {
  __ssInstallPrompt?: BeforeInstallPromptEvent | null;
};

/** The deferred prompt captured pre-hydration by INSTALL_PROMPT_INIT_SCRIPT. */
function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return (window as InstallPromptWindow).__ssInstallPrompt ?? null;
}

/** True when running inside the installed app (standalone display modes). */
function isStandalone() {
  return (
    INSTALLED_MODES.some(
      (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
    ) || (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Low-weight install chip for the footer. Shown only once Chrome has offered an
 * install (the deferred `beforeinstallprompt`, captured pre-hydration), which
 * guarantees the click can open the native install dialog. Chrome doesn't offer
 * one for an already-installed app, so installed users never see it. Hidden on
 * mobile, in the installed app, and once dismissed.
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

  /** Open Chrome's native install dialog, then retire the chip. */
  const install = useCallback(async () => {
    const prompt = getInstallPrompt();
    if (!prompt) return; // no prompt in hand — nothing to open
    (window as InstallPromptWindow).__ssInstallPrompt = null;
    dismiss();
    try {
      await prompt.prompt();
    } catch {
      /* prompt can only be called once; ignore re-invocation errors */
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
    if (isStandalone()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch {
      /* ignore storage errors and continue */
    }

    // Desktop Chrome only — the chip is a desktop footer affordance.
    const isChrome = document.documentElement.dataset.browser === 'chrome';
    const isMobile =
      (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
        .userAgentData?.mobile ??
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (!isChrome || isMobile) return;

    // Reveal once a real prompt exists (the inline script may have captured it
    // before this mounted, or it arrives later via the custom event).
    const reveal = () => {
      if (getInstallPrompt()) setShow(true);
    };
    reveal();
    window.addEventListener('ss:installable', reveal);
    window.addEventListener('ss:installed', dismiss);
    return () => {
      window.removeEventListener('ss:installable', reveal);
      window.removeEventListener('ss:installed', dismiss);
    };
  }, [dismiss]);

  if (!show) return null;

  return (
    <div className={styles.chip}>
      <button
        type="button"
        className={styles.action}
        onClick={install}
        aria-label="Install SponsorSearch as an app"
      >
        <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12" />
          <path d="M7 11 12 16 17 11" />
          <path d="M5 20h14" />
        </svg>
        Install app
      </button>
      <button
        type="button"
        className={styles.dismiss}
        onClick={dismiss}
        aria-label="Dismiss install suggestion"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6 18 18 M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
