// Mirrors apps/web/src/components/CursorIcons.tsx so the title bar's cursor
// toggle uses the same glyph as the web header — solid = on, dotted = off.
// Sized 16px to match the other title-bar icons; themed via currentColor.
const CURSOR_PATH =
  'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z';

/** Solid mouse-pointer glyph — shown when the custom cursor is on. */
export function CursorIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={CURSOR_PATH} />
    </svg>
  );
}

/** Dotted, unfilled mouse-pointer outline — shown when the custom cursor is off. */
export function CursorOffIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray="2 3"
      aria-hidden="true"
    >
      <path d={CURSOR_PATH} />
    </svg>
  );
}
