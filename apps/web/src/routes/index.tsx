import {
  canonicalSearchParams,
  filterParamsOf,
  filterSearchKey,
  searchTermInput,
  type SearchUrlParams,
} from '@ss/search-filters';
import { useQuery } from '@tanstack/react-query';
import {
  createFileRoute,
  stripSearchParams,
  useLocation,
  useNavigate,
} from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { askSearch, prepareAsk } from '../api/ask';
import { searchFiltered } from '../api/filterSearch';
import { searchHmrc, sponsorCountQueryOptions } from '../api/hmrc';
import HeroText from '../components/HeroText';
import HmrcResults from '../components/HmrcResults';
import SearchBar from '../components/SearchBar';
import SkeletonCards from '../components/SkeletonCards';
import { useFilterSearch } from '../hooks/useFilterSearch';
import { useHmrcSearch } from '../hooks/useHmrcSearch';
import { parsePlatform } from '../hooks/usePlatform';
import { useSearchPill } from '../hooks/useSearchPill';
import { hasOwnerHint } from '../lib/ask/access-hint';
import { markAskAccess as markAskAccessOnServer } from '../lib/ask/access-hint.server';
import {
  type AppliedAsk,
  clearApplied,
  loadApplied,
  saveApplied,
} from '../lib/ask/applied-store';
import {
  askEligible,
  askWordCount,
  extendsEmptyPrefix,
  MAX_QUESTION_CHARS,
  MIN_ASK_WORDS,
} from '../lib/ask/eligibility';
import { applyOverlay, describeFilters, paramsKey } from '../lib/ask/overlay';
import {
  type AskAccess,
  askEntry,
  askEntryState,
  type AskProgress,
  listedRanking,
  deriveAskHint,
  initialAskAccess,
  nextEmptyPrefix,
  reconcileApplied,
} from '../lib/ask/session';
import { readinessSnapshot, subscribeReadiness } from '../lib/device/beacons';
import { WAITING } from '../lib/device/readiness';
import { hydrationDone } from '../lib/hydration';
import { startListing } from '../lib/search/listing-prefetch';
import { loadStoredFilters, storeFilters } from '../lib/search/persist';
import { listingRenderedHere } from '../lib/session/listing';
import { buildCanonical } from '../utils/canonical';
import { isDesktopPreview } from '../utils/desktop-preview';
import { buildWebsiteJsonLd } from '../utils/jsonld';
import { jsonLdMeta } from '../utils/seo';

const getPlatformInfo = createIsomorphicFn()
  .client(() => parsePlatform(navigator.userAgent))
  .server(() => parsePlatform(getRequestHeader('user-agent') ?? ''));

// The document's own response leaves the owner hint beside the owner cookie,
// or takes a stale one off (lib/ask/access-hint.server). The client never
// asks the server whether it may ask, so a client navigation does nothing.
const markAskAccess = createIsomorphicFn()
  .client(async () => {})
  .server(markAskAccessOnServer);

// Home-only head bits, static so they build once: the canonical URL plus the WebSite name/alias schema search engines read site identity from.
const HOME_CANONICAL = buildCanonical('/');
const WEBSITE_JSONLD_META = jsonLdMeta(buildWebsiteJsonLd(HOME_CANONICAL));

// What a bare mount renders while the rehydrate effect below re-applies the
// stored filters: a loading frame, so the classic hook neither fires a
// spurious name search nor lets a pending scroll restore be discarded.
const PENDING_FILTER_DATA = {
  results: [],
  isLoading: true,
  failed: false,
  moreFailed: false,
  retry: () => {},
  hasMore: false,
  loadingMore: false,
  fetchMore: () => {},
};

/** The server snapshot of device readiness: nothing is ready before hydration. */
const serverSnapshot = () => WAITING;

// Stable snapshots of the ask's progress, so setting one again is no render.
const ASK_IDLE: AskProgress = { status: 'idle' };
const ASK_PENDING: AskProgress = { status: 'pending' };
const ASK_UNAVAILABLE: AskProgress = { status: 'unavailable' };

/** The home route's search as the registry validates it: the name term plus the filter params alone (`filterParamsOf`: a param that filters nothing never puts the page into filter mode). */
function validateHomeSearch(search: Record<string, unknown>) {
  return { search: searchTermInput(search.search), ...filterParamsOf(search) };
}

export const Route = createFileRoute('/')({
  // The name term (`search`) plus the URL-form filter params from /filters.
  // `q` is stripped: on this surface the name term only comes from `search`.
  validateSearch: validateHomeSearch,
  search: {
    // Value-strip of a REQUIRED key: runtime-supported (and long-standing
    // behavior here), but PickOptional-typed to optional keys only — the
    // filter params joining the schema surfaced that, hence the cast.
    middlewares: [stripSearchParams({ search: '' } as never)],
  },
  head: () => ({
    meta: WEBSITE_JSONLD_META,
    links: [{ rel: 'canonical', href: HOME_CANONICAL }],
  }),
  beforeLoad: async () => {
    await markAskAccess();
    return { platformInfo: getPlatformInfo() };
  },
  loaderDeps: ({ search }) => ({ search }),
  loader: async ({ context: { queryClient }, deps }) => {
    if (typeof window !== 'undefined') return;
    const { search: term, ...params } = (
      deps as { search: { search: string } & Record<string, unknown> }
    ).search;
    // Streamed with the document for the owner and a crawler only: anyone
    // else's results load in the browser through their session.
    await startListing({
      term,
      params,
      rendered: listingRenderedHere,
      // Don't await — let the query stream in while the shell renders. Keys
      // and params must mirror useFilterSearch and useHmrcSearch exactly.
      start: (listing) =>
        listing.kind === 'filter'
          ? queryClient.prefetchInfiniteQuery({
              queryKey: ['filter-search', filterSearchKey(listing.filters)],
              queryFn: () =>
                searchFiltered({
                  data: { params: listing.filters, offset: 0 },
                }),
              initialPageParam: 0,
            })
          : queryClient.prefetchInfiniteQuery({
              queryKey: ['hmrc-search', listing.term],
              queryFn: () =>
                searchHmrc({ data: { query: listing.term, offset: 0 } }),
              initialPageParam: 0,
            }),
    });
  },
  component: Home,
});

/**
 * Landing page component: renders the search bar (with sticky/pill behavior
 * via `useSearchPill`) and a Suspense-wrapped `HmrcResults` list. Debounces
 * typing by 450ms before pushing the query into the `search` URL param via
 * `navigate({ replace: true })` so history isn't spammed on each keystroke.
 */
function Home() {
  // Read from the router's location, the store a history entry's state is
  // read from, so the URL and the entry never disagree within one render:
  // the route's own search follows a tick later, with the match.
  const rawSearch = useLocation({ select: (l) => l.search });
  const { search, ...urlFilters } = useMemo(
    () => validateHomeSearch(rawSearch as Record<string, unknown>),
    [rawSearch],
  );
  const hasFilters = Object.values(urlFilters).some(
    (value) => value !== undefined,
  );
  // Live input value (updates on every keystroke); the `search` URL param is
  // debounced 450ms, so we gate the hero on this to hide it instantly on type.
  const [liveQuery, setLiveQuery] = useState(search);
  // Re-sync when `search` changes from outside the input (header logo, back/
  // forward, programmatic nav) so the hero/sticky gate never goes stale. During
  // typing this is a no-op: the debounce only commits the latest value, which
  // onSearch already wrote to liveQuery.
  useEffect(() => {
    setLiveQuery(search);
  }, [search]);
  // Non-blocking: SSR-hydrated, streams in on cold client navs (may be undefined).
  const { data: sponsorCount } = useQuery(sponsorCountQueryOptions);
  const { platformInfo } = Route.useRouteContext();
  const navigate = useNavigate();
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askRunRef = useRef(0);
  // Drop a pending debounce on unmount: it navigates with `replace: true`, so
  // firing after a nav away replaces THAT entry. A pending ask is retired the
  // same way, or its plan would land on whatever page came next.
  useEffect(
    () => () => {
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
      askRunRef.current++;
    },
    [],
  );
  const sentinelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isStuck, ready, pillClicked, onPillClick, onPillDismiss } =
    useSearchPill(inputRef, sentinelRef);

  // A bare-URL SPA mount (details back-link, header logo) with a stored
  // filter set is about to rehydrate into filter mode — known synchronously,
  // so the transient render never runs the classic search. False on the
  // hydration mount by construction (hydrationDone), so server HTML matches.
  const [pendingStoredFilters, setPendingStoredFilters] = useState(
    () => hydrationDone() && !hasFilters && loadStoredFilters() != null,
  );

  // Ask (lib/ask): a description that found nothing by name can be asked as
  // a question on Enter, and the plan's filters overlay whatever was set by
  // hand. The filters then live in the URL and the durable store like any
  // applied set; the question, its chips and the base to restore are kept for
  // the tab (applied-store), so a company page's back link brings the whole
  // listing back. Editing or clearing the text restores the base. The state
  // rules live in lib/ask/session; this is their wiring.
  const readiness = useSyncExternalStore(
    subscribeReadiness,
    readinessSnapshot,
    serverSnapshot,
  );
  const [askProgress, setAskProgress] = useState<AskProgress>(ASK_IDLE);
  // Known at mount from the owner hint the document's own response left
  // (lib/ask/access-hint.server), so an owner's offer never waits on a mint
  // and nobody else mints at all. Off on the hydration mount by construction
  // (server HTML matches); the layout effect opens it before the first paint,
  // and costs a document without the hint nothing.
  const [askAccess, setAskAccess] = useState<AskAccess>(() =>
    hydrationDone() ? initialAskAccess(hasOwnerHint()) : 'off',
  );
  useLayoutEffect(() => {
    if (hasOwnerHint()) setAskAccess('open');
  }, []);
  // This history entry's state: an entry the ask produced carries its plan
  // (lib/ask/session). One object per entry, so it is a stable dependency.
  const entryState = useLocation({ select: (l) => l.state });
  const [applied, setApplied] = useState<AppliedAsk | null>(null);
  // Read at the moment a debounced commit fires: a plan can land between the
  // keystroke and its timer, and the commit must then end it, not type on it.
  const appliedRef = useRef<AppliedAsk | null>(null);
  appliedRef.current = applied;
  const askedRef = useRef('');
  const queuedAskRef = useRef<string | null>(null);
  // The shortest text the offer has stood on: a text that only adds to it
  // keeps the offer up while its own search runs, instead of flickering
  // through skeletons for every word added to an empty text.
  const [emptyPrefix, setEmptyPrefix] = useState<string | null>(null);

  const urlParamsKey = paramsKey(urlFilters as SearchUrlParams);
  // The ranking the listing is restricted to (lib/ask/session): the applied
  // plan's while the URL holds its filters, else the entry's while the plan
  // is being restored onto it, and nothing on the hydration render.
  const ranking = listedRanking({
    applied,
    entry: askEntry(entryState),
    urlKey: urlParamsKey,
    hydrated: hydrationDone(),
  });
  const rankedMode = ranking !== null;
  const listingMode = hasFilters || pendingStoredFilters || rankedMode;
  // The data sources stay mounted; only one is live. No filters → the
  // classic name search exactly as before ('' disables it via the >=3 gate).
  // Any filter → the filter endpoint serves the listing, with the typed term
  // passed through as `q` once it reaches 3 chars. A question that said what
  // the organisations do → the same listing restricted to its ranking.
  const classic = useHmrcSearch(listingMode ? '' : search);
  const filtered = useFilterSearch(
    { ...urlFilters, q: search.length >= 3 ? search : undefined },
    { enabled: hasFilters && !rankedMode },
  );
  const rankedListing = useFilterSearch(urlFilters, {
    enabled: rankedMode,
    ranked: ranking?.ranked ?? [],
  });
  const resultsData = rankedMode
    ? rankedListing
    : hasFilters
      ? filtered
      : pendingStoredFilters
        ? PENDING_FILTER_DATA
        : classic;
  // A new text is a new chance to ask; the text being asked is not. A run
  // still in flight for the old text is retired, so its plan never lands on
  // what was typed since.
  useEffect(() => {
    if (search !== askedRef.current) {
      askRunRef.current++;
      queuedAskRef.current = null;
      setAskProgress(ASK_IDLE);
    }
  }, [search]);
  /**
   * Ends the plan: forgets the tab's record and retires any run. The durable
   * store follows the URL (the effect below), so a store still holding the
   * plan's filters gets the hand-set base written back, and nothing
   * re-applies the plan's filters as if set by hand; a store a Reset emptied
   * stays empty. The plan's own history entry still carries it, so Forward
   * or Back onto that entry brings the chips back. Returns the base.
   */
  const endAsk = (live: AppliedAsk): SearchUrlParams => {
    setApplied(null);
    clearApplied();
    askRunRef.current++;
    const stored = loadStoredFilters();
    if (stored && paramsKey(stored) === live.mergedKey) storeFilters(live.base);
    return live.base;
  };
  // What the URL arriving somewhere means for the plan (lib/ask/session):
  // moving off its filters ends it; an entry the ask produced (its landing,
  // Forward or Back onto it, a reload, the stored set re-applied after a
  // company page) restores the plan it carries; any other filter URL
  // discards a record a plan left behind while this page was away.
  useEffect(() => {
    const entry = askEntry(entryState);
    const action = reconcileApplied({
      applied,
      hasFilters,
      urlKey: urlParamsKey,
      entry,
      record: loadApplied(),
    });
    if (action === 'end' && applied) endAsk(applied);
    else if (action === 'restore' && entry) {
      setApplied(entry);
      // Live again, so a company page's back link brings it back too.
      saveApplied(entry);
    } else if (action === 'discard') clearApplied();
    // endAsk reads nothing the deps do not carry.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, hasFilters, urlParamsKey, entryState]);
  const queryActive = hasFilters || search.length >= 3;
  const confirmedEmpty =
    !resultsData.isLoading && queryActive && resultsData.results.length === 0;
  // A text that only adds to the one the offer stood on keeps the offer up
  // while its own search runs: it reads as askable before it settles.
  const holding =
    applied === null &&
    askAccess === 'open' &&
    resultsData.isLoading &&
    extendsEmptyPrefix(search, emptyPrefix);
  const preview = isDesktopPreview();
  // Open access is enough to offer: the device key the ask needs can arrive
  // seconds after the search settles, and the offer must not wait on it, or
  // the scene would claim "not found" first. A document that can never have
  // one is not offered.
  const couldAsk = askEligible({
    confirmedEmpty: confirmedEmpty || holding,
    text: search,
    ready: askAccess === 'open' && readiness.status !== 'off',
    preview,
  });
  // The token is minted the first time the offer would show, so Enter has it
  // ready. The loader shares one mint per document, so re-runs cost nothing;
  // a mint that fails leaves access as it was and is tried again on the next
  // text, and a refused one closes the document: the hint is no credential.
  useEffect(() => {
    if (!couldAsk || readiness.status !== 'ready') return;
    let stale = false;
    prepareAsk(readiness.key).then(
      (open) => {
        if (!stale) setAskAccess(open ? 'open' : 'off');
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [couldAsk, readiness, search]);
  // The key the offer names: the modifier /filters applies on too, so plain
  // Enter keeps opening the highlighted result; a touch device taps the arrow.
  const askKey = platformInfo.isMobile
    ? null
    : platformInfo.platform === 'mac'
      ? '⌘'
      : 'Ctrl';
  // Without access this is today's flow exactly: the no-results scene shows as
  // it always has, and nothing here says otherwise.
  const { eligible, hint: askHint } = deriveAskHint({
    applied: applied !== null,
    access: askAccess,
    progress: askProgress,
    couldAsk,
    shortcut: askKey,
  });
  // A running ask holds the prefix as a load does: the text may move on
  // before it answers, and the offer must hold through that text's search.
  const prefixHeld = resultsData.isLoading || askProgress.status === 'pending';
  useEffect(() => {
    setEmptyPrefix((prefix) =>
      nextEmptyPrefix(prefix, { eligible, loading: prefixHeld, search }),
    );
  }, [eligible, prefixHeld, search]);

  /** Runs one ask for `text` with the device key: the plan's filters land in the URL over the hand-set base, on an entry marked as the ask's own. */
  const runAsk = (text: string, key: string) => {
    const base = urlFilters as SearchUrlParams;
    const run = ++askRunRef.current;
    askSearch(text, key, base).then(
      (outcome) => {
        if (run !== askRunRef.current) return;
        if (outcome.status === 'off') {
          setAskAccess('off');
          setAskProgress(ASK_IDLE);
          return;
        }
        if (outcome.status === 'unavailable') {
          setAskProgress(ASK_UNAVAILABLE);
          return;
        }
        const ranking = outcome.ranking;
        if (!Object.keys(outcome.filters).length && !ranking) {
          setAskProgress({ status: 'empty', reason: outcome.reason });
          return;
        }
        // Keyed and navigated in the registry's canonical form: the URL the
        // plan lands on is what the router validates, not the raw merge.
        const merged = canonicalSearchParams(
          applyOverlay(base, outcome.filters),
        );
        const plan: AppliedAsk = {
          text,
          base,
          mergedKey: paramsKey(merged),
          chips: describeFilters(outcome.filters),
          ranking,
        };
        // Kept for the tab before the move, so a company page's back link
        // brings it back; the entry itself carries it too (the effect above
        // restores it on arrival), and it is set here as well for a tab
        // whose storage refused the record.
        saveApplied(plan);
        // The filters replace the name term: the question is not a name. The
        // text moving off the asked one retires this run and resets the
        // progress, so nothing here depends on the run any more.
        void navigate({
          to: '/',
          search: { search: '', ...merged },
          state: askEntryState(plan),
        }).then(() => setApplied(plan));
      },
      () => {
        if (run === askRunRef.current) setAskProgress(ASK_UNAVAILABLE);
      },
    );
  };
  // An ask made before the device key exists waits for it, as pending, and
  // learns with it when none will come.
  useEffect(() => {
    const text = queuedAskRef.current;
    if (readiness.status === 'waiting' || text === null) return;
    queuedAskRef.current = null;
    if (readiness.status === 'ready') runAsk(text, readiness.key);
    else setAskProgress(ASK_UNAVAILABLE);
    // runAsk reads render-time values the ask was made against.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [readiness]);

  /**
   * Asks the text the box holds, as the modifier plus Enter and the arrow
   * do: commits it to the URL first, debounce or not, so the URL and the
   * answer agree on what was asked, then runs the ask, or queues it until
   * the device key arrives. Below the word floor or over the length cap
   * nothing happens, as the offer says.
   */
  const onAsk = () => {
    const text = (inputRef.current?.value ?? search).trim();
    if (
      askWordCount(text) < MIN_ASK_WORDS ||
      [...text].length > MAX_QUESTION_CHARS
    )
      return;
    if (navTimerRef.current) clearTimeout(navTimerRef.current);
    if (text !== search) {
      void navigate({
        to: '/',
        search: (prev) => ({ ...prev, search: text }),
        replace: true,
      });
    }
    askedRef.current = text;
    setAskProgress(ASK_PENDING);
    if (readiness.status === 'ready') runAsk(text, readiness.key);
    else if (readiness.status === 'off') setAskProgress(ASK_UNAVAILABLE);
    else queuedAskRef.current = text;
  };

  /** Drops the question's what-they-do part: the listing becomes its filters alone, on the same entry; with no filters left, the question is cleared. */
  const dropRanking = () => {
    const live = appliedRef.current;
    if (!live?.ranking) return;
    if (!live.chips.length) {
      clearAsk();
      return;
    }
    const next: AppliedAsk = { ...live, ranking: null };
    saveApplied(next);
    setApplied(next);
    void navigate({
      to: '/',
      search: { search: '', ...urlFilters },
      replace: true,
      state: askEntryState(next),
    });
  };

  /** Clears the question through the input's own clear path, which ends the ask and restores the base filters. The native setter keeps React's value tracker in step, whichever event the input binds. */
  const clearAsk = () => {
    const el = inputRef.current;
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (setter) setter.call(el, '');
    else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // Applied filters are durable: the URL is authoritative when it carries
  // them. A question's filters are stored like any others: that is what
  // brings its listing back from a company page. Declared after the plan's
  // reconciliation above, and it must stay there: on a URL that moved off a
  // plan, that effect reads the store before this one rewrites it.
  useEffect(() => {
    if (hasFilters)
      storeFilters(JSON.parse(urlParamsKey) as Record<string, unknown>);
  }, [hasFilters, urlParamsKey]);
  // Navs that only carry the name term (a company page's back link, the
  // header logo) get the stored set re-applied, with the tab's record riding
  // along when the set is its plan's; a question that only ranked has no set,
  // so its record alone comes back the same way. The only way OUT of filter
  // mode is /filters' Reset, which empties the store. A question's own entry
  // on a bare URL carries it already, and the stored set waits.
  useEffect(() => {
    if (hasFilters) return;
    const entry = askEntry(entryState);
    if (entry?.ranking && entry.mergedKey === urlParamsKey) return;
    const stored = loadStoredFilters();
    const record = loadApplied();
    if (stored) {
      navigate({
        to: '/',
        search: { search, ...stored },
        replace: true,
        ...(record !== null && record.mergedKey === paramsKey(stored)
          ? { state: askEntryState(record) }
          : {}),
      });
    } else if (record?.ranking && record.mergedKey === urlParamsKey) {
      navigate({
        to: '/',
        search: { search },
        replace: true,
        state: askEntryState(record),
      });
    } else {
      // Nothing to rehydrate (e.g. cleared in another tab) — release the
      // pending frame so the classic path takes over.
      setPendingStoredFilters(false);
    }
  }, [hasFilters, urlParamsKey, search, navigate, entryState]);

  // Empty state: the hero is shown and the search bar scrolls away with the
  // page (not sticky). It only sticks once a query or filter set exists.
  const heroVisible =
    liveQuery.length === 0 &&
    search.length === 0 &&
    !hasFilters &&
    !pendingStoredFilters &&
    !rankedMode;
  // data-search-pinned gates SearchInput's translateZ cursor fix and must
  // track a typed query ONLY: stamped with an empty input (nameless filter
  // mode) it garbles the rotating placeholder on iOS Safari (see CLAUDE.md).
  const hasQueryText =
    liveQuery.length > 0 || search.length > 0 || applied !== null;

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-16">
      <section className="mx-auto max-w-2xl">
        {/* The page's only h1 — the visual hero is the stat h2 in HeroText. */}
        <h1 className="sr-only">
          UK Sponsor Search — find licensed Skilled Worker visa sponsors in the
          UK
        </h1>
        <p className="island-kicker mb-3">
          Find UK companies that sponsor visas
          {!platformInfo.isMobile && (
            <span
              style={{
                opacity: hasFilters || search.length >= 3 ? 1 : 0,
                transition: 'opacity 250ms ease',
                pointerEvents: 'none',
                color: 'var(--kicker)',
              }}
            >
              {' · '}
              <kbd>↑</kbd> <kbd>↓</kbd> to navigate
              {' · '}
              {eligible && askKey ? (
                <>
                  <kbd>{askKey}</kbd> <kbd>↵</kbd> to ask
                </>
              ) : (
                <>
                  <kbd>↵</kbd> to view
                </>
              )}
            </span>
          )}
        </p>
        <div ref={sentinelRef} className="pointer-events-none mt-6" />
        <div
          data-sticky-search
          data-search-pinned={hasQueryText ? '' : undefined}
          className={`pointer-events-none z-40 -mx-4 px-4 ${
            heroVisible
              ? 'relative pb-4'
              : isStuck && pillClicked
                ? 'search-glow fixed top-[61px] right-0 left-0 mx-auto max-w-2xl pt-2 pb-4 sm:top-[77px]'
                : 'sticky top-[69px] pb-4 sm:top-[85px]'
          }`}
        >
          <SearchBar
            search={applied?.text ?? search}
            isStuck={isStuck}
            ready={ready}
            pillClicked={pillClicked}
            filtersActive={listingMode}
            inputRef={inputRef}
            platform={platformInfo.platform}
            isMobile={platformInfo.isMobile}
            onSearch={(value) => {
              setLiveQuery(value);
              if (navTimerRef.current) clearTimeout(navTimerRef.current);
              // Editing or clearing the question ends the ask: the base set
              // by hand comes back under the new text. Decided when the commit
              // fires, so a plan that lands between the keystroke and its
              // timer is ended too, never typed on top of.
              const commit = () => {
                const live = appliedRef.current;
                if (live) {
                  const base = endAsk(live);
                  void navigate({
                    to: '/',
                    search: { search: value, ...base },
                    replace: true,
                  });
                  return;
                }
                void navigate({
                  to: '/',
                  // Functional update: typing must not wipe active filters.
                  search: (prev) => ({ ...prev, search: value }),
                  replace: true,
                });
              };
              // A landed plan is ended at once: no debounce for its rows to
              // outlive the chips, and no later keystroke to lose the base to.
              if (applied) commit();
              else navTimerRef.current = setTimeout(commit, 450);
            }}
            onPillClick={onPillClick}
            onBlur={onPillDismiss}
            askEnabled={eligible}
            onAsk={onAsk}
          />
        </div>

        {applied && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-(--sea-ink-soft)">From your question:</span>
            {applied.ranking && (
              <span
                className="rounded-full p-px"
                style={{ backgroundImage: 'var(--rail-spectrum)' }}
              >
                <span className="flex items-center gap-1 rounded-full bg-(--surface) px-2.5 py-0.5 text-(--sea-ink)">
                  about: {applied.ranking.span}
                  <button
                    type="button"
                    aria-label="Remove what they do from the question"
                    onClick={dropRanking}
                    className="cursor-pointer border-none bg-transparent px-1 text-(--sea-ink-soft) transition hover:text-(--sea-ink)"
                  >
                    ×
                  </button>
                </span>
              </span>
            )}
            {applied.chips.map((chip, i) => (
              <span
                key={`${i}-${chip}`}
                className="rounded-full border border-(--sea-ink-soft)/30 px-2.5 py-0.5 text-(--sea-ink)"
              >
                {chip}
              </span>
            ))}
            <button
              type="button"
              onClick={clearAsk}
              className="cursor-pointer rounded-full border-none bg-transparent px-2 py-0.5 text-(--sea-ink-soft) underline-offset-2 transition hover:text-(--sea-ink) hover:underline"
            >
              Clear
            </button>
          </div>
        )}

        {/* Hero shows only when input AND debounced search are both empty, so it
            appears only after the results grid has fully cleared. */}
        {heroVisible && <HeroText count={sponsorCount} />}

        <div className="page-flip-listing">
          <Suspense fallback={<SkeletonCards />}>
            <HmrcResults
              search={search}
              filtersActive={listingMode}
              data={resultsData}
              ask={askHint}
            />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
