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
- **`hmrc-scroll-y` means "restore to Y > 0", never "0"**: a saved `"0"` is a
  truthy string, so it stamps the hide attribute (`search-input-init.ts`) AND
  defeats the safety-net poll's `!getItem(...)` guard — hiding the input forever
  on a non-restoring full load (empty/short/zero-result home, where `ready` never
  becomes true so the restore effect never consumes the key). Two guards keep the
  key meaning a real scroll: the `HmrcCard` click + `HmrcResults` `pagehide`
  writers only persist when `scrollY >= 1` (click else `removeItem`), and
  `search-input-init.ts` stamps only when the saved value `parseInt`s to `>= 1`.
  Use `>= 1`, not `> 0`: writers and reader must agree, and a sub-pixel scroll
  (e.g. `0.6`, HiDPI/zoom) floors to `0` on read — persisting it would stamp the
  hide with nothing the reader (or restore) will honor.
- **`HmrcResults` discards a stranded key on non-restoring mounts**: a `useEffect`
  keyed on `[search, isLoading, results.length]` `removeItem`s `hmrc-scroll-y`
  unless `search.length >= 3 && (isLoading || results.length > 0)`. This closes the
  permanent-hide where *any* truthy stale value lands on the empty/short/zero-result
  home with no consumer. Its guard is shaped to preserve the key through a genuine
  pending restore (loading, or rows present), so it never races the restore effect —
  do NOT widen it to drop the `isLoading ||` disjunct or add `ready` to its deps.
- **Attribute is cleared on `isStuck=true` via `useLayoutEffect`**: by then React's
  inline `opacity:0` is in place, so dropping the CSS gate is safe.
- **The safety-net poll clears on "restore done AND not pill", NOT `scrollY === 0`**:
  the restore can settle at a few px — a small saved scroll, or a large one that
  *clamps* because the `scrollTo` rAF raced the virtual list's height — leaving the
  sentinel in view (input mode, not pill) where `isStuck` never goes true. The old
  `scrollY === 0` guard never matched there, stranding the input hidden (visible
  symptom: results page, no input, no pill, "scroll to recover"). The poll now waits
  for `hmrc-scroll-y` to be consumed, then reads the sentinel: in view → not pill →
  clear; scrolled out → leave it for the `isStuck` clearer (so the input never
  flashes at a scrolled position). Gating the rect read on `!getItem(...)` keeps it
  post-restore and accurate.

### Anti-patterns (past bugs)

- **`useLayoutEffect` to set opacity directly**: no-op on server → first SSR paint
  shows the input before JS hides it.
- **Synchronous `getBoundingClientRect` in `useSearchPill` — only safe when gated on
  `!hmrc-scroll-y`**: sentinel is briefly in-viewport on back-nav *before* scroll
  restores, so an ungated read lies. The safety-net poll may read it because it only
  does so once the key is gone (restore complete) — the read is then post-restore and
  accurate. Do NOT add an ungated rect read elsewhere.
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

### `transform: translateZ(0)` on SearchInput — focus-within AND pinned only

Needed for iOS Safari cursor positioning in sticky containers, but the GPU layer garbles
the rotating placeholder text on iOS Safari whenever it's live while the placeholder is
visible (focused + empty input — e.g. after type-then-clear, or a desktop autofocus).
So it must apply only via `:focus-within` AND only when the search bar is pinned/sticky:
the rule in `SearchInput.module.css` is scoped to a `:global([data-search-pinned])`
ancestor, and `index.tsx` stamps `data-search-pinned` on the search wrapper only when a
query exists (not on the empty/hero state, where the bar is `relative` and the placeholder
rotates). On that empty state the cursor-positioning fix isn't needed anyway (not sticky).
Do NOT widen this back to plain `:focus-within` and do NOT add it as a permanent inline style.

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
   - Conditional lines (e.g. the italic "Previously …" previous-name line) work
     because empty text measures as 0 lines / 0px — but the rendered element must
     stay **margin-free**: a margin would apply once per card while the estimator
     only counts `lineCount * lineHeight`
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

## Home search (`searchHmrc`) — index-served predicates + previous-name matching

The search WHERE pairs each pg_trgm function recheck with its index-served
OPERATOR: `org ~* pattern`, `query <% org AND word_similarity(...) > 0.6`,
`org % query AND similarity(...) > 0.5`. The operators let the GIN trigram
indexes BitmapOr the candidate set (~20x faster); the function rechecks pin the
exact thresholds independent of the `pg_trgm.*_threshold` GUCs (defaults 0.6 /
0.3). Do NOT "simplify" either half away: bare functions can never use an
index (full scan, ~1s), bare operators silently change semantics if a GUC moves.

Previous Companies House names are searched via `ch_previous_names`
(company_number, name) — a flattened projection of
`companies_house_profiles.previous_company_names` with its own
`gin_trgm_ops` index, because GIN can't trigram-index inside an array column.
It is maintained by the DB trigger `trg_sync_ch_previous_names` (AFTER
INSERT OR UPDATE OF previous_company_names) — never write to it from
application code, and any environment migration must create the table, index,
trigger, and backfill together.

The query keeps prev-name hits in a separate UNION branch (probe
`idx_hmrc_org_name` by org) rather than `OR`-ing them into the direct WHERE —
an OR across the join would force a seq scan and lose all index use. A result's
`matchedPreviousName` is set only when the previous-name score strictly beats
the current-name score (ties show the current name without the line).
`public_body`/`no_match` mapping rows have NULL company_number, so they drop
out of the prev-name join naturally.

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
