import type { RefObject } from 'react';
import { memo, useEffect, useLayoutEffect, useRef } from 'react';

import type { AskBoxMode } from '../lib/ask/session';
import SearchIcon from './SearchIcon';

import styles from './SearchInput.module.css';

/**
 * Uncontrolled text input with integrated clear/search affordances. Uses a ref
 * plus imperative DOM sync so parent-driven re-renders don't disrupt in-flight
 * typing; `defaultValue` only re-syncs when the input isn't focused so external
 * search-param updates apply without clobbering the user. `autoFocus` fires
 * once, while `focus` re-focuses on every truthy transition. Enter hands the
 * press to `onEnter` (the parent asks while it offers to, or remembers the
 * press until it does); while `askEnabled`, an arrow beside the clear button
 * hands the text to `onAsk`. `askMode` wears the spectrum ring: turning while
 * a question runs, steady while its plan is applied.
 */
export default memo(function SearchInput({
  inputRef,
  defaultValue,
  onChange,
  onBlur,
  placeholder,
  autoFocus,
  focus,
  askEnabled = false,
  askMode = 'off',
  onAsk,
  onEnter,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  defaultValue: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  focus?: boolean;
  askEnabled?: boolean;
  askMode?: AskBoxMode;
  onAsk?: () => void;
  onEnter?: () => void;
}) {
  const clearRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  const onChangeRef = useRef(onChange);
  const onAskRef = useRef(askEnabled ? onAsk : undefined);
  const onEnterRef = useRef(onEnter);
  // Synced after each commit, as React asks of a ref: a render it discards never reaches the input's handlers.
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    onAskRef.current = askEnabled ? onAsk : undefined;
    onEnterRef.current = onEnter;
  });
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
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || !focus) return;
    el.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      el.setSelectionRange(el.value.length, el.value.length);
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // Sync uncontrolled input when the route search param changes externally
  useEffect(() => {
    const el = inputRef.current;
    if (el && el.value !== defaultValue && document.activeElement !== el) {
      el.value = defaultValue;
      syncClearButton();
      syncSearchButton();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValue]);

  return (
    <div className={`relative ${styles.inputWrapper}`}>
      <input
        ref={inputRef}
        type="text"
        // Company names aren't dictionary words — stop the mobile keyboard from
        // autocorrecting/suggesting/capitalising them mid-search.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        defaultValue={defaultValue}
        onInput={() => {
          syncClearButton();
          syncSearchButton();
          onChangeRef.current(inputRef.current?.value ?? '');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') inputRef.current?.blur();
          // The listing's own handler opens a highlighted row on the same
          // key; the parent asks only while nothing is listed. Not during
          // IME composition, where Enter commits the candidate.
          else if (e.key === 'Enter' && !e.nativeEvent.isComposing)
            onEnterRef.current?.();
        }}
        onBlur={onBlur}
        placeholder={placeholder}
        className={`relative w-full rounded-lg border border-(--sea-ink-soft)/20 bg-(--bg-base) px-4 py-3 ${askEnabled ? 'pr-[4.5rem]' : 'pr-10'} text-lg text-(--sea-ink) placeholder:text-(--sea-ink-soft)/50 focus:border-(--sea-ink-soft)/40 focus:ring-0 focus:outline-none ${styles.input}`}
      />
      {/* Ask ring: turns while the question runs, holds while its plan is applied */}
      <span
        aria-hidden="true"
        className={styles.ring}
        data-ask={askMode === 'off' ? undefined : askMode}
      />
      {/* Ask button — beside the clear button while the text can be asked */}
      {askEnabled && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onAskRef.current?.()}
          aria-label="Ask this as a question"
          className="absolute top-1/2 right-10 -translate-y-1/2 rounded-full p-1 text-(--sea-ink-soft) transition hover:text-(--sea-ink)"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
            className="h-5 w-5"
          >
            <path d="M10 16a.75.75 0 01-.75-.75V6.56L5.03 10.78a.75.75 0 01-1.06-1.06l5.5-5.5a.75.75 0 011.06 0l5.5 5.5a.75.75 0 11-1.06 1.06L10.75 6.56v8.69A.75.75 0 0110 16z" />
          </svg>
        </button>
      )}
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
        className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-(--sea-ink-soft) transition hover:text-(--sea-ink)"
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
        aria-label="Search"
        className="absolute top-[8px] right-[8px] bottom-[8px] inline-flex items-center rounded-md px-3 text-sm text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink)"
      >
        <SearchIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
});
