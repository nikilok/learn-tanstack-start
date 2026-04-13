# Project Notes

## Search input visibility (SearchBar + useSearchPill)

The search input in `SearchBar.tsx` is wrapped in a div with inline `opacity: 0/1`
controlled by two flags: `ready` and `showPill` from the `useSearchPill` hook.

### How it works

- `ready` starts `false`, becomes `true` when the IntersectionObserver fires
- `showPill` is `true` when scrolled past the sentinel with an active search term
- Input wrapper: `opacity: !ready || showPill ? 0 : 1`
- Server renders `opacity: 0` (observer is client-only, so `ready` is always `false`)
- After hydration, observer fires, `ready` becomes `true`, input appears

### Known limitation

If the Vercel serverless function or Neon DB cold-starts, the SSR HTML arrives with the
input at `opacity: 0`. The input stays invisible until JS hydrates and the observer fires.
During this time the skeleton cards show (from `HmrcResults` `isLoading` check, not the
Suspense boundary) but the search input is hidden.

This is acceptable because:
- If the server is slow enough that the input is hidden, the user can't search anyway
  (no JS = no interactivity)
- The correct fix is graceful error handling on the query side (timeout/error boundary),
  not visibility hacks on the input

### Approaches that were tried and failed — do NOT use

1. **`useLayoutEffect` to set opacity** (no inline style, server renders visible) — fixes
   the cold-start visibility issue but causes the input to flash when reloading while
   scrolled down. `useLayoutEffect` is a no-op on the server so the HTML has no opacity
   style, and the input is visible for one frame before JS hides it.
2. **Default `ready` to `true`** — causes a flash of the input when navigating back from
   the company detail page while scrolled down.
3. **Change opacity condition to `showPill || (!ready && isStuck)`** — causes the input
   to flash on initial paint before hydration hides it, because the sentinel is briefly
   in the viewport during layout before scroll position restores.
4. **Synchronous `getBoundingClientRect` check in `useSearchPill` effect** — same flash
   problem as #3. On back-navigation the sentinel is momentarily in-viewport before
   scroll restores, so it incorrectly sets `ready=true`.

### Key files
- `apps/web/src/components/SearchBar.tsx` — opacity logic (inline style)
- `apps/web/src/hooks/useSearchPill.ts` — `ready` and `isStuck` state
- `apps/web/src/components/HmrcResults.tsx` — skeleton shown via `isLoading`, not Suspense fallback
- `apps/web/src/routes/index.tsx` — Suspense boundary wraps HmrcResults only, not SearchBar
