import { type RefObject, useEffect, useRef } from 'react';
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
  const pillRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (showPill) {
      // Focus the pill so the page retains focus and keyboard shortcuts work
      pillRef.current?.focus({ preventScroll: true });
    }
  }, [showPill]);

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

      {/* Pill — fades in and shrinks when stuck */}
      <div
        className="absolute left-0 top-0 origin-top-left transition-all duration-200 ease-out"
        style={{
          opacity: showPill ? 1 : 0,
          pointerEvents: showPill ? 'auto' : 'none',
          transform: showPill ? 'scale(0.65)' : 'scale(1)',
        }}
      >
        <button
          ref={pillRef}
          type="button"
          onClick={onPillClick}
          className="inline-flex items-center gap-3 whitespace-nowrap rounded-full bg-(--sea-ink) px-4 py-3 text-lg text-(--surface) transition hover:opacity-85"
        >
          <span className="max-w-72 truncate">{search}</span>
          <SearchIcon className="h-4 w-4 shrink-0 opacity-60" />
        </button>
      </div>
    </div>
  );
}
