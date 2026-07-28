import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getShortcutLabel, type Platform } from '../hooks/usePlatform';
import { useRotatingPlaceholder } from '../hooks/useRotatingPlaceholder';
import { shouldAutoFocusSearch } from '../lib/search/autofocus';
import { loadStoredFilters } from '../lib/search/persist';
import { isDesktopPreview } from '../utils/desktop-preview';
import SearchIcon from './SearchIcon';
import SearchInput from './SearchInput';

import styles from './SearchBar.module.css';

/**
 * Search UI that swaps between an inline input and a compact header pill as the
 * user scrolls. The pill is portaled into `#header-pill-portal` so it visually
 * lives in the sticky header while staying owned by this component. Hides the
 * input until `ready` to avoid first-paint flashes, and auto-dismisses the
 * expanded input on deliberate scroll (>100px from the anchor) while the pill
 * is clicked open. In filter mode the pill also shows with an EMPTY search —
 * scrolling a nameless filtered listing collapses the input to a pill with a
 * blinking I-beam, so a phrase can still be typed on top of the filters
 * (classic mode never reaches stuck-while-empty: that state is the hero page).
 * Autofocus is the hero's alone — `shouldAutoFocusSearch` holds the rules.
 */
export default function SearchBar({
  search,
  isStuck,
  ready,
  pillClicked,
  filtersActive = false,
  inputRef,
  platform,
  isMobile,
  onSearch,
  onPillClick,
  onBlur,
}: {
  search: string;
  isStuck: boolean;
  ready: boolean;
  pillClicked: boolean;
  filtersActive?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  platform: Platform;
  isMobile: boolean;
  onSearch: (value: string) => void;
  onPillClick: () => void;
  onBlur: () => void;
}) {
  const showPill = isStuck && !pillClicked && (!!search || filtersActive);
  // Read the store rather than trusting `filtersActive`: on the hydration mount
  // that prop is false for SSR parity and the rehydrate navigate lands one
  // effect too late — SearchInput's focus effect has already run by then.
  const [storedFilterMode] = useState(() => loadStoredFilters() != null);
  const shortcut = isMobile ? '' : getShortcutLabel(platform);
  const placeholder = useRotatingPlaceholder(shortcut, !!search);
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  useEffect(() => {
    setPortalTarget(document.getElementById('header-pill-portal'));
  }, []);

  useEffect(() => {
    if (showPill) {
      // Focus the pill so the page retains focus and keyboard shortcuts work
      const pill = portalTarget?.querySelector('button');
      pill?.focus({ preventScroll: true });
    }
  }, [showPill, portalTarget]);

  // When the input is open via pill click while scrolled, dismiss on deliberate scroll
  // Re-anchors startY when search changes so content-driven scroll shifts don't trigger dismiss
  const scrollAnchorRef = useRef(0);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-anchor scroll baseline when search changes
  useEffect(() => {
    scrollAnchorRef.current = window.scrollY;
  }, [search]);

  useEffect(() => {
    if (!isStuck || !pillClicked) return;
    scrollAnchorRef.current = window.scrollY;
    const onScroll = () => {
      if (Math.abs(window.scrollY - scrollAnchorRef.current) > 100) {
        inputRef.current?.blur();
        onBlur();
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [isStuck, pillClicked, inputRef, onBlur]);

  return (
    <div className="relative">
      {/* Input — hidden until observer ready, hides when pill shows */}
      <div
        className="search-input-wrapper"
        style={{
          opacity: !ready || showPill ? 0 : 1,
          pointerEvents: !ready || showPill ? 'none' : 'auto',
        }}
      >
        <SearchInput
          inputRef={inputRef}
          autoFocus={shouldAutoFocusSearch({
            isStuck,
            search,
            filterMode: filtersActive || storedFilterMode,
            isPreview: isDesktopPreview(),
          })}
          focus={pillClicked}
          defaultValue={search}
          onChange={onSearch}
          onBlur={isStuck ? onBlur : undefined}
          placeholder={placeholder}
        />
      </div>

      {/* Pill — portaled into the header */}
      {portalTarget &&
        createPortal(
          <div
            className="min-w-0"
            style={{
              transition: 'opacity 200ms ease-out',
              opacity: showPill ? 1 : 0,
              pointerEvents: showPill ? 'auto' : 'none',
            }}
          >
            <button
              type="button"
              onClick={onPillClick}
              aria-label={
                search
                  ? `Edit search for ${search}`
                  : 'Search within the filtered list'
              }
              className="inline-flex max-w-full items-center gap-2 rounded-full bg-(--sea-ink) px-3.5 py-1.5 text-sm text-(--surface) transition hover:opacity-85 focus:outline-none"
            >
              {search ? (
                <span className="truncate">{search}</span>
              ) : (
                <span className={styles.caret} aria-hidden="true" />
              )}
              <SearchIcon className="h-3 w-3 shrink-0 opacity-60" />
            </button>
          </div>,
          portalTarget,
        )}
    </div>
  );
}
