# Project Notes

## Testing — complex logic ships with tests

Anything with non-obvious rules gets unit tests, so a change in one place cannot
silently break another. This is not aspirational: the slug-URL migration shipped
a live wrong-data bug (a card showing an A rating beside a B-rated licence) while
all 372 existing tests stayed green, because none of them covered that feature.

- **Extract before testing.** Logic inline in a React component or a route file
  is untestable in practice — nothing can import it without rendering. Move it to
  a pure module (`src/lib/company/licences.ts` is the pattern) and have the
  component call that, so the shipping code *is* the tested code.
- **Encode the real failure.** Name the actual production case in the test
  (Platinum Equity holds a B-rated Skilled Worker licence and an A-rated GBM
  licence). A test that pins a bug that really happened outlives a generic one.
- **Prefer structural impossibility over an agreement test.** Two copies of a
  rule that must match (an ORDER BY in two queries, a slugify expression in SQL
  and TS) should become one shared helper — see `slugifiedSqlText` in `@ss/db`.
- **Know what unit tests do not cover.** They lock logic, not SQL behaviour
  (OFFSET pagination, aggregate ordering) and not rendered layout. Those need a
  dry-run against a copy of prod data and screenshots at several widths. Say
  which of the three you did rather than implying full coverage.

### The invariant this feature keeps breaking

A company can hold **different ratings on different visa routes**. Routes and
ratings must therefore never be rendered, serialised, or returned as two parallel
lists — every consumer that re-pairs them by position gets it wrong. This defect
recurred on seven surfaces (search card, both MCP tools, page display, page
prose, FAQ JSON-LD, transitional RPC scalars) because the payload had dropped the
pairing. Carry `licences: {route, rating}[]` end to end; `lib/company/licences.ts`
holds the selection/grouping helpers and `licences.test.ts` locks them.

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
  keyed on `[queryActive, isLoading, hasRows]` (`hasRows = results.length > 0` —
  it fires on empty↔non-empty transitions, not every length change)
  `removeItem`s `hmrc-scroll-y`
  unless `queryActive && (isLoading || results.length > 0)` — and, since filters,
  only when `loadStoredFilters()` is empty: a stored filter set means the bare
  mount is about to rehydrate into filter mode (index.tsx), whose listing will
  consume the key, so discarding would lose the back-nav scroll. This closes the
  permanent-hide where *any* truthy stale value lands on the empty/short/zero-result
  home with no consumer (a filter-mode zero-result listing still consumes the key —
  the restore effect runs on `ready` regardless of rows). Its guard is shaped to
  preserve the key through a genuine pending restore, so it never races the restore
  effect — do NOT widen it to drop the `isLoading ||` disjunct or add `ready` to its
  deps.
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

**Scope: this is SearchInput-specific** — it exists solely because the GPU layer garbles
SearchInput's *rotating placeholder*. It is NOT a blanket ban on `transform: translateZ(0)`.
Other elements may keep it as a permanent style for legitimate sticky/GPU compositing — e.g.
`.site-header` in `styles.css` uses it to avoid iOS-Safari sticky repaint/flicker on scroll,
which is correct and unrelated to this rule.

## Virtual list sizing — keep in sync with CSS

`HmrcResults.tsx` uses `virtual-text-layout` (`useVirtualTextLayout`) for canvas-based
card height estimation instead of DOM `measureElement`. This eliminates layout reflow
during scroll (35-43% reduction in Layout/Recalculate style).

The compact card has NO wrapping text by design: the org **name** truncates (one line),
and the **metadata** (rating + location + route chip) never wraps — only the location and
chip may truncate. So the ONLY height-varying element is the conditional italic
"Previously …" line; everything else is a constant baked into `fixedHeight`.

The metadata is responsive and so is `fixedHeight`: **≥sm (640px)** it is one inline
line (rating · location · chip); **<sm** each item stacks onto its own line (rating /
location / chip). `HmrcCard` switches layout on the `sm:` breakpoint and `HmrcResults`
tracks the SAME breakpoint via `matchMedia('(min-width: 640px)')` to pick `fixedHeight`
— they MUST use the same 640px boundary or row heights desync at that width. Because the
location is optional, it is a `fields[]` entry that only contributes a line **when narrow
AND present** (inline ≥sm costs nothing); rating and chip are always present and fixed.

### Two places to update when HmrcCard styling changes

1. **`HmrcResults.tsx` `useVirtualTextLayout` config** — `fields` + `fixedHeight`:
   - `fields[].font` / `lineHeight` — must match the card's CSS font + line-height in px
   - `fixedHeight` — sum of every always-present constant-height element, switched on
     the `sm` breakpoint via `isNarrow`: `py-2(8) + name(24) + mt-1(4) + base-meta +
     py-2(8) + 4` rounding, where `base-meta = 20` (≥sm, one line) → **68**, or
     `base-meta = 20 + gap-1(4) + 20` (<sm, the always-present rating + chip) → **92**.
     The optional location adds **+24** (`fields[]`) only when <sm — and the breakpoint
     switch lives in the location field's `lineHeight` (`isNarrow ? 24 : 0`), NOT its
     `getText`: `virtual-text-layout` caches each row's `getText` output once (rebuilt
     only when results shrink), so an `isNarrow`-dependent `getText` goes stale on a
     runtime resize across 640px, whereas `lineHeight` is read fresh every estimate. Keep
     `getText` a pure function of row data. If you change the name size/line-height, the
     metadata layout or its gaps, or the link padding, update BOTH numbers, the location
     field's `lineHeight`, and the breakpoint.
   - The single remaining `fields[]` entry measures the **previous-name** line as a
     one-glyph sentinel (`row.matchedPreviousName ? 'M' : ''`) → exactly 1 line when a
     match exists, 0 when not — NOT the real text, because the rendered line is
     `truncate` (never wraps) so only its presence affects height. The card still
     renders the real `previousNameText()` from `utils.ts`; keep that line margin-free
     so its height stays exactly `lineCount * 16px`.
   - Invariant: nothing in the card may wrap except that previous-name line (metadata
     items truncate, never wrap). If you ever let the name or a metadata field wrap, you
     must convert it back into a measured `fields[]` entry (real text, real font) AND
     remove its fixed contribution from `fixedHeight` — the two move together.
2. **`HmrcResults.tsx`** — the hidden measurement div's `className="px-4"` (loading
   branch) must match the real results container's horizontal padding class.

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

### Highlight rail + Union Jack marker (NOT a per-card box)

The keyboard-highlighted row is marked by a single continuous thin **rail** (1px, the
`.guide-rail` class in styles.css — the empty-state hero `.streaks` spectrum gradient run
vertically, so it reads as part of that colourful grid) down the left gutter plus a Union Jack **marker** that rides
it — both rendered ONCE in `HmrcResults`
(inside the `position: relative` content box), not per card. `HmrcCard` only turns the
highlighted name red; it draws no box/flag, so the highlighted text never shifts right.

Cross-file coupling to keep in sync:
- **`RAIL_X` (HmrcResults)** places the rail/marker centre in the left gutter that the
  card's `-mx-4 px-4` opens up (negative = into that gutter, `x=0` is the text edge).
  `-16` lands it on the **content column's left edge** (the card's 16px gutter), so the
  rail lines up with the search box and the rest of the page. If you change the card's
  horizontal padding/margin, re-check it. `SkeletonCards`' static rail mirrors it (`left-0`,
  i.e. the same column edge).
- **`NAME_LINE_CENTER` (HmrcResults)** is the marker's vertical offset = the name line's
  centre from the card top (`py-2(8) + nameLineHeight(24)/2`). It must track the card's
  top padding and name line-height, or the marker drifts off the title.
- The marker's `top` is the highlighted row's `start - scrollMargin + NAME_LINE_CENTER`
  in the content box's frame (same transform the rows use). It's null — marker hidden —
  when that row isn't in the rendered/overscan window, so it only shows where it can be
  placed accurately. Its `top` updates with **no** transition so the marker tracks the
  highlight instantly; a `top` transition visibly lags and jitters under fast key-repeat
  (held-arrow scrolling), so do not add one.
- The content box has a `minHeight` floor so the rail runs to near the page bottom even
  for a handful of rows; tall result sets exceed it and set the height from `getTotalSize()`.
- `SkeletonCards` draws a matching static rail (no marker) so loading→loaded doesn't pop.

## Name search — index-served predicates + previous-name matching

Both surfaces search names: `searchHmrc` (home, no filters) and `searchFiltered`
(any filter active, name term as `q`). They must find and rank the same
companies, so the previous-name CTEs and score fragments live in ONE place —
`lib/search/prev-name.ts` — and each server fn only assembles them into its own
query shape. `buildPrevNameMatch` returns the raw pieces (home search composes
them across its `g0`/`g` CTEs); `buildNameTermSql` composes them for a
single-level grouped listing (the filtered search) and degrades to the
browse-everything query when there is no term. Changing a scoring rule in one
surface only is not possible by construction — keep it that way.

The match branches pair each pg_trgm function recheck with its index-served
OPERATOR: `org ~* pattern`, `query <% org AND word_similarity(...) > 0.6`,
`org % query AND similarity(...) > 0.5`. The operators let the GIN trigram
indexes BitmapOr the candidate set (~20x faster); the function rechecks pin the
exact thresholds against downward drift of the `pg_trgm.*_threshold` GUCs
(defaults 0.6 / 0.3). The pair is NOT immune upward: a GUC raised above the
recheck's literal (0.6 / 0.5) makes the operator the binding filter and
silently shrinks results. Do NOT "simplify" either half away: bare functions
can never use an index (full scan, ~1s), bare operators silently change
semantics if a GUC moves.

**How the branches are combined depends on table size.** On
`hmrc_skilled_workers` (141k rows) the planner costs a seq scan above the
BitmapOr, so the ORed predicate (`fuzzyMatch`) is index-served. On
`ch_previous_names` (48k rows / 800 pages) it does NOT: the ORed form estimates
below the BitmapOr, the planner seq-scans, and the regex + trigram filter runs
on every row — 300ms where three index probes cost 14ms (measured on prod data,
2026-07-27; it made a `london` home search 795ms instead of 194ms). So the
previous-name candidates are three UNIONed single-operator SELECTs, one per
branch, deduped by the table's (company_number, name) PK. `matchBranches` in
`lib/search/name-match.ts` is the single source both forms are built from, so
they can never match different rows. Do NOT fold the UNION back into a WHERE;
re-measure with EXPLAIN before assuming either shape is right for a new table.

Previous Companies House names are searched via `ch_previous_names`
(company_number, name) — a flattened projection of
`companies_house_profiles.previous_company_names` with its own
`gin_trgm_ops` index, because GIN can't trigram-index inside an array column.
It is maintained by the DB trigger `trg_sync_ch_previous_names` (AFTER
INSERT OR UPDATE OF previous_company_names) — never write to it from
application code, and any environment migration must create the table, index,
trigger, and backfill together. The function body (hardened in 0029)
early-returns on no-op assignments (`OLD IS NOT DISTINCT FROM NEW` — upserts
assign the column on every write, ~29x more often than it changes) and filters
NULL array elements, which would otherwise violate `name NOT NULL` and abort
the parent profile write (poison stream event). The OLD comparison must stay
inside a nested `IF TG_OP = 'UPDATE'` block: plpgsql binds `OLD.x` before
evaluating, so a combined condition errors on INSERT.

Both queries keep prev-name hits in a separate `hits` UNION branch (probe
`idx_hmrc_org_name` by org) rather than `OR`-ing them into the direct WHERE —
an OR across the join would force a seq scan and lose all index use. `hits`
selects `h.*` so the filtered search's WHERE can still filter on any sponsor
column (`buildFilterConditions` reads `h.town_city`). A result's
`matchedPreviousName` is set only when the previous-name score strictly beats
the current-name score (ties show the current name without the line).
Prev-name wins also sort below equal-score direct matches via the `prev_won`
key — without it, renamed orgs tie prefix queries at full score and flood
page 1 alphabetically by their unrelated current names. In `searchHmrc`
`prev_won` appears in BOTH the `g` ORDER BY and the outer re-sort; in
`searchFiltered` it is the second key of the `relevance` ORDER BY (the only
sort a name term can reach — `name`/`incorporated` order by their own column,
and prev-name hits simply interleave). Keep the paired orderings identical or
OFFSET pages duplicate/drop rows. The current-name score is gated on the
`direct` flag carried out of `hits`: for prev-name-only rows, ungated
`scoreCase` is sub-threshold word_similarity noise that would suppress
`matchedPreviousName` and leak past the demotion. Do NOT replace the flag with
a `fuzzyMatch(org)` recheck — that re-runs trigram ops per grouped row.
`public_body`/`no_match` mapping rows have NULL company_number, so they drop
out of the prev-name join naturally.

In the filtered search the filters apply to the company **as it is today**: a
sponsor found under an old name must still satisfy every active filter. The
name term therefore enters through the CTEs and never as a WHERE condition, and
a filter-only listing (no `q`) emits no CTEs at all — its query is byte-for-byte
the one it was before previous-name matching existed.

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
  `HmrcCard`; back navigation passes `['back']` on the back link in `company.$slug.tsx`.
  Other navigations (e.g. search-param updates) deliberately do NOT pass `viewTransition`.
- Browser back/forward pops animate via `defaultViewTransition` in `router.tsx`
  (`resolvePopTransitionTypes`): home ↔ details pops only — everything else returns
  `false`, which is what keeps search-param updates instant. Direction comes from
  `state.__TSR_index` (a decreasing index is provably a back traversal; forward-index
  motion landing on home, e.g. the header-logo push, stays instant). The resolver also
  stamps `data-page-flip` (pops have no click handler) and skips under reduced
  motion. It requires
  the OLD page's structural marker (`.page-flip-details` / `.page-flip-listing`) to
  exist — the root `RouteError` renders at the failed route's URL, and its
  `history.back()` must stay instant, not flip the crash screen. **The option is gated
  on `supportsTypedViewTransitions && isBlink`**: the typed-VT gate stops an ungated
  object default from running an untyped transition for EVERY navigation (search
  keystrokes included, where a stale `data-page-flip` could fire the back sweep); the
  `isBlink` gate stops the resolver's per-pop DOM work on Safari/Firefox, where
  `browser-init.ts` shims `startViewTransition` to a no-op (WebKit + Gecko can't
  composite backdrop-filter in a VT snapshot). Old-iOS pops are instant by design.
- The iOS edge-swipe gesture guard was **removed** (it kept a Safari swipe-back from
  double-animating a real transition): `browser-init.ts` now shims
  `document.startViewTransition` to a no-op on every non-Chromium engine, so Safari runs
  no app transition at all — there is nothing to double.
- A forward pop onto details replays the click morph: the resolver names the origin
  card via a direct inline-style DOM write (React state can't commit before the OLD
  snapshot capture; the node unmounts with the nav), sweeping stale inline names first
  — in BOTH directions, a leftover cmd+click name must not pair on a back pop — since
  duplicate `active-card` regions abort the transition. The card path is
  `CSS.escape`d (router pathnames arrive DECODED; a quote would otherwise throw
  mid-commit and strand the navigation), and the card is named only if its bbox
  intersects the viewport: `useWindowVirtualizer`'s overscan keeps ~5 off-screen rows
  mounted, and a morph from an off-viewport bbox streaks across the page and paints
  over the header. Otherwise the details content just fades in.
- **Every transition-triggering nav must ALSO call `stampPageFlip('forward'|'back')`**
  (utils.ts) in its click/key handler, synchronously before the navigate. It sets
  `data-page-flip` on `<html>`, which the Safari-scoped rules in `transitions.css` key
  on instead of `:active-view-transition-type()`: TanStack Router only passes `types`
  to `startViewTransition` when `CSS.supports('selector(:active-view-transition-type(a))')`
  is true (router-core's gate), and WebKit only shipped that pseudo-class in Safari 18.2 —
  on iOS 18.0/18.1 the transition runs untyped, typed selectors match nothing, and Safari
  silently falls back to the UA cross-fade. Current stamp sites: `HmrcCard` onClick (via
  `onActivate` in `HmrcResults`), and the Esc handler + back `Link` in
  `company.$slug.tsx`. The attribute is re-stamped by every such nav and inert between
  transitions, so it needs no cleanup. Chrome-only rules may keep the typed pseudo-class.

## /download owner gating — cross-file invariants

Release visibility (`desktop_releases.visibility`, default `'private'` = fail closed)
is owner-gated via `src/owner.server.ts`: a valid `vercel-flag-overrides` cookie
(sealed by Vercel with `FLAGS_SECRET`, team members only) bootstraps a durable
httpOnly `ss-owner` cookie. Rotating `FLAGS_SECRET` revokes ALL owner credentials —
that is the kill-switch (also for ex-team-members, whose cookies outlive membership).

- **A no-op `owner-bootstrap` anchor flag must stay in the `flags` registry**
  (`flags.server.ts`): the toolbar only mints the `vercel-flag-overrides` cookie
  when the Flags Explorer has ≥1 flag to toggle. It gates no UI and looks unused —
  deleting it empties the registry and silently breaks new-owner bootstrap (and
  makes the `FLAGS_SECRET` kill-switch irreversible). It is the sole registry
  entry since the `downloads` flag was removed.
- **`/download` must NEVER get a cache routeRule** (vite.config.ts): the loader
  SSR-renders owner-specific content (private releases + Publish buttons from
  `getOwnerDesktopReleases`), which is only safe because documents render
  per-request. Caching the document would serve an owner's HTML to everyone.
- **`getDesktopReleases` must stay cookie-BLIND**: its RPC response is edge-cached
  (LONG + `desktop-releases` tag) and shared by all viewers. Per-viewer data belongs
  only in `getOwnerDesktopReleases`, which sets `private, no-store` and must never
  gain an s-maxage.
- **Owners render `getOwnerDesktopReleases`' full snapshot INSTEAD of a merge**: the
  owner fn returns public+private together because merging the cached public list
  with a private-only list duplicates/drops the flipped release while the two
  queries refetch at different speeds after publish/unpublish.
- Visibility flips propagate via the tag purge in `setReleaseVisibility` (gated on
  `VERCEL_CACHE_INVALIDATION`, like the release POST endpoint's). If you change the
  tag name or caching, keep mutation-purge and cache-tag in lockstep.
- **`beforeLoad` resolves owner membership; the loader forks on it**: the owner
  check is local cookie crypto (no backend), so the load never stalls on it. The
  loader skips the public-releases fetch for owners (`context.owner`) so their SSR
  never blocks on it, but the component's public useQuery must stay UNconditional:
  it warms the list post-hydration so an ss-owner credential dying mid-session
  swaps to the public view instead of flashing the "coming soon" empty state.
  (`/download` itself is public — no feature-flag gate.)
- **`loadReleases` must stay a single SQL statement** (release-window subquery
  LEFT JOIN assets): one snapshot means a concurrent publish/unpublish flip can't
  tear the payload. Splitting it back into two queries can list a release without
  its assets and edge-cache that for up to 30 days (the purge has already run).
- The release workflow never sets visibility — new releases are born private via the
  column default; only the owner-only Publish/Unpublish buttons on /download flip it.

## /download live Preview — the app iframing itself

`<Preview company platform wallpaper?>` (components/Preview.tsx) renders the real
app in a same-origin iframe at the shell's 1280×860, scaled into a fake desktop
window (PreviewTitleBar chrome replica) over a wallpaper, then drives it like a
user (usePreviewScenario: hydrate → type → real search → click → details page).

- **The iframe's `name` must stay `DESKTOP_PREVIEW_WINDOW_NAME`**
  (`utils/desktop-preview.ts`): `window.name` is the only parent-settable channel
  readable before inline head scripts run. Preview mode = name match AND
  `self !== top` (both in desktop-init and isDesktopPreview) — window.name is
  forgeable by any site via `window.open(url, name)`, so the framed-only check
  keeps a hostile opener from flipping a real top-level tab into headerless
  preview behaviour. `desktop-init.ts` keys THREE behaviours on it pre-paint:
  stamping `data-desktop` (hides the web header, same as the Electron shell),
  patching `history.pushState` → `replaceState` (iframe SPA pushes join the
  tab's joint session history — without the patch the parent's Back button
  steps the demo backwards instead of leaving), and shadowing `sessionStorage`
  with an in-memory store (same-origin iframes share the tab's real
  sessionStorage; unshimmed, the embedded app consumes the parent's
  `hmrc-scroll-y`/`hmrc-highlight` back-nav keys and its router clobbers the
  shared `tsr-scroll-restoration` blob on unload). The shim also means
  DESKTOP_INIT_SCRIPT must stay ordered BEFORE SEARCH_INIT_SCRIPT in
  __root.tsx's head — search-input-init reads sessionStorage.
- **Framing headers must stay same-origin, not DENY** (vite.config.ts `/**`
  routeRule): `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`. Reverting
  to DENY/'none' blanks the preview; cross-site embedding is still blocked.
- **Focus-stealing needs BOTH guards**: the iframe is `inert` AND SearchBar gates
  `autoFocus` on `!isDesktopPreview()`. Don't drop either — `inert` propagation
  into iframes has browser variance, and an ungated autofocus yanks focus (and
  scroll) from /download on load.
- **The iframe mounts deferred** (`frameReady` in Preview.tsx: window `load`
  event — with a 4s safety net — then `requestIdleCallback`, setTimeout on
  Safari) so the second app copy doesn't compete with /download's own boot.
  A launch splash — a replica of the shell/PWA splash (#120817 + white wordmark;
  mirrors `.app-splash` in styles.css and `INITIAL_BG` in apps/desktop, keep in
  lockstep) — fills the window from the first measured frame and fades out only
  when the iframe fires `load` (guarded against the initial about:blank
  'complete'), so the window never sits as a bare dark pane. (True no-JS still
  shows just the empty frame: the 1280×860 box is visibility-gated on the
  JS-measured pane scale.) `usePreviewScenario` takes `ready` and gates its
  effect on it — refs changing alone never re-run effects, so dropping the
  param strands the demo unstarted.
- **PreviewTitleBar.tsx + Preview.module.css mirror the shell chrome**
  (apps/desktop/src/renderer components + style.css tokens; window 1280×860, bar
  46px, traffic lights at x:34/y:16). The shell measures the title's inset from
  its cluster edges at runtime; the preview can't, so `TitlePill` hardcodes a
  per-platform snapshot (mac left-361/right-202, win/linux left-273/right-316) —
  re-measure and update it if the shell's logo/nav/control sizing changes.
  Chrome changes in apps/desktop must be hand-mirrored here — including `cleanTitle` in
  src/utils.ts, a copy of the shell's (apps/desktop/src/main/site.ts); keep the regexes
  identical (both copies are locked by matching tests — utils.test.ts / site.test.ts). Responsive (`sm:`) variants are
  deliberately baked to the ≥sm rendering: parent-page media queries would
  otherwise restyle the chrome, while the iframe's own queries correctly use its
  1280px viewport.
- **Preview iframes must stay out of telemetry**: `beforeSend={dropPreviewEvents}`
  on Analytics + SpeedInsights in __root.tsx, and VercelToolbarMount early-returns
  via `isDesktopPreview()`.
- **`<TanStackDevtools>` must stay an unconditional top-level element** in
  __root.tsx: the devtools-vite prod strip removes the element but not a wrapping
  `cond && (...)`, leaving `cond && ()` — a build-time SyntaxError from the router
  code-splitter's re-parse.
- **Theme is mirrored live, not re-derived**: a Preview effect watches the parent
  `<html>` class and applies class + `color-scheme` to the iframe document
  (matching applyThemeMode); the app's own `useIsDark` observers (map tiles,
  skyline) react to that class. Initial load agrees via shared localStorage — the
  observer exists for post-load toggles on /download.
- The scenario detects hydration via React's `__reactProps$*` expando on the
  input and types through the iframe realm's native value setter + `input`
  events; `prefers-reduced-motion` skips the tour via `/?search=` instead.
- **Camera choreography zooms the SCENE, not the iframe content**: the hook
  emits a `PreviewShot` (a live `getBoundingClientRect()` rect in iframe-
  viewport coords, or `rect: null` for the wide shot); Preview's `shotTransform`
  maps it into pane coords (INSET_X/INSET_TOP + base scale — keep those
  constants and the anchor's inline % placement in lockstep) and transforms the
  wallpaper+window layer within the fixed pane, so moving in grows the whole
  window past the card edges like a camera approaching the app. The transitioned
  scene layer must stay separate from the untransitioned base-scale layer, and
  reduced-motion never moves the camera. The wallpaper's lens blur reads as
  rack focus ONLY because blur endpoints are proportional to the zoom
  (`LENS_BLUR_PER_ZOOM × (zoom − 1)`) and both transitions share the shot's
  duration + `CAMERA_EASE` — identical timing makes blur track zoom exactly,
  even mid-interrupt. Don't give the filter its own duration/curve, and keep
  the lens layer oversized (`-inset-6`) so the blur's edge fade stays outside
  the pane.
