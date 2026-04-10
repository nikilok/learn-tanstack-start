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

The opacity condition was changed from:
```
!ready || showPill
```
to:
```
showPill || (!ready && isStuck)
```

This ensures:
- **SSR/initial load**: `ready=false`, `isStuck=false` → input is visible (opacity: 1)
- **Navigating back while scrolled**: `ready=false`, `isStuck=true` → input is hidden briefly
  until observer fires, preventing the flash
- **Pill showing**: `showPill=true` → input is hidden, pill takes over

### Key files
- `src/components/SearchBar.tsx` — opacity logic
- `src/hooks/useSearchPill.ts` — `ready` and `isStuck` state
- `src/components/HmrcResults.tsx` — skeleton shown via `isLoading`, not Suspense fallback
