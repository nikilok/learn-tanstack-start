import { useCallback, useEffect, useState } from 'react';

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
 * Header "Install app" pill. Not dismissible — it simply appears when desktop
 * Chrome has offered an install (deferred prompt captured pre-hydration) and
 * disappears once the app is installed. Clicking opens the native dialog.
 */
export default function InstallAppHint() {
  const [show, setShow] = useState(false);

  /** Open Chrome's native install dialog (the prompt is one-shot). */
  const install = useCallback(async () => {
    const prompt = getInstallPrompt();
    if (!prompt) return;
    (window as InstallPromptWindow).__ssInstallPrompt = null;
    setShow(false);
    try {
      await prompt.prompt();
    } catch {
      /* prompt can only be called once; ignore re-invocation errors */
    }
  }, []);

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

    // Desktop Chrome only.
    const isChrome = document.documentElement.dataset.browser === 'chrome';
    const isMobile =
      (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
        .userAgentData?.mobile ??
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (!isChrome || isMobile) return;

    const reveal = () => {
      if (getInstallPrompt()) setShow(true);
    };
    const hide = () => setShow(false);
    reveal(); // the inline script may have captured the prompt before this mounted
    window.addEventListener('ss:installable', reveal);
    window.addEventListener('ss:installed', hide);
    return () => {
      window.removeEventListener('ss:installable', reveal);
      window.removeEventListener('ss:installed', hide);
    };
  }, []);

  if (!show) return null;

  return (
    <button
      type="button"
      onClick={install}
      aria-label="Install SponsorSearch as an app"
      title="Install SponsorSearch as an app"
      className="install-pill-in install-rainbow shadow-ring inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink)"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3v12" />
        <path d="M7 11 12 16 17 11" />
        <path d="M5 20h14" />
      </svg>
      Install app
    </button>
  );
}
