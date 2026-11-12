// A plan applies on top of whatever filters the visitor set by hand: the
// plan wins per key, the base is remembered so clearing the question
// restores it, and the chips say what the question became.

import {
  filterSearchKey,
  type SearchUrlParams,
  SIC_SECTIONS,
} from '@ss/search-filters';

/** A filter set as a comparable string, whatever order its keys arrived in: the same key the filter query caches under. */
export const paramsKey: (params: SearchUrlParams) => string = filterSearchKey;

/** The base filters with the plan laid over them: the plan wins per key. */
export function applyOverlay(
  base: SearchUrlParams,
  plan: SearchUrlParams,
): SearchUrlParams {
  const merged: SearchUrlParams = { ...base };
  // A hand-set date bound the question's crosses goes, or the pair would be
  // a range nobody asked for (the registry swaps a reversed pair on the way
  // in); one the question's does not cross stays and narrows it.
  if (
    plan.incorporatedFrom !== undefined &&
    merged.incorporatedTo !== undefined &&
    plan.incorporatedFrom > merged.incorporatedTo
  )
    delete merged.incorporatedTo;
  if (
    plan.incorporatedTo !== undefined &&
    merged.incorporatedFrom !== undefined &&
    plan.incorporatedTo < merged.incorporatedFrom
  )
    delete merged.incorporatedFrom;
  for (const [key, value] of Object.entries(plan)) {
    if (value !== undefined)
      (merged as Record<string, string | boolean>)[key] = value;
  }
  return merged;
}

const COMPANY_TYPE_LABELS: Record<string, string> = {
  ltd: 'Private limited company',
  plc: 'PLC',
  llp: 'LLP',
  'charitable-incorporated-organisation':
    'Charitable incorporated organisation',
  'private-limited-guarant-nsc': 'Limited by guarantee',
  'royal-charter': 'Royal charter body',
};

const FLAG_LABELS: Record<string, [yes: string, no: string]> = {
  accountsOverdue: ['Accounts overdue', 'Accounts not overdue'],
  hasCharges: ['Has charges', 'No charges'],
  hasInsolvencyHistory: ['Insolvency history', 'No insolvency history'],
  hasRenamed: ['Has changed name', 'Never changed name'],
  hasMoved: ['Has moved office', 'Never moved office'],
};

// Keyed by the URL form's plain string; an unknown sort reads as itself.
const SORT_LABELS: Record<string, string> = {
  relevance: 'By relevance',
  name: 'By name',
  incorporated: 'By incorporation date',
};

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The base with the plan laid over it (applyOverlay), the plan's sector replacing a hand-set one the way its other keys do: by leaving, since it ranks now and cuts nothing (lib/ask/sector), and clearing the question brings the base back. */
export function applyPlan(
  base: SearchUrlParams,
  filters: SearchUrlParams,
  sector: string | null,
): SearchUrlParams {
  const merged = applyOverlay(base, filters);
  if (sector !== null) delete merged.sicSection;
  return merged;
}

/** A bound as a chip reads it: the year alone at a year's edge, the month at a month's edge, the day otherwise. */
function dateLabel(iso: string, edge: 'from' | 'to'): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (edge === 'from' ? m === 1 && d === 1 : m === 12 && d === 31)
    return String(y);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const month = MONTH_NAMES[m - 1] ?? String(m);
  return (edge === 'from' ? d === 1 : d === lastDay)
    ? `${month} ${y}`
    : `${d} ${month} ${y}`;
}

/** A slug as words, with its first letter upper-cased. */
const words = (slug: string) =>
  slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** One short label per applied filter, in registry order, for the chips. */
export function describeFilters(params: SearchUrlParams): string[] {
  const chips: string[] = [];
  const list = (value: string | undefined) =>
    value === undefined ? [] : value.split(',').map((v) => v.trim());
  chips.push(...list(params.route));
  chips.push(...list(params.workerType));
  chips.push(...list(params.rating).map((r) => `Rating ${r}`));
  if (params.location)
    chips.push(`In ${params.location.split(',').join(' or ')}`);
  chips.push(
    ...list(params.sicSection).map((s) => SIC_SECTIONS[s]?.label ?? s),
  );
  chips.push(...list(params.sic).map((code) => `SIC ${code}`));
  if (params.industry) chips.push(params.industry);
  chips.push(...list(params.status).map(words));
  chips.push(
    ...list(params.companyType).map((t) => COMPANY_TYPE_LABELS[t] ?? words(t)),
  );
  if (params.incorporatedFrom)
    chips.push(
      `Incorporated from ${dateLabel(params.incorporatedFrom, 'from')}`,
    );
  if (params.incorporatedTo)
    chips.push(`Incorporated up to ${dateLabel(params.incorporatedTo, 'to')}`);
  // True-only in the registry (params.ts), so it has no second label.
  if (params.hasWebsite) chips.push('Has a website');
  for (const [key, [yes, no]] of Object.entries(FLAG_LABELS)) {
    const value = params[key as keyof SearchUrlParams];
    if (value === true) chips.push(yes);
    else if (value === false) chips.push(no);
  }
  if (params.sort) {
    const order = params.order === 'desc' ? 'newest first' : 'oldest first';
    chips.push(
      params.sort === 'incorporated'
        ? `Incorporated, ${order}`
        : (SORT_LABELS[params.sort] ?? params.sort),
    );
  }
  return chips;
}

/** The sector a question named, as chips: ranked first, never required (lib/ask/sector); none when it named none. */
export function describeSector(sector: string | null): string[] {
  if (sector === null) return [];
  return sector
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${SIC_SECTIONS[s]?.label ?? s} first`);
}
