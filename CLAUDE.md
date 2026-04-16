# Project Notes

## Search input visibility — things that break (non-obvious)

### Approaches that cause input flashes — do NOT use

1. **`useLayoutEffect` to set opacity** — causes the input to flash when reloading while
   scrolled down. `useLayoutEffect` is a no-op on the server so the HTML has no opacity
   style, and the input is visible for one frame before JS hides it.
2. **Default `ready` to `true`** — causes a flash when navigating back from the company
   detail page while scrolled down.
3. **`showPill || (!ready && isStuck)` opacity condition** — causes a flash on initial
   paint because the sentinel is briefly in-viewport during layout before scroll restores.
4. **Synchronous `getBoundingClientRect` in `useSearchPill` effect** — same flash as #3.
   On back-navigation the sentinel is momentarily in-viewport before scroll restores.

### Do NOT add `!pillClickedRef.current` guards in the observer

The observer must always set `isStuck` and always reset `pillClicked` when the sentinel
enters the viewport. Guards on these create a deadlock: `useSearchShortcut` sets
`pillClicked = true` when a printable key is pressed with `activeElement: BODY` (happens
on page load and back-navigation). The guard then prevents the observer from setting
`isStuck = true`, and the only reset path (`onBlur`) requires `isStuck` to be `true`.
Result: pill never shows. The `onActivate` callback must be conditional on
`isStuckRef.current` to avoid this.

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
