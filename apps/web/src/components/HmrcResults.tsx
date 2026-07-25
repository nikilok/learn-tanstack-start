import { useRouter } from '@tanstack/react-router';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useVirtualTextLayout } from 'virtual-text-layout';

import type { HmrcRow } from '../api/hmrc';
import { useResultsKeyboardNav } from '../hooks/useResultsKeyboardNav';
import { loadStoredFilters, storeFilters } from '../lib/search/persist';
import {
  formatLocation,
  hasWebGpu,
  prefersReducedMotion,
  stampPageFlip,
} from '../utils';
import BlackHole from './BlackHole';
import HmrcCard from './HmrcCard';
import SkeletonCards from './SkeletonCards';
import UnionJackLens from './UnionJackLens';

// Vertical centre of a card's name line from its top: py-2(8) + nameLine(24)/2.
const NAME_LINE_CENTER = 20;
// Rail/marker horizontal centre, in the content box's coordinate space (x=0 is
// the card text edge). -16 sits it on the content column's left edge — the card's
// `-mx-4 px-4` opens a 16px gutter, so -16 lands exactly at the search box / column
// edge that the rest of the page aligns to.
const RAIL_X = -16;

// Paged result data the parent supplies — the shape both useHmrcSearch and
// useFilterSearch return, so the list renders either source identically.
export type SponsorResultsData = {
  results: HmrcRow[];
  isLoading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  fetchMore: () => void;
};

/**
 * Virtualized list of HMRC sponsor rows. The parent owns data fetching (name
 * search or the filter endpoint) and passes the paged rows in. Gates rendering
 * on data/fonts/width readiness (canvas-based height estimation via
 * `virtual-text-layout`) to avoid layout shift, triggers infinite-scroll
 * fetches near the end of the window, and wires up sessionStorage scroll
 * restoration. With no active filters it returns `null` for empty input and a
 * hint for short queries; `filtersActive` lifts both gates so a nameless
 * filtered browse still lists rows.
 */
export default function HmrcResults({
  search,
  filtersActive = false,
  data,
}: {
  search: string;
  filtersActive?: boolean;
  data: SponsorResultsData;
}) {
  const { results, isLoading, hasMore, loadingMore, fetchMore } = data;
  // A query is "active" when it can produce rows: a 3+ char term, or any
  // filter set (which may browse namelessly).
  const queryActive = filtersActive || search.length >= 3;
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // `activeId` only gets set when the user clicks a card on this very
  // mount (via flushSync below). On a remount after back-nav we leave it
  // null on purpose — no listing card may carry `view-transition-name:
  // active-card` at capture time, or the browser would pair it with the
  // details wrapper and morph to a mid-restore position. Back-nav relies
  // on this: it contracts the deliberately UNPAIRED old details snapshot
  // over a root crossfade (see transitions.css).
  const [activeId, setActiveId] = useState<string | null>(null);
  // The card's metadata stacks below `sm` (640px): one inline line ≥sm, two
  // lines <sm (rating+location / route chip). HmrcCard switches on the same
  // `sm:` breakpoint, so fixedHeight must switch with it or row heights desync.
  const [isNarrow, setIsNarrow] = useState(
    () =>
      typeof window !== 'undefined' &&
      !window.matchMedia('(min-width: 640px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    const onChange = () => setIsNarrow(!mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const { estimateSize, ready, contentWidth } = useVirtualTextLayout(results, {
    fields: [
      {
        // Previous-name renders as ONE truncated line when a match exists, else
        // nothing — so measure a single-glyph sentinel (always 1 line) when
        // present and '' (0 lines) when not, never the real (truncated) text.
        getText: (row) => (row.matchedPreviousName ? 'M' : ''),
        font: 'italic 12px Geist', // text-xs italic
        lineHeight: 16,
      },
      {
        // Location is inline ≥sm (no extra height) but stacks onto its OWN line <sm.
        // getText MUST stay row-data-only: virtual-text-layout caches each row's
        // getText output once (rebuilt only when results shrink), so gating it on
        // isNarrow would freeze the height at the first-measured breakpoint and
        // desync after a runtime resize across 640px. The breakpoint switch lives in
        // lineHeight, which the estimator reads fresh every call — <sm 24 (20px line
        // + 4px stack gap), ≥sm 0 (inline, no extra height).
        getText: (row) => (formatLocation(row.locality, row.region) ? 'M' : ''),
        font: '14px Geist', // text-sm
        lineHeight: isNarrow ? 24 : 0,
      },
    ],
    // Name is single-line (truncate). Metadata is one inline line ≥sm; <sm it
    // stacks (rating / location / chip). Rating+chip are always present so they
    // are fixed; the variable location line is the `fields[]` entry above.
    //   py-2(8) + name(24) + mt-1(4) + base-meta + py-2(8) + 4 (rounding)
    //   ≥sm: base-meta = 20               -> 68
    //   <sm: base-meta = 20 + gap-1(4) + 20 -> 92  (+24 per location line)
    fixedHeight: isNarrow ? 92 : 68,
    containerRef: listRef,
  });

  const virtualizer = useWindowVirtualizer({
    count: ready ? results.length : 0,
    estimateSize,
    gap: 24,
    overscan: 5,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  useEffect(() => {
    if (contentWidth > 0) virtualizer.measure();
  }, [contentWidth, isNarrow, virtualizer]);

  const {
    highlightedIndex,
    rotation: lensRotation,
    moveHighlight,
  } = useResultsKeyboardNav({
    count: results.length,
    virtualizer,
    onActivate: (index) => {
      const link = listRef.current?.querySelector<HTMLAnchorElement>(
        `[data-index="${index}"] a`,
      );
      link?.click();
    },
  });

  // Auto-select the first row (or restore the previously activated one on
  // back-nav) once results are available for the current search. We do the
  // lookup here rather than in the hook because it requires the actual row
  // data — virtual indices aren't stable when the virtualizer rerenders or
  // results refetch, so we save the row's stable slugId on click and find it
  // again here.
  const lastRestoredSearchRef = useRef<string | null>(null);
  // useLayoutEffect (not useEffect) so the highlight is committed before the
  // browser paints / view-transition snapshots — otherwise the back-nav
  // transition captures a frame with highlight=-1 and the lens never appears
  // until after the animation, often imperceptibly.
  useLayoutEffect(() => {
    if (results.length === 0) return;
    if (lastRestoredSearchRef.current === search) return;
    lastRestoredSearchRef.current = search;
    let initial = 0;
    const saved = sessionStorage.getItem('hmrc-highlight');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as {
          search?: string;
          slugId?: string;
        };
        if (parsed.search === search && parsed.slugId) {
          const idx = results.findIndex((r) => r.slugId === parsed.slugId);
          if (idx >= 0) initial = idx;
        }
      } catch {
        // ignore malformed entry
      }
    }
    moveHighlight(initial);
  }, [results, search, moveHighlight]);

  // Mirror the router's intent-preload for keyboard nav: <Link> only fires
  // intent on hover/focus, which arrow-key nav never triggers. Debounce by
  // 150ms so a held arrow key doesn't spam preloads for every row passed.
  useEffect(() => {
    if (highlightedIndex < 0) return;
    const row = results[highlightedIndex];
    if (!row) return;
    const timer = setTimeout(() => {
      router.preloadRoute({
        to: '/company/$id/$slug',
        params: { id: row.slugId, slug: row.nameSlug },
        search: { search },
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [highlightedIndex, results, router, search]);

  const virtualItems = virtualizer.getVirtualItems();

  // Vertical offset of the Union Jack marker on the rail — the name-line centre
  // of the highlighted row, in the content box's coordinate space (same frame
  // the rows are translated into). Null when that row isn't currently rendered
  // (scrolled out of the overscan window), in which case the marker is hidden.
  const highlightedItem = virtualItems.find(
    (v) => v.index === highlightedIndex,
  );
  const markerY =
    highlightedItem != null
      ? highlightedItem.start -
        virtualizer.options.scrollMargin +
        NAME_LINE_CENTER
      : null;

  useEffect(() => {
    if (!ready) return;
    const savedY = sessionStorage.getItem('hmrc-scroll-y');
    if (savedY) {
      // Scroll first, then clear the key — in that order, atomically inside
      // a single rAF. If we cleared the key before the rAF fired, there
      // would be a one-frame window where `scrollY === 0` AND the key is
      // gone, which `useSearchPill`'s safety-net poll reads as "nothing to
      // restore" and clears `data-hide-search-input` prematurely. That would
      // briefly unhide the input on a scrolled back-nav restore.
      requestAnimationFrame(() => {
        window.scrollTo(0, Number.parseInt(savedY, 10));
        sessionStorage.removeItem('hmrc-scroll-y');
      });
    }
  }, [ready]);

  // Discard a stranded scroll key on any mount that cannot restore (empty/short
  // query or zero rows) so the next full load's pre-hydration script can't hide
  // the input with no consumer left to clear it. The guard keeps the key alive
  // through a genuine pending restore (search>=3 while loading or with rows), so
  // the restore effect above stays its sole consumer and the back-nav race holds.
  const hasRows = results.length > 0;
  useEffect(() => {
    const canRestore = queryActive && (isLoading || hasRows);
    // A stored filter set means a bare full-load mount is about to rehydrate
    // into filter mode (index.tsx) — its restore is pending, not stranded.
    if (!canRestore && !loadStoredFilters()) {
      sessionStorage.removeItem('hmrc-scroll-y');
    }
  }, [queryActive, isLoading, hasRows]);

  useEffect(() => {
    const lastItem = virtualItems[virtualItems.length - 1];
    if (!lastItem) return;
    if (lastItem.index >= results.length - 10 && hasMore && !loadingMore) {
      fetchMore();
    }
  }, [virtualItems, results.length, hasMore, loadingMore, fetchMore]);

  // Save scroll position on pagehide so the pre-hydration script in <head> can
  // hide the input on the next load. Only registered when there are results to
  // scroll past — otherwise iOS keyboard auto-scroll on input focus would write
  // a meaningless value that nothing consumes, leaving the input hidden.
  useEffect(() => {
    if (results.length === 0) return;
    const onPageHide = () => {
      // Match the reader's `parseInt > 0` gate — sub-pixel scroll floors to 0.
      if (window.scrollY >= 1) {
        sessionStorage.setItem('hmrc-scroll-y', String(window.scrollY));
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [results.length]);

  // The full-bleed black-hole "no organisations found" scene. It must persist across
  // the brief isLoading flips that happen while refining a search that stays empty —
  // otherwise the fullscreen hole would unmount → remount (replaying its zoom + GPU
  // setup) on every committed term. `wasEmptyRef` remembers that the prior settled
  // state was empty, so a refine FROM empty keeps the scene up instead of flashing
  // skeletons; it resets once results arrive or the query drops below 3 chars.
  const confirmedEmpty = !isLoading && queryActive && results.length === 0;
  const wasEmptyRef = useRef(false);
  useEffect(() => {
    if (confirmedEmpty) wasEmptyRef.current = true;
    else if (results.length > 0 || !queryActive) wasEmptyRef.current = false;
  }, [confirmedEmpty, results.length, queryActive]);
  // The loading disjunct keeps the WebGPU hole mounted across refine-loads (no zoom
  // replay). It's gated on hasWebGpu() because without a hole there's nothing to preserve
  // — keeping the (message-gated-off) scene up would just show a blank layer, so a
  // no-WebGPU client falls through to skeletons instead. (search>=3 holds at the use site.)
  const showScene =
    confirmedEmpty || (isLoading && wasEmptyRef.current && hasWebGpu());

  if (!filtersActive && search.length === 0) return null;

  if (!filtersActive && search.length < 3) {
    return (
      <p className="mt-4 text-sm text-(--sea-ink-soft)">
        Type at least 3 characters to search...
      </p>
    );
  }

  // No matches: the full-bleed black hole anchored off the right edge. Rendered before
  // the skeleton branch so it stays mounted through refine-loads (see `showScene`) — the
  // zoom plays once, no remount. The message is gated on `confirmedEmpty` (NOT the loading
  // hold) so we never assert "not found" for a refined term that may still return matches.
  if (showScene) {
    return (
      <>
        <BlackHole fullscreen className="z-0" />
        {confirmedEmpty && (
          <div className="relative z-10 mt-12 flex flex-col items-center gap-3 px-4 sm:mt-16">
            {/* Frosted surface scrim so the message stays readable over the bright
                disk — on mobile the hole fills the screen, so the text always sits on
                it. `--surface` + `--sea-ink` keep normal page contrast in both themes. */}
            <p
              className="max-w-sm rounded-2xl px-4 py-2 text-center text-sm text-(--sea-ink) shadow-md backdrop-blur-md"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--surface) 85%, transparent)',
              }}
            >
              {!filtersActive
                ? `No organisations found matching “${search}”`
                : search.length >= 3
                  ? `No organisations found matching “${search}” with your filters`
                  : 'No organisations match these filters'}
            </p>
            {/* Users forget filters are on — offer the exit right where the dead end happens.
                Same semantics AND styling as /filters' Reset, minus its `R` keycap: this
                surface is type-to-search, so a bare letter belongs to the input. */}
            {filtersActive && (
              <button
                type="button"
                onClick={() => {
                  storeFilters({});
                  void router
                    .navigate({ to: '/', search: { search } })
                    .then(() => {
                      // Land in the normal starting state (see /filters' apply).
                      window.scrollTo(0, 0);
                      requestAnimationFrame(() => window.scrollTo(0, 0));
                    });
                }}
                className="cursor-pointer rounded-full border-none bg-(--logo-red) px-4 py-2 text-sm font-medium text-(--bg-base) shadow-[0_0_10px_1px_color-mix(in_srgb,var(--logo-red)_50%,transparent)] transition hover:opacity-90"
              >
                Reset filters
              </button>
            )}
          </div>
        )}
        {/* Hidden width-measurement div (same px-4 as the list) so `ready` is set during
            the scene — else a later cached refine flashes skeletons just to measure width. */}
        <div
          ref={listRef}
          className="px-4"
          style={{ height: 0, overflow: 'hidden' }}
        />
      </>
    );
  }

  if (isLoading || !ready) {
    return (
      <>
        <SkeletonCards />
        {/* Hidden element for width measurement — same px-4 as the real container */}
        <div
          ref={listRef}
          className="px-4"
          style={{ height: 0, overflow: 'hidden' }}
        />
      </>
    );
  }

  return (
    <div ref={listRef} className="mt-6 px-4 py-2">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          // Floor the height so the rail runs down to near the page bottom even
          // when only a few rows match; tall result sets exceed it and win.
          minHeight: 'calc(100dvh - 16rem)',
          width: '100%',
          position: 'relative',
        }}
      >
        {/* Continuous thin rail down the left gutter — the straight line the
            Union Jack marker rides; spans the full (floored) list height. The
            `guide-rail` class paints it with the hero "streaks" spectrum gradient
            (see styles.css) so it reads as part of the empty-state colourful grid. */}
        <span
          aria-hidden
          className="guide-rail pointer-events-none absolute top-0 bottom-0 w-px rounded-full"
          style={{ left: RAIL_X, transform: 'translateX(-50%)' }}
        />
        {/* The marker sits ON the rail at the highlighted row. Its `top` updates
            with no transition so it tracks the highlight instantly — a slide here
            visibly lags and jitters under fast key-repeat (held arrow scrolling).
            Hidden when that row is scrolled out of the rendered window. */}
        {markerY != null && (
          <span
            aria-hidden
            className="pointer-events-none absolute z-10 block h-5 w-5"
            style={{
              left: RAIL_X,
              top: markerY,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <UnionJackLens
              key={highlightedIndex}
              className="h-full w-full"
              fromDeg={lensRotation.from}
              toDeg={lensRotation.to}
              durationMs={prefersReducedMotion() ? 0 : 720}
            />
          </span>
        )}
        {virtualItems.map((virtualRow) => (
          <div
            key={virtualRow.index}
            data-index={virtualRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            <HmrcCard
              row={results[virtualRow.index]}
              search={search}
              isActive={activeId === results[virtualRow.index].slugId}
              isHighlighted={highlightedIndex === virtualRow.index}
              onActivate={() => {
                stampPageFlip('forward');
                // flushSync forces React to commit the state update before
                // TanStack Router's click handler triggers
                // startViewTransition — otherwise the OLD snapshot would be
                // captured before the active card has its name applied.
                flushSync(() => {
                  setActiveId(results[virtualRow.index].slugId);
                });
              }}
            />
          </div>
        ))}
      </div>
      {loadingMore && <SkeletonCards count={3} bare />}
    </div>
  );
}
