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
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (focus || autoFocus) {
      el.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }
  }, [focus, autoFocus]);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        defaultValue={defaultValue}
        onInput={() => onChangeRef.current(inputRef.current?.value ?? '')}
        onBlur={onBlur}
        placeholder={placeholder}
        className={`relative w-full rounded-lg border border-(--sea-ink-soft)/20 bg-transparent px-4 py-3 pr-10 text-lg text-(--sea-ink) backdrop-blur-xl placeholder:text-(--sea-ink-soft)/50 focus:border-(--sea-ink-soft)/40 focus:outline-none focus:ring-0 ${styles.input}`}
      />
      {/* Clear button is always available via ref check */}
      <button
        type="button"
        onClick={() => {
          if (inputRef.current) inputRef.current.value = '';
          onChangeRef.current('');
        }}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-(--sea-ink-soft) transition hover:text-(--sea-ink)"
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
    </div>
  );
});
