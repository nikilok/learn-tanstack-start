import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getShortcutLabel, type Platform } from '../hooks/usePlatform';
import { useRotatingPlaceholder } from '../hooks/useRotatingPlaceholder';
import SearchIcon from './SearchIcon';
import SearchInput from './SearchInput';

export default function SearchBar({
  search,
  isStuck,
  ready,
  pillClicked,
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
  inputRef: RefObject<HTMLInputElement | null>;
  platform: Platform;
  isMobile: boolean;
  onSearch: (value: string) => void;
  onPillClick: () => void;
  onBlur: () => void;
}) {
  const showPill = isStuck && !pillClicked && !!search;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-anchor scroll baseline when search changes
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
      {/* Input — hides when pill shows, or briefly hidden until observer is ready (client-only) */}
      <div
        style={{
          opacity: showPill || (!ready && isStuck) ? 0 : 1,
          pointerEvents: showPill || (!ready && isStuck) ? 'none' : 'auto',
        }}
      >
        <SearchInput
          inputRef={inputRef}
          autoFocus={!isStuck && search.length < 3}
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
              aria-label={`Edit search for ${search}`}
              className="inline-flex max-w-full items-center gap-2 rounded-full bg-(--sea-ink) px-3 py-1.5 text-sm text-(--surface) transition hover:opacity-85 focus:outline-none"
            >
              <span className="truncate">{search}</span>
              <SearchIcon className="h-3 w-3 shrink-0 opacity-60" />
            </button>
          </div>,
          portalTarget,
        )}
    </div>
  );
}
