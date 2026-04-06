import { type RefObject, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getShortcutLabel, type Platform } from '../hooks/usePlatform';
import SearchIcon from './SearchIcon';
import SearchInput from './SearchInput';

export default function SearchBar({
  search,
  isStuck,
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
  const portalRef = useRef<Element | null>(null);
  if (!portalRef.current && typeof document !== 'undefined') {
    portalRef.current = document.getElementById('header-pill-portal');
  }
  const portalTarget = portalRef.current;

  useEffect(() => {
    if (showPill) {
      // Focus the pill so the page retains focus and keyboard shortcuts work
      const pill = portalTarget?.querySelector('button');
      pill?.focus({ preventScroll: true });
    }
  }, [showPill, portalTarget]);

  // When the input is open via pill click while scrolled, dismiss on scroll
  useEffect(() => {
    if (!isStuck || !pillClicked) return;
    const onScroll = () => {
      inputRef.current?.blur();
      onBlur();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [isStuck, pillClicked, inputRef, onBlur]);

  return (
    <div className="relative">
      {/* Input — fades out when pill shows */}
      <div
        className="transition-opacity duration-300"
        style={{
          opacity: showPill ? 0 : 1,
          pointerEvents: showPill ? 'none' : 'auto',
        }}
      >
        <SearchInput
          inputRef={inputRef}
          autoFocus={!isStuck && search.length < 3}
          focus={pillClicked}
          defaultValue={search}
          onChange={onSearch}
          onBlur={isStuck ? onBlur : undefined}
          placeholder={
            shortcut ? `search company... (${shortcut})` : 'search company...'
          }
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
