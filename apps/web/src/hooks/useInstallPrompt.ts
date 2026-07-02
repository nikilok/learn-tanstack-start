import { useCallback, useEffect, useState } from 'react';

import { parsePlatform } from './usePlatform';

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
 * Shared PWA-install state: whether a desktop Chromium install is currently on
 * offer (deferred prompt captured pre-hydration), plus a one-shot `install`
 * that opens the browser's native install dialog. Consumed by the header hint
 * and the /download Chrome-app card so they share one source of truth.
 */
export function useInstallPrompt(): {
  installable: boolean;
  install: () => Promise<void>;
} {
  const [installable, setInstallable] = useState(false);

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
      setInstallable(false);
    }
  }, []);

  useEffect(() => {
    // Desktop only — mobile gets the browser's own native install UI. The
    // captured prompt already limits this to Chromium that can actually install.
    const isMobile =
      (navigator as Navigator & { userAgentData?: { mobile?: boolean } })
        .userAgentData?.mobile ?? parsePlatform(navigator.userAgent).isMobile;
    if (isMobile) return;

    const reveal = () => {
      if (getInstallPrompt()) setInstallable(true);
    };
    const hide = () => setInstallable(false);
    reveal(); // the inline script may have captured the prompt before this mounted
    window.addEventListener('ss:installable', reveal);
    window.addEventListener('ss:installed', hide);
    return () => {
      window.removeEventListener('ss:installable', reveal);
      window.removeEventListener('ss:installed', hide);
    };
  }, []);

  return { installable, install };
}
