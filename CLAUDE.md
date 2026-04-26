# Project Notes

## Search input visibility — pre-hydration attribute pattern

First-paint visibility is controlled by a blocking inline script
(`scripts/search-input-init.ts`) that stamps `data-hide-search-input` on `<html>`,
and a CSS rule in `styles.css` that gates `.search-input-wrapper` opacity off it
with `!important` (needed to beat React's inline opacity). This lets React default
`ready=true` without server/client divergence.

### Cross-file invariants

- **`pagehide` listener in `HmrcResults` is load-bearing AND must be conditioned on
  `results.length > 0`**: at script-time on the next load the browser hasn't restored
  scroll yet, so `window.scrollY` is still 0. Without `sessionStorage['hmrc-scroll-y']`
  saved on `pagehide`, reload-while-scrolled flashes the input. But registering the
  listener unconditionally breaks iOS: the soft keyboard auto-scrolls on input focus,
  which `pagehide` would persist with no consumer to clear it (HmrcResults early-returns
  on empty search), leaving the input hidden forever after reload.
- **Safety-net cleanup must NOT remove `hmrc-scroll-y`**: `HmrcResults` owns key
  consumption, and its `ready` gate (data + fonts + width) can take many frames.
  Clearing the key here races scroll-restore on back-nav.
- **Attribute is cleared on `isStuck=true` via `useLayoutEffect`**: by then React's
  inline `opacity:0` is in place, so dropping the CSS gate is safe.

### Anti-patterns (past bugs)

- **`useLayoutEffect` to set opacity directly**: no-op on server → first SSR paint
  shows the input before JS hides it.
- **Synchronous `getBoundingClientRect` in `useSearchPill`**: sentinel is briefly
  in-viewport on back-nav before scroll restores, so the read lies.
- **Diverging server/client initial state for `ready`**: hydration mismatch → React
  reconciles to client and overwrites server HTML, producing a worse flash. The
  pre-hydration attribute is the only correct way to encode client-only first-paint
  state.
- **`!pillClickedRef.current` guard in the IntersectionObserver**: deadlocks with
  `useSearchShortcut` (which sets `pillClicked=true` on printable keys when
  `activeElement: BODY`). Observer can no longer set `isStuck=true`, and the only
  reset (`onBlur`) requires `isStuck=true`. Pill never shows. `onActivate` must be
  conditional on `isStuckRef.current` instead.

### `isStuck = false` must be debounced

When results reload, the page height changes (content → skeletons → new content) and can
briefly pull the sentinel back into the viewport. Without debouncing, `isStuck` toggles
rapidly and the input blinks between visible and pill mode (especially on iOS Safari).

### `transform: translateZ(0)` on SearchInput — focus-within only

Needed for iOS Safari cursor positioning in sticky containers, but applying it permanently
causes iOS Safari's GPU compositor to garble rotating placeholder text. Must only apply
via `:focus-within` in `SearchInput.module.css`. Do NOT add it as a permanent inline style.

## Pretext virtual list sizing — keep in sync with CSS

`HmrcResults.tsx` uses `@chenglou/pretext` for canvas-based card height estimation
instead of DOM `measureElement`. This eliminates layout reflow during scroll (35-43%
reduction in Layout/Recalculate style).

### Two places to update when HmrcCard styling changes

1. **`HmrcResults.tsx` lines ~13-29** — the `useCardMetrics` config:
   - `fields[].font` — must match the card's CSS font (weight, size, family)
   - `fields[].lineHeight` — must match the CSS line-height in px
   - `fields[].getText` — must match the text transformation applied before render
   - `fixedHeight` — sum of all fixed-height card elements (padding, margins, rating
     line, route line) plus 4px for sub-pixel rounding
2. **`HmrcResults.tsx` line ~75** — the hidden measurement div's `className="px-4"` must
   match the real container's horizontal padding class (line ~95)

### How the readiness gating works

Items only render when three conditions are met:
1. **Data** — query results available (`isLoading` is false)
2. **Fonts** — `document.fonts.ready` + one `requestAnimationFrame` (canvas needs the
   font rendered, not just downloaded)
3. **Width** — container content-box width measured via `useLayoutEffect` on a hidden div

Until all three are ready, `<SkeletonCards />` stays visible. This prevents layout shifts
from fallback font measurements or missing width data.

### Scroll restoration depends on `ready`

The `hmrc-scroll-y` sessionStorage restore runs in a `useEffect([ready])` — it must wait
for items to be in the DOM at correct heights before calling `window.scrollTo`.

## Page transitions live in `transitions.css`, not `styles.css`

All View Transitions API rules — keyframes, `view-transition-name` declarations on
`.page-flip-listing` / `.page-flip-details`, `::view-transition-*(active-card)` and
`::view-transition-*(root)` styling, `:active-view-transition-type(forward|back)`
direction-keyed animations, and `html[data-browser="…"]` browser-targeted overrides —
live in `apps/web/src/transitions.css`. It's imported from `styles.css` at the top.

When adding or editing transition behaviour, edit `transitions.css`. Do not put view-
transition rules back into `styles.css` — the split exists so the (substantial) transition
logic doesn't tangle with base tokens, utilities, and component styles.

### Cross-file moving parts to know about

- `HmrcCard` sets `style={{ viewTransitionName: 'active-card' }}` on the clicked card via
  React state in `HmrcResults` (`flushSync` on click so the DOM is committed before
  TanStack Router calls `startViewTransition`). Safari overrides the active-card name to
  `none` via `[style*="view-transition-name"] { ... !important }` because that's the only
  way to beat an inline style from CSS.
- The `data-browser` attribute on `<html>` is stamped pre-hydration by
  `scripts/browser-init.ts`. Generic mechanism — add `html[data-browser="chrome"] { … }`
  rules in `transitions.css` for future per-browser tweaks.
- Forward navigation passes `viewTransition={{ types: ['forward'] }}` on the `Link` in
  `HmrcCard`; back navigation passes `['back']` on the back link in `company.$id.$slug.tsx`.
  Other navigations (e.g. search-param updates) deliberately do NOT pass `viewTransition`
  so they don't trigger animations.
