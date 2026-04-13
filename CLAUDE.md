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
