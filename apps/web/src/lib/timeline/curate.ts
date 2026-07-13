import { STATUS_TONES, type Tone } from '../../components/StatusBadge';
import {
  formatAddress,
  formatDate,
  humanizeEnum,
  titleCase,
} from '../../utils';
import type {
  TimelineEvent,
  TimelineEventKind,
  TimelineTone,
  TrailRow,
} from './types';

// First trail row ever written by ch-stream in production.
export const TRACKING_SINCE = '2026-04-14';

const ADDRESS_COLUMNS = [
  'addressLine1',
  'addressLine2',
  'locality',
  'region',
  'postalCode',
  'country',
] as const;

const ACCOUNTS_COLUMNS = [
  'accountsLastMadeUpTo',
  'accountsNextMadeUpTo',
  'accountsOverdue',
] as const;

// Trail column → curation category; unknown columns are suppressed.
const COLUMN_CATEGORY: Record<string, TimelineEventKind> = {
  ...Object.fromEntries(ADDRESS_COLUMNS.map((c) => [c, 'address'])),
  ...Object.fromEntries(ACCOUNTS_COLUMNS.map((c) => [c, 'accounts'])),
  companyStatus: 'status',
  confirmationStatementLastMadeUpTo: 'confirmation',
  sicCodes: 'sic',
  previousCompanyNames: 'rename',
  hasInsolvencyHistory: 'insolvency',
  hasBeenLiquidated: 'liquidation',
  hasCharges: 'charges',
  companyType: 'company-type',
  jurisdiction: 'jurisdiction',
  dateOfCreation: 'incorporation-date-fix',
  _deleted: 'deleted',
};

// Derived from StatusBadge's buckets so badge and timeline dot never disagree.
const TONE_BY_BUCKET: Record<Tone, TimelineTone> = {
  green: 'positive',
  amber: 'warning',
  red: 'negative',
  grey: 'neutral',
};

type FieldChange = { old: string | null; new: string | null };

// Consecutive same-category changes whose days fall within this window merge
// into one chain — so a value that flip-flops back within a week (a Companies
// House correction, not a real move) nets out instead of showing separately.
const COLLAPSE_WINDOW_DAYS = 7;

// A chain of merged same-category candidates within the collapse window.
type Chain = {
  kind: TimelineEventKind;
  fields: Map<string, FieldChange>;
  sortTs: string;
  displayTs: string;
  dateKey: string;
};

/** SIC codes referenced by sicCodes diff rows (old ∪ new), for description lookup. */
export function collectSicCodes(rows: TrailRow[]): string[] {
  const codes = new Set<string>();
  for (const row of rows) {
    if (row.columnName !== 'sicCodes') continue;
    for (const value of [row.oldValue, row.newValue]) {
      for (const code of parseJsonStringArray(value) ?? []) codes.add(code);
    }
  }
  return [...codes];
}

/** Whole days between two 'YYYY-MM-DD' day keys. */
function daysBetween(dayA: string, dayB: string): number {
  const a = Date.parse(`${dayA}T00:00:00Z`);
  const b = Date.parse(`${dayB}T00:00:00Z`);
  return Math.abs(a - b) / 86_400_000;
}

/** Parse a JSON-stringified string array trail value; null when not one. */
function parseJsonStringArray(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}

/** Compose one side of an address change via the page's shared formatAddress. */
function composeAddress(
  fields: Map<string, FieldChange>,
  side: 'old' | 'new',
): string {
  const value = (col: string) => fields.get(col)?.[side] ?? undefined;
  return formatAddress({
    address_line_1: value('addressLine1'),
    address_line_2: value('addressLine2'),
    locality: value('locality'),
    region: value('region'),
    postal_code: value('postalCode'),
    country: value('country'),
  });
}

/** Tone for a company status value, via StatusBadge's shared buckets. */
function statusTone(status: string | null): TimelineTone {
  const bucket = status
    ? STATUS_TONES[status as keyof typeof STATUS_TONES]
    : undefined;
  return bucket ? TONE_BY_BUCKET[bucket] : 'neutral';
}

/** Group rows into per-event candidates and merge same-day same-category chains. */
function buildChains(rows: TrailRow[]): Chain[] {
  // One CH event = one INSERT batch = one exact created_at; group on the raw string.
  const groups = new Map<string, TrailRow[]>();
  for (const row of rows) {
    const group = groups.get(row.createdAt);
    if (group) group.push(row);
    else groups.set(row.createdAt, [row]);
  }

  const chains: Chain[] = [];
  for (const [createdAt, group] of groups) {
    const displayTs = group[0].publishedAt ?? createdAt;
    const dateKey = displayTs.slice(0, 10);
    // Split a mixed group into one candidate per category.
    const byKind = new Map<TimelineEventKind, Map<string, FieldChange>>();
    for (const row of group) {
      const kind = COLUMN_CATEGORY[row.columnName];
      if (!kind) continue;
      let fields = byKind.get(kind);
      if (!fields) byKind.set(kind, (fields = new Map()));
      fields.set(row.columnName, { old: row.oldValue, new: row.newValue });
    }
    for (const [kind, fields] of byKind) {
      // Merge into the most recent same-category chain when it's within the
      // collapse window (keeps the chain's `old`, takes the candidate's `new`)
      // so a value returning to a recent one — a within-a-week flip-flop — nets
      // out. The most recent chain has the latest day, so if it's out of window,
      // every older one is too.
      let chain: Chain | undefined;
      for (let i = chains.length - 1; i >= 0; i--) {
        if (chains[i].kind !== kind) continue;
        if (daysBetween(chains[i].dateKey, dateKey) <= COLLAPSE_WINDOW_DAYS) {
          chain = chains[i];
        }
        break;
      }
      if (chain) {
        for (const [col, change] of fields) {
          const existing = chain.fields.get(col);
          if (existing) existing.new = change.new;
          else chain.fields.set(col, { ...change });
        }
        chain.sortTs = createdAt;
        chain.displayTs = displayTs;
      } else {
        chains.push({ kind, fields, sortTs: createdAt, displayTs, dateKey });
      }
    }
  }

  // Drop fields the day netted out to no change, then empty chains.
  for (const chain of chains) {
    for (const [col, change] of chain.fields) {
      if ((change.old ?? '') === (change.new ?? '')) chain.fields.delete(col);
    }
  }
  return chains.filter((chain) => chain.fields.size > 0);
}

/** Render a chain into a display event; null when the chain is suppressed noise. */
function renderChain(
  chain: Chain,
  sicDescriptions: ReadonlyMap<string, string>,
): TimelineEvent | null {
  const { kind, fields } = chain;
  const dateISO = chain.dateKey;
  const base = {
    id: `${kind}:${chain.sortTs}`,
    kind,
    dateISO,
    dateLabel: formatDate(dateISO),
    tone: 'neutral' as TimelineTone,
  };

  switch (kind) {
    case 'status': {
      const change = fields.get('companyStatus');
      if (!change?.new) return null;
      if (!change.old) {
        return {
          ...base,
          title: 'Status recorded',
          detail: humanizeEnum(change.new),
          tone: statusTone(change.new),
        };
      }
      return {
        ...base,
        title: 'Status changed',
        from: humanizeEnum(change.old),
        to: humanizeEnum(change.new),
        tone: statusTone(change.new),
      };
    }
    case 'address': {
      const from = composeAddress(fields, 'old');
      const to = composeAddress(fields, 'new');
      if (!to && !from) return null;
      if (!from) {
        return { ...base, title: 'Registered address recorded', detail: to };
      }
      if (!to) {
        return { ...base, title: 'Registered address removed', detail: from };
      }
      // A value shuffled between address columns composes identically — no-op.
      if (from === to) return null;
      // Map only real moves: a postcode on both sides geocodes precisely.
      const postcode = fields.get('postalCode');
      return {
        ...base,
        title: 'Registered address changed',
        from,
        to,
        mappable: Boolean(postcode?.old && postcode.new) || undefined,
      };
    }
    case 'accounts': {
      const filed = fields.get('accountsLastMadeUpTo');
      if (filed?.new) {
        return {
          ...base,
          title: 'Annual accounts filed',
          detail: `Made up to ${formatDate(filed.new)}`,
          tone: 'positive',
        };
      }
      const overdue = fields.get('accountsOverdue');
      if (overdue?.new === 'true') {
        return { ...base, title: 'Annual accounts overdue', tone: 'warning' };
      }
      // Only a real true→false clears; null→false just records the absence.
      if (overdue?.old === 'true') {
        return {
          ...base,
          title: 'Accounts overdue flag cleared',
          tone: 'positive',
        };
      }
      // Deadline recalcs and first-recorded-false flags — bookkeeping noise.
      return null;
    }
    case 'confirmation': {
      const change = fields.get('confirmationStatementLastMadeUpTo');
      if (!change?.new) return null;
      return {
        ...base,
        title: 'Confirmation statement filed',
        detail: `Made up to ${formatDate(change.new)}`,
      };
    }
    case 'sic': {
      const change = fields.get('sicCodes');
      if (!change) return null;
      const oldCodes = parseJsonStringArray(change.old);
      const newCodes = parseJsonStringArray(change.new);
      const title = 'Industry classification updated';
      if (!oldCodes && !newCodes) return { ...base, title };
      const before = new Set(oldCodes ?? []);
      const after = new Set(newCodes ?? []);
      const describe = (code: string) => sicDescriptions.get(code) ?? code;
      const lines = [
        ...[...after]
          .filter((c) => !before.has(c))
          .map((c) => `+ ${describe(c)}`),
        ...[...before]
          .filter((c) => !after.has(c))
          .map((c) => `− ${describe(c)}`),
      ];
      if (lines.length === 0) return null;
      return { ...base, title, detail: lines.join('\n') };
    }
    case 'rename': {
      const change = fields.get('previousCompanyNames');
      if (!change) return null;
      const before = new Set(parseJsonStringArray(change.old) ?? []);
      const added = (parseJsonStringArray(change.new) ?? []).filter(
        (name) => !before.has(name),
      );
      // A name entering previous_company_names is the name being given up;
      // the new name isn't trailed (companyName is excluded from diffing).
      if (added.length === 0) return null;
      return {
        ...base,
        title: 'Company renamed',
        detail: `Formerly ${added.map(titleCase).join(', ')}`,
      };
    }
    case 'insolvency': {
      const change = fields.get('hasInsolvencyHistory');
      const recorded = change?.new === 'true';
      // null→false first-records the flag — a "cleared" needs a real true.
      if (!recorded && change?.old !== 'true') return null;
      return {
        ...base,
        title: recorded
          ? 'Insolvency history recorded'
          : 'Insolvency history flag cleared',
        tone: recorded ? 'negative' : 'neutral',
      };
    }
    case 'liquidation': {
      const change = fields.get('hasBeenLiquidated');
      const recorded = change?.new === 'true';
      if (!recorded && change?.old !== 'true') return null;
      return {
        ...base,
        title: recorded ? 'Liquidation recorded' : 'Liquidation flag cleared',
        tone: recorded ? 'negative' : 'neutral',
      };
    }
    case 'charges': {
      const change = fields.get('hasCharges');
      const recorded = change?.new === 'true';
      if (!recorded && change?.old !== 'true') return null;
      return {
        ...base,
        title: recorded ? 'Charges registered' : 'Charges cleared',
      };
    }
    case 'company-type': {
      const change = fields.get('companyType');
      if (!change?.new) return null;
      if (!change.old) {
        return {
          ...base,
          title: 'Company type recorded',
          detail: humanizeEnum(change.new),
        };
      }
      return {
        ...base,
        title: 'Company type changed',
        from: humanizeEnum(change.old),
        to: humanizeEnum(change.new),
      };
    }
    case 'jurisdiction': {
      const change = fields.get('jurisdiction');
      if (!change?.new) return null;
      if (!change.old) {
        return {
          ...base,
          title: 'Jurisdiction recorded',
          detail: humanizeEnum(change.new),
        };
      }
      return {
        ...base,
        title: 'Jurisdiction changed',
        from: humanizeEnum(change.old),
        to: humanizeEnum(change.new),
      };
    }
    case 'incorporation-date-fix': {
      const change = fields.get('dateOfCreation');
      if (!change?.new) return null;
      if (!change.old) {
        return {
          ...base,
          title: 'Incorporation date recorded',
          detail: formatDate(change.new),
        };
      }
      return {
        ...base,
        title: 'Incorporation date corrected',
        from: formatDate(change.old),
        to: formatDate(change.new),
      };
    }
    case 'deleted': {
      // The tombstone stores the CH published_at in new_value.
      const raw = fields.get('_deleted')?.new;
      const dateFromValue =
        raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : dateISO;
      return {
        ...base,
        dateISO: dateFromValue,
        dateLabel: formatDate(dateFromValue),
        title: 'Removed from the Companies House register',
        tone: 'negative',
      };
    }
    default:
      return null;
  }
}

// Same-date ordering: change events above the incorporated anchor, tracking marker last.
const KIND_RANK: Partial<Record<TimelineEventKind, number>> = {
  incorporated: 1,
  'tracking-start': 0,
};

/** Curate ordered trail rows into display-ready events, newest first, anchors in place. */
export function curateTimeline(input: {
  rows: TrailRow[];
  dateOfCreation: string | null;
  sicDescriptions: ReadonlyMap<string, string>;
  // True when rows were capped — older history exists but wasn't fetched.
  truncated?: boolean;
}): TimelineEvent[] {
  const sortable: { event: TimelineEvent; sortTs: string }[] = [];
  const deletedDates = new Set<string>();
  for (const chain of buildChains(input.rows)) {
    const event = renderChain(chain, input.sicDescriptions);
    if (!event) continue;
    // Replayed _deleted tombstones straddling midnight escape the same-day
    // merge but re-derive one date from new_value — keep a single event.
    if (event.kind === 'deleted') {
      if (deletedDates.has(event.dateISO)) continue;
      deletedDates.add(event.dateISO);
    }
    sortable.push({ event, sortTs: chain.sortTs });
  }

  // When history was capped, "tracking began 14 April" would falsely assert
  // completeness — anchor at the oldest retained event instead.
  const oldestShown =
    input.truncated && sortable.length > 0
      ? sortable.reduce<string>(
          (min, s) => (s.event.dateISO < min ? s.event.dateISO : min),
          sortable[0].event.dateISO,
        )
      : TRACKING_SINCE;
  sortable.push({
    sortTs: '',
    event: {
      id: `tracking-start:${oldestShown}`,
      kind: 'tracking-start',
      dateISO: oldestShown,
      dateLabel: formatDate(oldestShown),
      title: input.truncated
        ? 'Earlier changes not shown'
        : 'Change tracking began',
      detail: input.truncated ? undefined : 'Earlier changes aren’t shown',
      tone: 'neutral',
    },
  });

  if (input.dateOfCreation) {
    sortable.push({
      sortTs: '',
      event: {
        id: `incorporated:${input.dateOfCreation}`,
        kind: 'incorporated',
        dateISO: input.dateOfCreation,
        dateLabel: formatDate(input.dateOfCreation),
        title: 'Incorporated',
        tone: 'positive',
      },
    });
  }

  return sortable
    .sort((a, b) => {
      if (a.event.dateISO !== b.event.dateISO) {
        return a.event.dateISO < b.event.dateISO ? 1 : -1;
      }
      const rankA = KIND_RANK[a.event.kind] ?? 2;
      const rankB = KIND_RANK[b.event.kind] ?? 2;
      if (rankA !== rankB) return rankB - rankA;
      if (a.sortTs !== b.sortTs) return a.sortTs < b.sortTs ? 1 : -1;
      return a.event.id < b.event.id ? 1 : -1;
    })
    .map((entry) => entry.event);
}
