// Registry for /search filter params: canonical values, parsing, and
// model-facing docs. Single source of truth for the filter server fn, the
// /search route's validateSearch, and the Phase B prompt builder.
// Enum values verified against prod 2026-07-22 — refresh after ingestion
// introduces new ones.

export const KNOWN_ROUTES = [
  'Charity Worker',
  'Creative Worker',
  'Global Business Mobility: Graduate Trainee',
  'Global Business Mobility: Secondment Worker',
  'Global Business Mobility: Senior or Specialist Worker',
  'Global Business Mobility: Service Supplier',
  'Global Business Mobility: UK Expansion Worker',
  'Government Authorised Exchange',
  'International Agreement',
  'International Sportsperson',
  'Intra Company Transfers (ICT)',
  'Intra-company Routes',
  'Religious Worker',
  'Scale-up',
  'Seasonal Worker',
  'Skilled Worker',
  'Tier 2 Ministers of Religion',
] as const;

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
  sic: 'One or more 4-5 digit SIC 2007 codes.',
  sicSection: 'One or more SIC 2007 section letters A-U (see SIC_SECTIONS).',
  status: 'Companies House company status (exact values in COMPANY_STATUSES).',
  companyType: 'Companies House company type (exact values in COMPANY_TYPES).',
  incorporatedFrom: 'Earliest incorporation date, YYYY-MM-DD or YYYY.',
  incorporatedTo: 'Latest incorporation date, YYYY-MM-DD or YYYY.',
  accountsOverdue: 'true = annual accounts are currently overdue.',
  hasCharges: 'true = company has registered charges (secured borrowing).',
  hasInsolvencyHistory: 'true = company has insolvency history.',
  hasRenamed: 'true = company has at least one previous name.',
  hasMoved: 'true = registered address changed since tracking began (2026-04).',
  sort: 'relevance (requires q), name, or incorporated.',
  order: 'asc or desc.',
} as const satisfies Record<keyof SearchFilters, string>;

// Filters sourced from Companies House columns: they implicitly exclude the
// ~9% of sponsors with no CH mapping (public bodies / no_match).
export const CH_FILTER_KEYS = [
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

/** Lowercase and strip non-alphanumerics so enum matching survives model/user casing and punctuation. */
function normKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Coerce a scalar param (string or finite number) to string. */
function scalarInput(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Coerce a multi-value param (array or comma-separated string) to trimmed non-empty strings. */
function listInput(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];
  return items
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
    .map((item) => item.trim())
    .filter(Boolean);
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
  const byKey = new Map(canonical.map((c) => [normKey(c), c]));
  const out: T[] = [];
  for (const item of listInput(value)) {
    const canon = byKey.get(normKey(item)) ?? aliases?.[normKey(item)];
    if (!canon) {
      issues.push(`${key}: unknown value "${item}" — dropped`);
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
  const s = scalarInput(value)?.trim();
  if (!s) return undefined;
  const canon = canonical.find((c) => normKey(c) === normKey(s));
  if (!canon) issues.push(`${key}: unknown value "${s}" — dropped`);
  return canon;
}

/** Parse a boolean param (boolean or "true"/"false"); junk is dropped with an issue. */
function boolInput(
  key: string,
  value: unknown,
  issues: string[],
): boolean | undefined {
  if (typeof value === 'boolean') return value;
  const s = scalarInput(value)?.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  issues.push(`${key}: expected true/false — dropped`);
  return undefined;
}

/** True when the string is a real calendar date (rejects e.g. 2015-02-30). */
function isRealDate(iso: string): boolean {
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
  const s = scalarInput(value)?.trim();
  if (!s) return undefined;
  if (/^\d{4}$/.test(s)) return edge === 'from' ? `${s}-01-01` : `${s}-12-31`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && isRealDate(s)) return s;
  issues.push(`${key}: invalid date "${s}" — dropped`);
  return undefined;
}

export type ParsedSearchFilters = {
  filters: SearchFilters;
  issues: string[];
};

/**
 * Validate a raw param record (URL search params, server fn input, or model
 * output) into SearchFilters. Lenient by design: invalid entries are dropped
 * and reported in `issues` rather than rejecting the whole request, so a
 * partially-wrong model emission still produces a usable query. Unknown keys
 * are ignored.
 */
export function parseSearchFilters(
  raw: Record<string, unknown>,
): ParsedSearchFilters {
  const issues: string[] = [];
  const filters: SearchFilters = {};

  const q = scalarInput(raw.q)?.trim();
  if (q) {
    if (q.length < 3) issues.push('q: needs at least 3 characters — dropped');
    else filters.q = q.slice(0, 100);
  }

  if (raw.route !== undefined) {
    filters.route = canonEnumList('route', raw.route, KNOWN_ROUTES, issues);
  }
  if (raw.workerType !== undefined) {
    filters.workerType = canonEnumList(
      'workerType',
      raw.workerType,
      WORKER_TYPES,
      issues,
      WORKER_TYPE_ALIASES,
    );
  }
  if (raw.rating !== undefined) {
    filters.rating = canonEnumList(
      'rating',
      raw.rating,
      RATINGS,
      issues,
      RATING_ALIASES,
    );
  }

  const location = scalarInput(raw.location)?.replace(/\s+/g, ' ').trim();
  if (location) {
    if (location.length > 100) {
      issues.push('location: over 100 characters — dropped');
    } else filters.location = location;
  }

  if (raw.sic !== undefined) {
    const codes = listInput(raw.sic).filter((code) => {
      const ok = /^\d{4,5}$/.test(code);
      if (!ok) issues.push(`sic: invalid code "${code}" — dropped`);
      return ok;
    });
    if (codes.length) filters.sic = [...new Set(codes)];
  }
  if (raw.sicSection !== undefined) {
    filters.sicSection = canonEnumList(
      'sicSection',
      raw.sicSection,
      Object.keys(SIC_SECTIONS),
      issues,
    );
  }

  if (raw.status !== undefined) {
    filters.status = canonEnumList(
      'status',
      raw.status,
      COMPANY_STATUSES,
      issues,
    );
  }
  if (raw.companyType !== undefined) {
    filters.companyType = canonEnumList(
      'companyType',
      raw.companyType,
      COMPANY_TYPES,
      issues,
    );
  }

  if (raw.incorporatedFrom !== undefined) {
    filters.incorporatedFrom = dateInput(
      'incorporatedFrom',
      raw.incorporatedFrom,
      'from',
      issues,
    );
  }
  if (raw.incorporatedTo !== undefined) {
    filters.incorporatedTo = dateInput(
      'incorporatedTo',
      raw.incorporatedTo,
      'to',
      issues,
    );
  }
  if (
    filters.incorporatedFrom &&
    filters.incorporatedTo &&
    filters.incorporatedFrom > filters.incorporatedTo
  ) {
    [filters.incorporatedFrom, filters.incorporatedTo] = [
      filters.incorporatedTo,
      filters.incorporatedFrom,
    ];
    issues.push('incorporatedFrom/incorporatedTo: reversed range — swapped');
  }

  for (const key of [
    'accountsOverdue',
    'hasCharges',
    'hasInsolvencyHistory',
    'hasRenamed',
    'hasMoved',
  ] as const) {
    if (raw[key] !== undefined) filters[key] = boolInput(key, raw[key], issues);
  }

  if (raw.sort !== undefined) {
    const sort = canonEnum('sort', raw.sort, SORT_KEYS, issues);
    if (sort === 'relevance' && !filters.q) {
      issues.push('sort: relevance requires q — dropped');
    } else if (sort) filters.sort = sort;
  }
  if (raw.order !== undefined) {
    filters.order = canonEnum('order', raw.order, SORT_ORDERS, issues);
  }

  return { filters, issues };
}
