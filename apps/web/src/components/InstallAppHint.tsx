import { useCallback, useEffect, useState } from 'react';

import { parsePlatform } from '../hooks/usePlatform';

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

/**
 * Header "Install app" pill. Not dismissible — it appears once a desktop browser
 * has offered an install (deferred prompt captured pre-hydration by the Chromium-
 * gated INSTALL_PROMPT_INIT_SCRIPT) and disappears once installed. The captured
 * prompt is the sufficient gate: it's only set on Chromium and never for an
 * already-installed app. Clicking opens the browser's native install dialog.
 */
export default function InstallAppHint() {
  const [show, setShow] = useState(false);

  /** Open the browser's native install dialog (the prompt is one-shot). */
  const install = useCallback(async () => {
    const prompt = getInstallPrompt();
    if (!prompt) return;
    (window as InstallPromptWindow).__ssInstallPrompt = null;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      /* prompt can only be called once; ignore re-invocation errors */
    } finally {
      // The prompt is one-shot and now consumed; hide. On accept the app installs
      // (ss:installed also hides); on dismiss the pill returns if Chrome re-offers
      // (ss:installable). Hiding in `finally`, after the dialog, keeps the pill
      // visible while the dialog is open instead of vanishing on click.
      setShow(false);
    }
  }, []);

  useEffect(() => {
    // Desktop only — mobile gets the browser's own native install UI. The captured
    // prompt already limits this to Chromium that can actually install.
    const isMobile =
      (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
        .userAgentData?.mobile ?? parsePlatform(navigator.userAgent).isMobile;
    if (isMobile) return;

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
