# Project Notes

## Search input visibility bug (SearchBar + useSearchPill)

The search input in `SearchBar.tsx` is wrapped in a div with `opacity: 0/1` controlled by
two flags: `ready` and `showPill` from the `useSearchPill` hook.

### The `ready` flag

`ready` starts as `false` and becomes `true` when the IntersectionObserver in `useSearchPill`
fires for the first time. Its purpose is to prevent a flash where the full search input
briefly appears before transitioning to the pill (compact header button) when navigating
back to the search page while scrolled down.

### The bug

On SSR, `ready` is always `false` (IntersectionObserver is client-only). This means the
server-rendered HTML has `opacity: 0` on the search input wrapper. If hydration or JS
execution is slow (mobile devices, cold starts), the user sees a blank space where the
search input should be.

This is especially noticeable when the Neon DB has a cold start (auto-suspend on free tier),
causing the streaming response to delay. The skeleton cards show (from `HmrcResults`
`isLoading` check, not the Suspense boundary), but the search input is invisible.

### The fix

The input wrapper has NO inline style. Visibility is controlled entirely by `useLayoutEffect`
in `SearchBar.tsx`, which sets `opacity` and `pointerEvents` on the wrapper ref.

**Why `useLayoutEffect`:**
- On the server, `useLayoutEffect` is a no-op — so the SSR HTML renders the input with
  no inline style (visible by default). Users see the search input immediately, even
  before JS loads.
- On the client, `useLayoutEffect` runs synchronously before the browser paints — so when
  navigating back from a company page while scrolled, it sets `opacity: 0` before the
  user sees anything. No flash.
- When the IntersectionObserver fires and sets `ready=true`, `useLayoutEffect` runs again
  and sets `opacity: 1`.

### Approaches that were tried and failed — do NOT use

1. **Inline `style={{ opacity: !ready || showPill ? 0 : 1 }}`** — the server bakes
   `opacity: 0` into the HTML since `ready` is always `false` on the server. Input is
   invisible until JS hydrates, which is noticeable on slow connections or serverless
   cold starts.
2. **Default `ready` to `true`** — causes a flash of the input when navigating back
   from the company detail page while scrolled down.
3. **Change opacity condition to `showPill || (!ready && isStuck)`** — causes the input
   to flash on initial paint before hydration hides it, because the sentinel is briefly
   in the viewport during layout before scroll position restores.
4. **Synchronous `getBoundingClientRect` check in `useSearchPill` effect** — same flash
   problem as #3. On back-navigation the sentinel is momentarily in-viewport before
   scroll restores, so it incorrectly sets `ready=true`.

### Key files
- `src/components/SearchBar.tsx` — opacity logic
- `src/hooks/useSearchPill.ts` — `ready` and `isStuck` state
- `src/components/HmrcResults.tsx` — skeleton shown via `isLoading`, not Suspense fallback
