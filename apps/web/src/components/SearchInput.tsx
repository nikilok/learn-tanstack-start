import type { RefObject } from 'react';
import { memo, useEffect, useRef } from 'react';
import SearchIcon from './SearchIcon';
import styles from './SearchInput.module.css';

/**
 * Uncontrolled text input with integrated clear/search affordances. Uses a ref
 * plus imperative DOM sync so parent-driven re-renders don't disrupt in-flight
 * typing; `defaultValue` only re-syncs when the input isn't focused so external
 * search-param updates apply without clobbering the user. `autoFocus` fires
 * once, while `focus` re-focuses on every truthy transition.
 */
export default memo(function SearchInput({
  inputRef,
  defaultValue,
  onChange,
  onBlur,
  placeholder,
  autoFocus,
  focus,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  defaultValue: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  focus?: boolean;
}) {
  const clearRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const hasAutoFocused = useRef(false);

  const syncClearButton = () => {
    if (clearRef.current) {
      clearRef.current.style.display = inputRef.current?.value ? '' : 'none';
    }
  };

  const syncSearchButton = () => {
    if (searchRef.current) {
      searchRef.current.style.display = inputRef.current?.value ? 'none' : '';
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (autoFocus && !hasAutoFocused.current) {
      hasAutoFocused.current = true;
      el.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  }, [autoFocus]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !focus) return;
    el.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [focus]);

  // Sync uncontrolled input when the route search param changes externally
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputRef is a stable ref
  useEffect(() => {
    const el = inputRef.current;
    if (el && el.value !== defaultValue && document.activeElement !== el) {
      el.value = defaultValue;
      syncClearButton();
      syncSearchButton();
    }
  }, [defaultValue]);

  return (
    <div className={`relative ${styles.inputWrapper}`}>
      <input
        ref={inputRef}
        type="text"
        defaultValue={defaultValue}
        onInput={() => {
          syncClearButton();
          syncSearchButton();
          onChangeRef.current(inputRef.current?.value ?? '');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') inputRef.current?.blur();
        }}
        onBlur={onBlur}
        placeholder={placeholder}
        className={`relative w-full rounded-lg border border-(--sea-ink-soft)/20 bg-(--bg-base) px-4 py-3 pr-10 text-lg text-(--sea-ink) placeholder:text-(--sea-ink-soft)/50 focus:border-(--sea-ink-soft)/40 focus:outline-none focus:ring-0 ${styles.input}`}
      />
      {/* Clear button — visible when text exists */}
      <button
        ref={clearRef}
        type="button"
        style={{ display: defaultValue ? '' : 'none' }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (inputRef.current) inputRef.current.value = '';
          onChangeRef.current('');
          syncClearButton();
          syncSearchButton();
          inputRef.current?.focus();
        }}
        aria-label="Clear search"
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-(--sea-ink-soft) transition hover:text-(--sea-ink)"
      >
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="h-5 w-5"
        >
          <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
      </button>
      {/* Search button — visible when no text */}
      <button
        ref={searchRef}
        type="button"
        style={{ display: defaultValue ? 'none' : '' }}
        onClick={() => inputRef.current?.focus()}
        className="absolute right-[8px] top-[8px] bottom-[8px] inline-flex items-center gap-1 rounded-md bg-(--sea-ink) px-3 text-sm font-medium text-(--surface) transition hover:opacity-85"
      >
        <SearchIcon className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">search</span>
      </button>
    </div>
  );
});
