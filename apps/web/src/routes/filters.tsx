import {
  createFileRoute,
  useCanGoBack,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHeader } from '@tanstack/start-server-core';
import { useEffect, useMemo, useRef, useState } from 'react';

import Accordion from '../components/Accordion';
import Checkbox from '../components/Checkbox';
import DatePicker from '../components/DatePicker';
import Select from '../components/Select';
import { parsePlatform } from '../hooks/usePlatform';
import {
  COMPANY_STATUSES,
  COMPANY_TYPES,
  filtersToSearchParams,
  KNOWN_CITIES,
  KNOWN_ROUTES,
  parseSearchFilters,
  RATINGS,
  type SearchFilters,
  searchTermInput,
  SIC_SECTIONS,
  WORKER_TYPES,
} from '../lib/search/params';
import { loadStoredFilters, storeFilters } from '../lib/search/persist';
import { FILTER_SECTIONS } from '../lib/search/sections';
import { humanizeEnum, prefersReducedMotion } from '../utils';
import { buildCanonical } from '../utils/canonical';
import { buildFiltersJsonLd } from '../utils/jsonld';
import { buildSeoHead } from '../utils/seo';

const getPlatformInfo = createIsomorphicFn()
  .client(() => parsePlatform(navigator.userAgent))
  .server(() => parsePlatform(getRequestHeader('user-agent') ?? ''));

// Apply/Reset land on home in its normal starting state. The form's scroll
// otherwise survives the push (clamped against the listing's transient
// height, i.e. a random-looking offset); the rAF repeat pins it through the
// post-render frame where restoration or late content growth could re-shift.
function landAtTop() {
  window.scrollTo(0, 0);
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

export const Route = createFileRoute('/filters')({
  // Same URL form as home: the name term plus filter params, so the form
  // opens pre-filled with whatever the listing currently applies.
  validateSearch: (search: Record<string, unknown>) => {
    const term = searchTermInput(search.search);
    const { filters } = parseSearchFilters({ ...search, q: undefined });
    return {
      ...(term ? { search: term } : {}),
      ...filtersToSearchParams(filters),
    };
  },
  // Canonical is always the bare /filters (match.pathname carries no params),
  // so filtered URL variants never index as near-duplicates.
  head: ({ match }) => {
    const pageTitle =
      'SponsorSearch . Advanced Filters for the UK Sponsorship List';
    const pageDescription =
      'Browse the UK sponsorship list with advanced filters: visa route, licence rating, city, industry, company status, incorporation date and change signals.';
    const canonicalUrl = buildCanonical(match.pathname);
    return buildSeoHead({
      title: pageTitle,
      description: pageDescription,
      canonicalUrl,
      jsonLd: buildFiltersJsonLd({
        title: pageTitle,
        description: pageDescription,
        canonicalUrl,
      }),
    });
  },
  beforeLoad: () => ({ platformInfo: getPlatformInfo() }),
  component: FiltersPage,
});

// Editable working copy of the filter set: lists as arrays, free-text fields
// as raw strings, tri-state booleans as boolean|undefined. Everything funnels
// through parseSearchFilters on Apply, so the registry stays the validator.
type Draft = {
  route: string[];
  workerType: string[];
  rating: string[];
  sicSection: string[];
  status: string[];
  companyType: string[];
  // Multi-town selection; joins to the comma-separated location param (whose
  // SQL matcher already splits on commas).
  location: string[];
  industry: string;
  sic: string;
  incorporatedFrom: string;
  incorporatedTo: string;
  accountsOverdue?: boolean;
  hasCharges?: boolean;
  hasInsolvencyHistory?: boolean;
  hasRenamed?: boolean;
  hasMoved?: boolean;
  sort: string;
  order: string;
};

/** Build the editable draft from a canonical filter set. */
function draftFromFilters(filters: SearchFilters): Draft {
  return {
    route: filters.route ?? [],
    workerType: filters.workerType ?? [],
    rating: filters.rating ?? [],
    sicSection: filters.sicSection ?? [],
    status: filters.status ?? [],
    companyType: filters.companyType ?? [],
    location:
      filters.location
        ?.split(',')
        .map((town) => town.trim())
        .filter(Boolean) ?? [],
    industry: filters.industry ?? '',
    sic: filters.sic?.join(', ') ?? '',
    incorporatedFrom: filters.incorporatedFrom ?? '',
    incorporatedTo: filters.incorporatedTo ?? '',
    accountsOverdue: filters.accountsOverdue,
    hasCharges: filters.hasCharges,
    hasInsolvencyHistory: filters.hasInsolvencyHistory,
    hasRenamed: filters.hasRenamed,
    hasMoved: filters.hasMoved,
    sort: filters.sort ?? '',
    order: filters.order ?? '',
  };
}

/**
 * Re-validate a draft through the registry. Returns the full parse — filters
 * AND issues, so the form can surface dropped input instead of eating it.
 * The `satisfies` pins this literal to the registry: a future filter key
 * fails the build here instead of being silently stripped by Apply.
 */
function filtersFromDraft(draft: Draft) {
  return parseSearchFilters({
    route: draft.route,
    workerType: draft.workerType,
    rating: draft.rating,
    sicSection: draft.sicSection,
    status: draft.status,
    companyType: draft.companyType,
    location: draft.location.length ? draft.location.join(',') : undefined,
    industry: draft.industry || undefined,
    sic: draft.sic || undefined,
    incorporatedFrom: draft.incorporatedFrom || undefined,
    incorporatedTo: draft.incorporatedTo || undefined,
    accountsOverdue: draft.accountsOverdue,
    hasCharges: draft.hasCharges,
    hasInsolvencyHistory: draft.hasInsolvencyHistory,
    hasRenamed: draft.hasRenamed,
    hasMoved: draft.hasMoved,
    sort: draft.sort || undefined,
    order: draft.order || undefined,
  } satisfies Record<Exclude<keyof SearchFilters, 'q'>, unknown>);
}

/** Order-insensitive identity of a filter set, for dirty-state comparison. */
function filtersKey(filters: SearchFilters): string {
  return JSON.stringify(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value].sort() : value,
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

// text-base below sm: iOS Safari auto-zooms the page when a focused input's
// font-size is under 16px, shoving the layout; 16px on touch widths stops it.
// py-2.5 below sm lifts the tap target to 44px (Apple HIG).
const INPUT_CLASS =
  'w-full rounded-lg border border-(--sea-ink)/15 bg-transparent px-3 py-2.5 text-base text-(--sea-ink) placeholder:text-(--sea-ink-soft) sm:py-2 sm:text-sm';

// Accordion section → the URL params it contributes. Pill counts and
// default-open both derive from this, so the pills always sum to the Apply
// badge (most sections contribute one param; Licence, Industry, Incorporated
// and Signals can contribute more).
const SECTION_KEYS = {
  route: ['route'],
  licence: ['workerType', 'rating'],
  location: ['location'],
  industry: ['industry', 'sic', 'sicSection'],
  status: ['status'],
  companyType: ['companyType'],
  incorporated: ['incorporatedFrom', 'incorporatedTo'],
  signals: [
    'accountsOverdue',
    'hasCharges',
    'hasInsolvencyHistory',
    'hasRenamed',
    'hasMoved',
  ],
  sort: ['sort', 'order'],
} as const satisfies Record<
  string,
  readonly (keyof Omit<SearchFilters, 'q'>)[]
>;
// Compile-time coverage: every registry key (bar q) must belong to a section,
// or it would be invisible here and silently stripped by Apply. A missing key
// collapses SectionId into an error tuple, failing every use below.
type UnsectionedKey = Exclude<
  keyof SearchFilters,
  'q' | (typeof SECTION_KEYS)[keyof typeof SECTION_KEYS][number]
>;
type SectionId = [UnsectionedKey] extends [never]
  ? keyof typeof SECTION_KEYS
  : ['unsectioned registry keys', UnsectionedKey];
// Declaration order (from the shared display list) doubles as the ⌥1…⌥9 jump order.
const SECTION_ORDER = FILTER_SECTIONS.map((s) => s.id satisfies SectionId);
// Indexing with SectionId compile-fails if a section lacks a FILTER_SECTIONS entry.
const SECTION_TITLES = Object.fromEntries(
  FILTER_SECTIONS.map((s) => [s.id, s.title]),
) as Record<(typeof FILTER_SECTIONS)[number]['id'], string>;

/** Which sections hold a choice in the given filter set (their default-open state). */
function openSectionsFor(filters: SearchFilters): Record<SectionId, boolean> {
  const form = filtersToSearchParams(filters);
  return Object.fromEntries(
    Object.entries(SECTION_KEYS).map(([id, keys]) => [
      id,
      keys.some((key) => key in form),
    ]),
  ) as Record<SectionId, boolean>;
}

/** Two-column checkbox grid for a multi-select facet. */
function CheckGroup({
  options,
  selected,
  onToggle,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
      {options.map((opt) => (
        <Checkbox
          key={opt.value}
          checked={selected.includes(opt.value)}
          onChange={() => onToggle(opt.value)}
          label={opt.label}
        />
      ))}
    </div>
  );
}

/** Any / Yes / No select for a tri-state boolean signal. */
function TriState({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-(--sea-ink)">
      {label}
      <Select
        ariaLabel={label}
        value={value === undefined ? 'any' : value ? 'yes' : 'no'}
        options={[
          { value: 'any', label: 'Any' },
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]}
        onChange={(next) =>
          onChange(next === 'any' ? undefined : next === 'yes')
        }
        triggerClassName="min-w-[5.5rem] justify-between"
      />
    </div>
  );
}

/**
 * Full-page filter form. Opens pre-filled from the URL, edits a local draft,
 * and Apply navigates back to the home listing with the canonical URL-form
 * params — the same contract the Phase B model will emit later. Reset exits
 * in one tap: empties the store and lands on the classic home.
 */
function FiltersPage() {
  const initial = Route.useSearch();
  const { search: term = '', ...initialFilters } = initial;
  const { platformInfo } = Route.useRouteContext();
  const modKey = platformInfo.platform === 'mac' ? '⌘' : 'Ctrl';
  // Section jumps use Option/Alt: ⌘/Ctrl+digit is browser tab-switching.
  const jumpKey = platformInfo.platform === 'mac' ? '⌥' : 'Alt+';
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() =>
    draftFromFilters(parseSearchFilters(initialFilters).filters),
  );
  // What the page opened with (the currently-applied set) — Apply only means
  // something when the draft differs from this, and the section pills compare
  // their slice against it to show applied (solid red) vs pending (dashed).
  const [baseline, setBaseline] = useState<SearchFilters>(
    () => parseSearchFilters(initialFilters).filters,
  );
  // Sections with a choice open by default; the rest stay closed.
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>(
    () => openSectionsFor(parseSearchFilters(initialFilters).filters),
  );

  // A bare /filters URL prefills from the persisted set. Post-hydration
  // effect (not the state initializer): localStorage isn't SSR-readable, so
  // seeding initial state from it would mismatch the server HTML. The
  // baseline follows: a prefilled set is the currently-applied state, not a
  // pending change.
  const urlFiltersKey = JSON.stringify(initialFilters);
  const dirtyRef = useRef(false);
  useEffect(() => {
    const urlFilters = JSON.parse(urlFiltersKey) as Record<string, unknown>;
    if (Object.keys(urlFilters).length > 0) return;
    // Re-entering /filters (header icon, ⌘⇧F) re-runs this — unapplied edits
    // win over the stored set; only an untouched form prefills.
    if (dirtyRef.current) return;
    const stored = loadStoredFilters();
    if (stored) {
      const filters = parseSearchFilters(stored).filters;
      setDraft(draftFromFilters(filters));
      setBaseline(filters);
      setOpenSections(openSectionsFor(filters));
    }
  }, [urlFiltersKey]);

  const { filters: applied, issues: draftIssues } = useMemo(
    () => filtersFromDraft(draft),
    [draft],
  );
  const urlForm = filtersToSearchParams(applied);
  const activeCount = Object.keys(urlForm).length;
  const dirty = filtersKey(applied) !== filtersKey(baseline);
  dirtyRef.current = dirty;
  /** A section's live contribution to the active-filter total. */
  const sectionCount = (id: SectionId) =>
    SECTION_KEYS[id].filter((key) => key in urlForm).length;
  /** One section's slice of a filter set, canonically keyed for comparison. */
  const sectionSliceKey = (filters: SearchFilters, id: SectionId) =>
    filtersKey(
      Object.fromEntries(
        Object.entries(filters).filter(([key]) =>
          (SECTION_KEYS[id] as readonly string[]).includes(key),
        ),
      ) as SearchFilters,
    );
  /** True when a section's draft matches the applied baseline (pill goes solid red). */
  const sectionConfirmed = (id: SectionId) =>
    sectionSliceKey(applied, id) === sectionSliceKey(baseline, id);

  // Glass only while the pill overlays scrollable content; at the page end it
  // rests as plain controls (same sentinel pattern as the details back button).
  const footerSentinelRef = useRef<HTMLDivElement>(null);
  const [footerStuck, setFooterStuck] = useState(true);
  useEffect(() => {
    const sentinel = footerSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) =>
      setFooterStuck(!entry.isIntersecting),
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const toggle = (key: keyof Draft, value: string) =>
    setDraft((d) => {
      const current = d[key] as string[];
      return {
        ...d,
        [key]: current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value],
      };
    });
  const setText = (key: keyof Draft, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setBool = (key: keyof Draft, value: boolean | undefined) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const apply = () => {
    const params = filtersToSearchParams(applied);
    // Persist (or clear, when empty) before navigating — home treats the
    // store as the durable copy the URL rehydrates from.
    storeFilters(params);
    void navigate({ to: '/', search: { search: term, ...params } }).then(
      landAtTop,
    );
  };

  // One-tap exit: empty the store and land on the classic home immediately.
  const clearAll = () => {
    storeFilters({});
    void navigate({ to: '/', search: { search: term } }).then(landAtTop);
  };

  // Cancel = go back to wherever the user came from (the filter icon is in
  // the global header, so that may be a details page, /download, …). Only a
  // direct /filters visit with no in-app history falls back to home.
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const cancel = () => {
    if (canGoBack) router.history.back();
    else navigate({ to: '/', search: { search: term, ...initialFilters } });
  };

  // ⌥/Alt+1…9 jumps to a section: opens it, scrolls it into view, and hands
  // focus to its first control so filtering continues keyboard-only.
  const jumpToSection = (id: SectionId) => {
    setOpenSections((s) => ({ ...s, [id]: true }));
    setTimeout(() => {
      const el = document.getElementById(`filter-section-${id}`);
      if (!el) return;
      el.scrollIntoView({
        block: 'start',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
      el.querySelector<HTMLElement>('input, textarea, button')?.focus();
    }, 60);
  };

  // Page shortcuts: ⌘/Ctrl+Enter applies (when dirty) and ⌥/Alt+1…9 jumps to
  // a section — both from ANYWHERE, even with a checkbox or input focused;
  // the modifier makes intent unambiguous. (⌘/Ctrl+digit is deliberately NOT
  // used: browsers reserve it for tab switching. The digit is matched by
  // physical code because macOS Option substitutes characters.) R resets and
  // Esc cancels; those defer only to text-entry contexts (checkboxes don't
  // type) and to popovers that already handled the key — Select / DatePicker
  // listen on their root, so Escapes from anywhere inside them arrive here
  // with defaultPrevented set.
  const resettable = activeCount > 0;
  const actionsRef = useRef({
    apply,
    cancel,
    clearAll,
    dirty,
    jumpToSection,
    resettable,
  });
  actionsRef.current = {
    apply,
    cancel,
    clearAll,
    dirty,
    jumpToSection,
    resettable,
  };
  useEffect(() => {
    const TYPING =
      'input:not([type="checkbox"]), textarea, select, [contenteditable]';
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const current = actionsRef.current;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (!current.dirty) return;
        e.preventDefault();
        current.apply();
        return;
      }
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1];
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && digit) {
        const id = SECTION_ORDER[Number(digit) - 1];
        if (!id) return;
        e.preventDefault();
        current.jumpToSection(id);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest(TYPING)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        current.cancel();
      } else if (e.key === 'r' || e.key === 'R') {
        // Same gate as the button's `disabled` — nothing set, nothing to reset.
        if (!current.resettable) return;
        e.preventDefault();
        current.clearAll();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const section = (id: SectionId, body: React.ReactNode) => (
    <Accordion
      id={`filter-section-${id}`}
      title={SECTION_TITLES[id]}
      shortcut={`${jumpKey}${SECTION_ORDER.indexOf(id) + 1}`}
      count={sectionCount(id)}
      confirmed={sectionConfirmed(id)}
      open={openSections[id]}
      onToggle={(next) => setOpenSections((s) => ({ ...s, [id]: next }))}
    >
      {body}
    </Accordion>
  );

  return (
    <main className="page-wrap min-h-[50vh] px-4 py-10 sm:py-16">
      <section className="mx-auto max-w-2xl pb-6">
        <h1 className="island-kicker mb-3">Filter the UK sponsor list</h1>
        <p className="mt-2 text-sm text-(--sea-ink-soft)">
          Filter by visa route, licence rating, city, industry, company status
          or incorporation date, then layer on change signals like renames,
          office moves, charges or insolvency history. Open a section, tick what
          matters and hit Apply. The home page then shows every sponsor that
          matches, and you can still type a company name on top. Your choices
          stick around until you reset them. One caveat: filters that rely on
          Companies House data leave out the few sponsors we can’t match to a
          registered company, mostly public bodies.
        </p>

        <div className="mt-6">
          {section(
            'route',
            <CheckGroup
              options={KNOWN_ROUTES.map((r) => ({ value: r, label: r }))}
              selected={draft.route}
              onToggle={(v) => toggle('route', v)}
            />,
          )}

          {section(
            'licence',
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-medium text-(--sea-ink-soft)">
                  Worker type
                </p>
                <CheckGroup
                  options={WORKER_TYPES.map((w) => ({ value: w, label: w }))}
                  selected={draft.workerType}
                  onToggle={(v) => toggle('workerType', v)}
                />
              </div>
              <div>
                <p className="mb-2 text-xs font-medium text-(--sea-ink-soft)">
                  Rating
                </p>
                <CheckGroup
                  options={RATINGS.map((r) => ({ value: r, label: r }))}
                  selected={draft.rating}
                  onToggle={(v) => toggle('rating', v)}
                />
              </div>
            </div>,
          )}

          {section(
            'location',
            <>
              <p className="mb-3 text-xs text-(--sea-ink-soft)">
                Matches the sponsor’s town or its registered office.
              </p>
              <CheckGroup
                // The param accepts ANY town (URL edits, the future model) —
                // ones outside the curated list surface as extra ticked
                // options at the top, so they're visible and removable.
                options={[
                  ...draft.location.filter(
                    (town) =>
                      !(KNOWN_CITIES as readonly string[]).includes(town),
                  ),
                  ...KNOWN_CITIES,
                ].map((city) => ({
                  value: city,
                  label: city,
                }))}
                selected={draft.location}
                onToggle={(v) => toggle('location', v)}
              />
            </>,
          )}

          {section(
            'industry',
            <>
              <p className="mb-3 text-xs text-(--sea-ink-soft)">
                Describe the industry in plain words, like software, care homes
                or restaurants.
              </p>
              <input
                type="text"
                className={INPUT_CLASS}
                placeholder="e.g. software"
                value={draft.industry}
                onChange={(e) => setText('industry', e.target.value)}
              />
              {/* Summaries pad to 44px tap targets below sm (full-width hit area). */}
              <details className="mt-3">
                <summary className="cursor-pointer py-3 text-sm text-(--link-blue) sm:py-0">
                  Broad sectors (SIC sections)
                </summary>
                <div className="mt-3">
                  <CheckGroup
                    options={Object.entries(SIC_SECTIONS).map(
                      ([letter, { label }]) => ({ value: letter, label }),
                    )}
                    selected={draft.sicSection}
                    onToggle={(v) => toggle('sicSection', v)}
                  />
                </div>
              </details>
              <details className="mt-2">
                <summary className="cursor-pointer py-3 text-sm text-(--link-blue) sm:py-0">
                  Exact SIC codes
                </summary>
                <input
                  type="text"
                  className={`${INPUT_CLASS} mt-3`}
                  placeholder="Comma-separated codes, e.g. 62020, 62012"
                  value={draft.sic}
                  onChange={(e) => setText('sic', e.target.value)}
                />
              </details>
            </>,
          )}

          {section(
            'status',
            <CheckGroup
              options={COMPANY_STATUSES.map((s) => ({
                value: s,
                label: humanizeEnum(s),
              }))}
              selected={draft.status}
              onToggle={(v) => toggle('status', v)}
            />,
          )}

          {section(
            'companyType',
            <CheckGroup
              options={COMPANY_TYPES.map((t) => ({
                value: t,
                label: humanizeEnum(t),
              }))}
              selected={draft.companyType}
              onToggle={(v) => toggle('companyType', v)}
            />,
          )}

          {section(
            'incorporated',
            <>
              <p className="mb-3 text-xs text-(--sea-ink-soft)">
                Companies incorporated between these dates.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
                <DatePicker
                  placeholder="From"
                  value={draft.incorporatedFrom || undefined}
                  onChange={(v) =>
                    setDraft((d) => ({
                      ...d,
                      incorporatedFrom: v ?? '',
                      // To depends on From: clear it when From is cleared or
                      // moves past it, so the range can never invert.
                      incorporatedTo:
                        v && d.incorporatedTo && d.incorporatedTo >= v
                          ? d.incorporatedTo
                          : '',
                    }))
                  }
                />
                <DatePicker
                  placeholder="To"
                  align="right"
                  min={draft.incorporatedFrom || undefined}
                  disabled={!draft.incorporatedFrom && !draft.incorporatedTo}
                  value={draft.incorporatedTo || undefined}
                  onChange={(v) => setText('incorporatedTo', v ?? '')}
                />
              </div>
            </>,
          )}

          {section(
            'signals',
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-x-8">
              <TriState
                label="Accounts overdue"
                value={draft.accountsOverdue}
                onChange={(v) => setBool('accountsOverdue', v)}
              />
              <TriState
                label="Has charges"
                value={draft.hasCharges}
                onChange={(v) => setBool('hasCharges', v)}
              />
              <TriState
                label="Insolvency history"
                value={draft.hasInsolvencyHistory}
                onChange={(v) => setBool('hasInsolvencyHistory', v)}
              />
              <TriState
                label="Changed name"
                value={draft.hasRenamed}
                onChange={(v) => setBool('hasRenamed', v)}
              />
              <TriState
                label="Moved recently"
                value={draft.hasMoved}
                onChange={(v) => setBool('hasMoved', v)}
              />
            </div>,
          )}

          {section(
            'sort',
            <div className="flex flex-wrap items-center gap-3">
              <Select
                ariaLabel="Sort by"
                value={draft.sort}
                options={[
                  { value: '', label: 'Default' },
                  { value: 'name', label: 'Name' },
                  { value: 'incorporated', label: 'Incorporation date' },
                ]}
                onChange={(next) => setText('sort', next)}
              />
              <Select
                ariaLabel="Sort order"
                value={draft.order}
                options={[
                  { value: '', label: 'Default order' },
                  { value: 'asc', label: 'Ascending' },
                  { value: 'desc', label: 'Descending' },
                ]}
                onChange={(next) => setText('order', next)}
              />
            </div>,
          )}
        </div>

        {draftIssues.length > 0 && (
          <div className="mt-6 text-xs text-(--sea-ink-soft)">
            <p className="m-0 mb-1 font-medium">Some input was ignored</p>
            <ul className="m-0 list-none space-y-1 p-0">
              {draftIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Floating pill (same recipe as the details page's back-to-search pill:
          .glass zeroes backdrop-filter, backdrop-blur-md! re-enables it). The
          glass body only shows while overlaying content; at rest it's plain. */}
      <div className="pointer-events-none sticky bottom-4 z-10 mt-10">
        {/* Wider gap <sm: keycaps are hidden there, so the row is compact and reads cramped at gap-5. */}
        <div
          className={`pointer-events-auto mx-auto flex w-fit items-center gap-7 py-2 sm:gap-5 ${
            footerStuck ? 'glass rounded-full pr-2 pl-2 backdrop-blur-md!' : ''
          }`}
        >
          {/* Brand-red once there's a set to clear (else disabled, R inert); geometry is constant so the row never reflows. */}
          <button
            type="button"
            onClick={clearAll}
            disabled={activeCount === 0}
            className={`rounded-full border-none px-4 py-2 text-sm font-medium transition ${
              activeCount > 0
                ? 'cursor-pointer bg-(--logo-red) text-(--bg-base) shadow-[0_0_10px_1px_color-mix(in_srgb,var(--logo-red)_50%,transparent)] hover:opacity-90'
                : 'cursor-default bg-transparent text-(--sea-ink-faint)'
            }`}
          >
            Reset
            <kbd className="ml-1.5 hidden font-sans text-xs pointer-fine:inline">
              R
            </kbd>
          </button>
          <button
            type="button"
            onClick={cancel}
            className="cursor-pointer border-none bg-transparent p-0 text-sm text-(--sea-ink-soft) transition hover:text-(--sea-ink)"
          >
            Cancel
            <kbd className="ml-1.5 hidden font-sans text-xs pointer-fine:inline">
              Esc
            </kbd>
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!dirty}
            className="flex cursor-pointer items-center gap-2 rounded-full border-none bg-(--sea-ink) py-2 pr-3 pl-5 text-sm font-medium text-(--bg-base) transition hover:opacity-90 disabled:cursor-default disabled:opacity-40 disabled:hover:opacity-40"
          >
            Apply
            <span className="hidden items-center gap-1 pointer-fine:inline-flex">
              <kbd className="font-sans text-xs">{modKey}</kbd>
              <kbd className="font-sans text-xs">↵</kbd>
            </span>
            {/* Slot is always laid out (`invisible` at zero, which also keeps the "0" out of
                the a11y tree) so the badge appearing can't widen the pill and slide the bar. */}
            <span
              className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] leading-none font-semibold ${
                activeCount === 0
                  ? 'invisible'
                  : dirty
                    ? 'border border-dashed border-(--bg-base)/70 bg-transparent text-(--bg-base)'
                    : 'border-none bg-(--logo-red) text-white shadow-[0_0_10px_1px_color-mix(in_srgb,var(--logo-red)_50%,transparent)]'
              }`}
            >
              {activeCount}
            </span>
          </button>
        </div>
      </div>
      <div ref={footerSentinelRef} aria-hidden className="h-px w-px" />
    </main>
  );
}
