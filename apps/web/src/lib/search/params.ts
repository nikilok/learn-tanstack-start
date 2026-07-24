// Registry for /search filter params: canonical values, parsing, and
// model-facing docs. Single source of truth for the filter server fn, the
// /search route's validateSearch, and the Phase B prompt builder.
// Enum values verified against prod 2026-07-22 — refresh after ingestion
// introduces new ones.

import { type HmrcRoute, ROUTE_TYPE_COMPAT } from '../phase5/route-type-compat';

// Route vocabulary derives from the phase5 compat registry so /search and the
// mapping pipeline can't drift apart.
export const KNOWN_ROUTES: readonly HmrcRoute[] = (
  Object.keys(ROUTE_TYPE_COMPAT) as HmrcRoute[]
).sort();

export const WORKER_TYPES = ['Worker', 'Temporary Worker'] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

export const RATINGS = [
  'A',
  'A-Premium',
  'A-SME+',
  'B',
  'Provisional',
] as const;
export type Rating = (typeof RATINGS)[number];

// Every live type_rating value decomposed into the two filter facets.
export const TYPE_RATING_ROWS: {
  raw: string;
  workerType: WorkerType;
  rating: Rating;
}[] = [
  { raw: 'Worker (A rating)', workerType: 'Worker', rating: 'A' },
  { raw: 'Worker (A (Premium))', workerType: 'Worker', rating: 'A-Premium' },
  { raw: 'Worker (A (SME+))', workerType: 'Worker', rating: 'A-SME+' },
  { raw: 'Worker (B rating)', workerType: 'Worker', rating: 'B' },
  {
    // Trailing space is real in the feed — do not trim.
    raw: 'Worker (UK Expansion Worker: Provisional )',
    workerType: 'Worker',
    rating: 'Provisional',
  },
  {
    raw: 'Temporary Worker (A rating)',
    workerType: 'Temporary Worker',
    rating: 'A',
  },
  {
    raw: 'Temporary Worker (A (Premium))',
    workerType: 'Temporary Worker',
    rating: 'A-Premium',
  },
  {
    raw: 'Temporary Worker (A (SME+))',
    workerType: 'Temporary Worker',
    rating: 'A-SME+',
  },
  {
    raw: 'Temporary Worker (B rating)',
    workerType: 'Temporary Worker',
    rating: 'B',
  },
];

export const COMPANY_STATUSES = [
  'active',
  'administration',
  'closed',
  'converted-closed',
  'dissolved',
  'insolvency-proceedings',
  'liquidation',
  'open',
  'receivership',
  'registered',
  'removed',
  'voluntary-arrangement',
] as const;

export const COMPANY_TYPES = [
  'assurance-company',
  'charitable-incorporated-organisation',
  'converted-or-closed',
  'industrial-and-provident-society',
  'limited-partnership',
  'llp',
  'ltd',
  'oversea-company',
  'plc',
  'private-limited-guarant-nsc',
  'private-limited-guarant-nsc-limited-exemption',
  'private-limited-shares-section-30-exemption',
  'private-unlimited',
  'private-unlimited-nsc',
  'registered-overseas-entity',
  'registered-society-non-jurisdictional',
  'royal-charter',
  'scottish-charitable-incorporated-organisation',
  'uk-establishment',
  'unregistered-company',
] as const;

// Top sponsor towns by licence count (prod 2026-07-24), for the /filters
// checkbox group. The location param itself accepts ANY town — these are just
// the curated picks. Refresh occasionally after ingestion.
export const KNOWN_CITIES = [
  'Aberdeen',
  'Belfast',
  'Birmingham',
  'Bolton',
  'Bradford',
  'Bristol',
  'Cambridge',
  'Cardiff',
  'Coventry',
  'Croydon',
  'Edinburgh',
  'Glasgow',
  'Harrow',
  'Ilford',
  'Leeds',
  'Leicester',
  'Liverpool',
  'London',
  'Luton',
  'Manchester',
  'Milton Keynes',
  'Newcastle Upon Tyne',
  'Nottingham',
  'Oxford',
  'Reading',
  'Sheffield',
  'Slough',
  'Southampton',
] as const;

/** Zero-padded 2-digit division strings for an inclusive range. */
const divs = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    String(from + i).padStart(2, '0'),
  );

// UK SIC 2007 sections → their 2-digit division prefixes.
export const SIC_SECTIONS: Record<
  string,
  { label: string; divisions: string[] }
> = {
  A: { label: 'Agriculture, forestry and fishing', divisions: divs(1, 3) },
  B: { label: 'Mining and quarrying', divisions: divs(5, 9) },
  C: { label: 'Manufacturing', divisions: divs(10, 33) },
  D: {
    label: 'Electricity, gas, steam and air conditioning supply',
    divisions: divs(35, 35),
  },
  E: {
    label: 'Water supply, sewerage and waste management',
    divisions: divs(36, 39),
  },
  F: { label: 'Construction', divisions: divs(41, 43) },
  G: {
    label: 'Wholesale and retail trade; repair of motor vehicles',
    divisions: divs(45, 47),
  },
  H: { label: 'Transportation and storage', divisions: divs(49, 53) },
  I: {
    label: 'Accommodation and food service activities',
    divisions: divs(55, 56),
  },
  J: { label: 'Information and communication', divisions: divs(58, 63) },
  K: { label: 'Financial and insurance activities', divisions: divs(64, 66) },
  L: { label: 'Real estate activities', divisions: divs(68, 68) },
  M: {
    label: 'Professional, scientific and technical activities',
    divisions: divs(69, 75),
  },
  N: {
    label: 'Administrative and support service activities',
    divisions: divs(77, 82),
  },
  O: { label: 'Public administration and defence', divisions: divs(84, 84) },
  P: { label: 'Education', divisions: divs(85, 85) },
  Q: {
    label: 'Human health and social work activities',
    divisions: divs(86, 88),
  },
  R: { label: 'Arts, entertainment and recreation', divisions: divs(90, 93) },
  S: { label: 'Other service activities', divisions: divs(94, 96) },
  T: {
    label: 'Activities of households as employers',
    divisions: divs(97, 98),
  },
  U: {
    label: 'Activities of extraterritorial organisations',
    divisions: divs(99, 99),
  },
};

export const SORT_KEYS = ['relevance', 'name', 'incorporated'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export type SearchFilters = {
  q?: string;
  route?: string[];
  workerType?: WorkerType[];
  rating?: Rating[];
  location?: string;
  industry?: string;
  sic?: string[];
  sicSection?: string[];
  status?: string[];
  companyType?: string[];
  incorporatedFrom?: string;
  incorporatedTo?: string;
  accountsOverdue?: boolean;
  hasCharges?: boolean;
  hasInsolvencyHistory?: boolean;
  hasRenamed?: boolean;
  hasMoved?: boolean;
  sort?: SortKey;
  order?: SortOrder;
};

// Model-facing one-liners; the Phase B prompt builder joins these with the
// value constants above.
export const FILTER_DOCS = {
  q: 'Free-text organisation name to fuzzy-match; minimum 3 characters.',
  route: 'One or more visa sponsorship routes (exact values in KNOWN_ROUTES).',
  workerType: 'Licence class: Worker and/or Temporary Worker.',
  rating: 'Licence rating tiers: A, A-Premium, A-SME+, B, Provisional.',
  location:
    'Town or city, matched case-insensitively against the sponsor town and registered-office locality.',
  industry:
    'Industry in plain words (e.g. "software", "care homes"), matched against SIC descriptions — prefer this over sic unless an exact code is known.',
  sic: 'One or more SIC 2007 codes; 5-digit preferred, a 4-digit code also matches as a class prefix.',
  sicSection: 'One or more SIC 2007 section letters A-U (see SIC_SECTIONS).',
  status: 'Companies House company status (exact values in COMPANY_STATUSES).',
  companyType: 'Companies House company type (exact values in COMPANY_TYPES).',
  incorporatedFrom: 'Earliest incorporation date, YYYY-MM-DD or YYYY.',
  incorporatedTo: 'Latest incorporation date, YYYY-MM-DD or YYYY.',
  accountsOverdue:
    'true = annual accounts currently overdue; false = not overdue or unknown.',
  hasCharges:
    'true = has registered charges (secured borrowing); false = none or unknown.',
  hasInsolvencyHistory:
    'true = has insolvency history; false = none or unknown.',
  hasRenamed: 'true = company has at least one previous name.',
  hasMoved: 'true = registered address changed since tracking began (2026-04).',
  sort: 'relevance (requires q), name, or incorporated.',
  order: 'asc or desc.',
} as const satisfies Record<keyof SearchFilters, string>;

// Filters sourced from Companies House columns: they implicitly exclude the
// ~9% of sponsors with no CH mapping (public bodies / no_match).
export const CH_FILTER_KEYS = [
  'industry',
  'sic',
  'sicSection',
  'status',
  'companyType',
  'incorporatedFrom',
  'incorporatedTo',
  'accountsOverdue',
  'hasCharges',
  'hasInsolvencyHistory',
  'hasRenamed',
  'hasMoved',
] as const satisfies readonly (keyof SearchFilters)[];

/** True when any active filter reads Companies House data (drops unmapped sponsors). */
export function requiresChLink(filters: SearchFilters): boolean {
  return CH_FILTER_KEYS.some((key) => filters[key] !== undefined);
}

/** Raw type_rating values matching the requested facets (empty facet = unconstrained). */
export function typeRatingsFor(
  workerTypes?: readonly WorkerType[],
  ratings?: readonly Rating[],
): string[] {
  return TYPE_RATING_ROWS.filter(
    (row) =>
      (!workerTypes?.length || workerTypes.includes(row.workerType)) &&
      (!ratings?.length || ratings.includes(row.rating)),
  ).map((row) => row.raw);
}

// Glue words with no industry signal — '\mand' alone matches 316/731 SIC
// descriptions, so admitting them makes the any-word fallback a near-no-op.
const INDUSTRY_STOPWORDS = new Set([
  'and',
  'the',
  'for',
  'with',
  'from',
  'other',
]);

/** Usable match words from an industry phrase: alphanumeric runs of 3+ chars, minus glue words. */
export function industryWords(industry: string): string[] {
  return industry
    .split(/[^a-zA-Z0-9]+/)
    .filter(
      (word) => word.length >= 3 && !INDUSTRY_STOPWORDS.has(word.toLowerCase()),
    );
}

/** Lowercase and strip non-alphanumerics so enum matching survives model/user casing and punctuation. */
function normKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Bounds keeping hostile inputs from ballooning bind params or the issues echo.
const MAX_LIST_ITEMS = 50;
const MAX_ISSUES = 25;

/** Truncate a value for safe echoing inside an issue message. */
function clip(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/** Coerce a scalar param (string, finite number, or first array element) to string; dropped extra array elements are reported. */
function scalarInput(
  key: string,
  value: unknown,
  issues: string[],
): string | undefined {
  if (Array.isArray(value) && value.length > 1) {
    issues.push(`${key}: multiple values — using the first`);
  }
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** Coerce a multi-value param (array or comma-separated string; numbers allowed) to trimmed non-empty strings, capped at MAX_LIST_ITEMS. */
function listInput(key: string, value: unknown, issues: string[]): string[] {
  const items = Array.isArray(value) ? value : [value];
  const all = items
    .flatMap((item) =>
      typeof item === 'string'
        ? item.split(',')
        : typeof item === 'number' && Number.isFinite(item)
          ? [String(item)]
          : [],
    )
    .map((item) => item.trim())
    .filter(Boolean);
  if (all.length > MAX_LIST_ITEMS) {
    issues.push(`${key}: more than ${MAX_LIST_ITEMS} values — extras dropped`);
    return all.slice(0, MAX_LIST_ITEMS);
  }
  return all;
}

// Extra normKey spellings the canonical lists don't produce themselves.
const RATING_ALIASES: Record<string, Rating> = {
  arating: 'A',
  brating: 'B',
  premium: 'A-Premium',
  sme: 'A-SME+',
  smeplus: 'A-SME+',
  asmeplus: 'A-SME+',
  ukexpansionworkerprovisional: 'Provisional',
};

const WORKER_TYPE_ALIASES: Record<string, WorkerType> = {
  temporary: 'Temporary Worker',
  tempworker: 'Temporary Worker',
};

/** Canonicalize a multi-value enum param; unknown entries are dropped with an issue. */
function canonEnumList<T extends string>(
  key: string,
  value: unknown,
  canonical: readonly T[],
  issues: string[],
  aliases?: Record<string, T>,
): T[] | undefined {
  // Aliases seed first so canonical spellings win any normKey collision; a Map
  // lookup also can't be fooled by prototype keys ('constructor').
  const byKey = new Map<string, T>([
    ...Object.entries(aliases ?? {}),
    ...canonical.map((c): [string, T] => [normKey(c), c]),
  ]);
  const out: T[] = [];
  for (const item of listInput(key, value, issues)) {
    const canon = byKey.get(normKey(item));
    if (!canon) {
      issues.push(`${key}: unknown value "${clip(item)}" — dropped`);
      continue;
    }
    if (!out.includes(canon)) out.push(canon);
  }
  return out.length ? out : undefined;
}

/** Canonicalize a single-value enum param; unknown input is dropped with an issue. */
function canonEnum<T extends string>(
  key: string,
  value: unknown,
  canonical: readonly T[],
  issues: string[],
): T | undefined {
  const s = scalarInput(key, value, issues)?.trim();
  if (!s) return undefined;
  const canon = canonical.find((c) => normKey(c) === normKey(s));
  if (!canon) issues.push(`${key}: unknown value "${clip(s)}" — dropped`);
  return canon;
}

/** Parse a boolean param (boolean or "true"/"false"); null/empty means unset, other junk is dropped with an issue. */
function boolInput(
  key: string,
  value: unknown,
  issues: string[],
): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  const s = scalarInput(key, value, issues)?.trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'true') return true;
  if (s === 'false') return false;
  issues.push(`${key}: expected true/false — dropped`);
  return undefined;
}

/** True when the string is a real calendar date (rejects 2015-02-30, and year 0000 which JS Date has but Postgres doesn't). */
function isRealDate(iso: string): boolean {
  if (iso.startsWith('0000')) return false;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso;
}

/** Parse a date param: YYYY-MM-DD, or bare YYYY expanded to the range edge. */
function dateInput(
  key: string,
  value: unknown,
  edge: 'from' | 'to',
  issues: string[],
): string | undefined {
  const s = scalarInput(key, value, issues)?.trim();
  if (!s) return undefined;
  if (/^\d{4}$/.test(s) && s !== '0000') {
    return edge === 'from' ? `${s}-01-01` : `${s}-12-31`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && isRealDate(s)) return s;
  issues.push(`${key}: invalid date "${clip(s)}" — dropped`);
  return undefined;
}

export type ParsedSearchFilters = {
  filters: SearchFilters;
  issues: string[];
};

// URL form of SearchFilters: lists flatten to comma-joined strings, booleans
// stay booleans. Precise keys, no index signature — a loose Record here leaks
// into the router's merged search-param type and breaks other routes' typing.
export type SearchUrlParams = {
  [K in keyof SearchFilters]?: SearchFilters[K] extends boolean | undefined
    ? boolean
    : string;
};

/**
 * Canonical filters → URL-friendly search params: arrays comma-join to plain
 * strings ("route=Skilled Worker,Charity Worker"), scalars pass through. The
 * result round-trips through parseSearchFilters unchanged, so a route using
 * it as validateSearch output reaches a stable URL (no re-serialize redirect
 * loops, no JSON-array URLs).
 */
export function filtersToSearchParams(filters: SearchFilters): SearchUrlParams {
  const out: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(',') : value;
  }
  return out as SearchUrlParams;
}

/**
 * Validate raw filter params (URL search params, server fn input, or model
 * output) into SearchFilters. Lenient by design: invalid entries are dropped
 * and reported in `issues` rather than rejecting the whole request, so a
 * partially-wrong model emission still produces a usable query. Unknown keys
 * are ignored; null/non-object input parses as no filters.
 */
export function parseSearchFilters(input: unknown): ParsedSearchFilters {
  const issues: string[] = [];
  const filters: SearchFilters = {};
  const raw: Record<string, unknown> =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (input != null && raw !== input) {
    issues.push('input: expected an object of filter params — ignored');
  }
  /** Assign only when defined so no-op parses leave no phantom keys. */
  const set = <K extends keyof SearchFilters>(
    key: K,
    value: SearchFilters[K] | undefined,
  ): void => {
    if (value !== undefined) filters[key] = value;
  };

  const q = scalarInput('q', raw.q, issues)?.trim();
  if (q) {
    if (q.length < 3) issues.push('q: needs at least 3 characters — dropped');
    else {
      // Code-point slice: a code-unit slice could split a surrogate pair.
      const chars = [...q];
      if (chars.length > 100) {
        filters.q = chars.slice(0, 100).join('');
        issues.push('q: over 100 characters — truncated');
      } else filters.q = q;
    }
  }

  if (raw.route !== undefined) {
    set('route', canonEnumList('route', raw.route, KNOWN_ROUTES, issues));
  }
  if (raw.workerType !== undefined) {
    set(
      'workerType',
      canonEnumList(
        'workerType',
        raw.workerType,
        WORKER_TYPES,
        issues,
        WORKER_TYPE_ALIASES,
      ),
    );
  }
  if (raw.rating !== undefined) {
    set(
      'rating',
      canonEnumList('rating', raw.rating, RATINGS, issues, RATING_ALIASES),
    );
  }

  const location = scalarInput('location', raw.location, issues)
    ?.replace(/\s+/g, ' ')
    .trim();
  if (location) {
    if (location.length > 100) {
      issues.push('location: over 100 characters — dropped');
    } else filters.location = location;
  }

  const industry = scalarInput('industry', raw.industry, issues)
    ?.replace(/\s+/g, ' ')
    .trim();
  if (industry) {
    if (industry.length > 100) {
      issues.push('industry: over 100 characters — dropped');
    } else if (!industryWords(industry).length) {
      issues.push(
        'industry: needs a distinctive word of 3+ characters — dropped',
      );
    } else filters.industry = industry;
  }

  if (raw.sic !== undefined) {
    const codes = listInput('sic', raw.sic, issues).filter((code) => {
      const ok = /^\d{4,5}$/.test(code);
      if (!ok) issues.push(`sic: invalid code "${clip(code)}" — dropped`);
      return ok;
    });
    if (codes.length) filters.sic = [...new Set(codes)];
  }
  if (raw.sicSection !== undefined) {
    set(
      'sicSection',
      canonEnumList(
        'sicSection',
        raw.sicSection,
        Object.keys(SIC_SECTIONS),
        issues,
      ),
    );
  }

  if (raw.status !== undefined) {
    set(
      'status',
      canonEnumList('status', raw.status, COMPANY_STATUSES, issues),
    );
  }
  if (raw.companyType !== undefined) {
    set(
      'companyType',
      canonEnumList('companyType', raw.companyType, COMPANY_TYPES, issues),
    );
  }

  const rawFrom = scalarInput(
    'incorporatedFrom',
    raw.incorporatedFrom,
    issues,
  )?.trim();
  const rawTo = scalarInput(
    'incorporatedTo',
    raw.incorporatedTo,
    issues,
  )?.trim();
  if (raw.incorporatedFrom !== undefined) {
    set(
      'incorporatedFrom',
      dateInput('incorporatedFrom', rawFrom, 'from', issues),
    );
  }
  if (raw.incorporatedTo !== undefined) {
    set('incorporatedTo', dateInput('incorporatedTo', rawTo, 'to', issues));
  }
  if (
    filters.incorporatedFrom &&
    filters.incorporatedTo &&
    filters.incorporatedFrom > filters.incorporatedTo
  ) {
    // Re-expand from the raw inputs so reversed bare years land on the intended
    // outer edges (2020→2015 must become 2015-01-01..2020-12-31, not the inverse).
    filters.incorporatedFrom = dateInput('incorporatedFrom', rawTo, 'from', []);
    filters.incorporatedTo = dateInput('incorporatedTo', rawFrom, 'to', []);
    issues.push('incorporatedFrom/incorporatedTo: reversed range — swapped');
  }

  for (const key of [
    'accountsOverdue',
    'hasCharges',
    'hasInsolvencyHistory',
    'hasRenamed',
    'hasMoved',
  ] as const) {
    if (raw[key] !== undefined) set(key, boolInput(key, raw[key], issues));
  }

  if (raw.sort !== undefined) {
    const sort = canonEnum('sort', raw.sort, SORT_KEYS, issues);
    if (sort === 'relevance' && !filters.q) {
      issues.push('sort: relevance requires q — dropped');
    } else if (sort) filters.sort = sort;
  }
  if (raw.order !== undefined) {
    set('order', canonEnum('order', raw.order, SORT_ORDERS, issues));
  }

  if (issues.length > MAX_ISSUES) {
    issues.splice(MAX_ISSUES, issues.length, '…additional issues dropped');
  }

  return { filters, issues };
}
