import { useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { useIsMac } from '../hooks/useIsMac';
import { useShortcut } from '../hooks/useShortcut';
import { buildCanonical } from '../utils/canonical';
import { HEADER_CONTROL_CLASS } from './headerControls';
import { ariaKeyShortcuts } from './headerShortcuts';
import HeaderTooltip from './HeaderTooltip';
import ShareIcon from './ShareIcon';

// Stable so the tooltip doesn't allocate a new style object each render; both
// prefixes because .glass deliberately disables backdrop-filter (incl. -webkit-).
const TOOLTIP_BLUR = {
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

/**
 * Header action that shares the current page: the native share sheet when the
 * Web Share API exists, else a clipboard copy confirmed by a brief tooltip.
 * Visible on mobile and desktop alike (not pointer-fine gated).
 */
export default function ShareButton() {
  const [copied, setCopied] = useState(false);
  const isMac = useIsMac();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read the URL lazily at click time (no nav-time re-render); router is the source of truth.
  const router = useRouter();

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  /** Native share sheet when available, else copy the URL and flash the tooltip. */
  async function handleShare() {
    const { pathname, search } = router.state.location;
    const shareUrl = buildCanonical(pathname, search as Record<string, string>);

    // With Web Share the sheet is the whole UX — a cancel/error must not silently fall back to copying.
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, url: shareUrl });
      } catch {
        /* sheet cancelled or share failed */
      }
      return;
    }

    // No Web Share (desktop): copy and confirm; skip silently if the Clipboard API is absent too.
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked / denied */
    }
  }

  // The keydown is a user gesture, so the share sheet / clipboard write is allowed.
  useShortcut('share', () => {
    void handleShare();
  });

  return (
    <div className="relative flex">
      {/* The pointer is still on the button after a copy, so the chip yields to the toast.
          Pinned end-aligned to keep their right edges shared — a centred chip would hand
          over to a toast 31px to its left. */}
      <HeaderTooltip
        label="Share"
        shortcut="share"
        align="end"
        suppressed={copied}
        className="inline-flex"
      >
        <button
          type="button"
          onClick={handleShare}
          aria-label="Share this page"
          aria-keyshortcuts={ariaKeyShortcuts('share', isMac)}
          className={HEADER_CONTROL_CLASS}
        >
          <ShareIcon />
        </button>
      </HeaderTooltip>
      {/* Always mounted so the live region announces the copy; non-interactive so it never eats taps below. */}
      <span
        role="status"
        className={`glass pointer-events-none absolute top-full right-0 z-50 mt-2 rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap text-(--sea-ink) shadow-lg transition-opacity ${copied ? 'opacity-100' : 'opacity-0'}`}
        style={TOOLTIP_BLUR}
      >
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </div>
  );
}
