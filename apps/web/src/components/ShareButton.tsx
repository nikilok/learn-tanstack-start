import { useLocation } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { buildCanonical } from '../utils/canonical';
import ShareIcon from './ShareIcon';

/**
 * Header action that shares the current page. Opens the native share sheet when
 * the browser supports the Web Share API (iOS/Android, some desktop browsers),
 * and otherwise copies the canonical URL to the clipboard — confirming with a
 * brief tooltip. Unlike the cursor toggle it isn't gated to pointer-fine
 * devices, so it stays visible on mobile and desktop alike.
 */
export default function ShareButton() {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The router is the source of truth for the current URL. Selecting the
  // canonical (prod-origin) share URL keeps the query string the app actually
  // validated — not whatever raw params sit in the address bar — and re-renders
  // only when that URL changes.
  const shareUrl = useLocation({
    select: (l) => buildCanonical(l.pathname, l.search as Record<string, string>),
  });

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  /** Native share sheet when available, else copy the URL and flash the tooltip. */
  async function handleShare() {
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, url: shareUrl });
        return;
      } catch (err) {
        // Sheet dismissed by the user is not a failure — only fall through to
        // the clipboard path on a genuine error.
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked (insecure context / denied) — nothing to confirm.
    }
  }

  return (
    <div className="relative flex">
      <button
        type="button"
        onClick={handleShare}
        aria-label="Share this page"
        title="Share this page"
        className="shadow-ring rounded-md p-2 text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink)"
      >
        <ShareIcon />
      </button>
      {copied && (
        <span
          role="status"
          className="glass absolute top-full right-0 z-50 mt-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium text-(--sea-ink) shadow-lg"
          style={{ backdropFilter: 'blur(8px)' }}
        >
          Copied to clipboard
        </span>
      )}
    </div>
  );
}
