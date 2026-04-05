import { memo, useEffect, useRef } from 'react';
import styles from './SearchInput.module.css';

export default memo(function SearchInput({
  defaultValue,
  onChange,
  onBlur,
  placeholder,
  autoFocus,
  focus,
}: {
  defaultValue: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  focus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
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

  // Only run on mount or when pill is clicked — not on every refocus
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

  useEffect(() => {
    const el = inputRef.current;
    if (!el || !focus) return;
    el.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [focus]);

  return (
    <div className="relative" style={{ transform: 'translateZ(0)' }}>
      <input
        ref={inputRef}
        type="text"
        defaultValue={defaultValue}
        onInput={() => {
          syncClearButton();
          syncSearchButton();
          onChangeRef.current(inputRef.current?.value ?? '');
        }}
        onBlur={onBlur}
        placeholder={placeholder}
        className={`relative w-full rounded-lg border border-(--sea-ink-soft)/20 bg-(--bg-base)/80 px-4 py-3 pr-10 text-lg text-(--sea-ink) placeholder:text-(--sea-ink-soft)/50 focus:border-(--sea-ink-soft)/40 focus:outline-none focus:ring-0 ${styles.input}`}
      />
      {/* Clear button — visible when text exists */}
      <button
        ref={clearRef}
        type="button"
        style={{ display: defaultValue ? '' : 'none' }}
        onClick={() => {
          if (inputRef.current) inputRef.current.value = '';
          onChangeRef.current('');
          syncClearButton();
          syncSearchButton();
        }}
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
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="h-3.5 w-3.5"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clipRule="evenodd"
          />
        </svg>
        search
      </button>
    </div>
  );
});
