// Shared styling for the header's icon-button controls (theme, cursor, share),
// so padding/ring/hover and icon sizing stay in sync across all three.

/** Button shell for a header icon control — ~40px tap target on mobile, ~34px on desktop. */
export const HEADER_CONTROL_CLASS =
  'rounded-md p-2.5 text-(--sea-ink-soft) transition hover:bg-(--link-bg-hover) hover:text-(--sea-ink) sm:p-2';

/** Icon sizing for those controls — 20px on mobile, 18px on desktop. */
export const HEADER_ICON_CLASS = 'size-5 sm:size-[18px]';
