import { formatDate, titleCase } from '../../utils';
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

// Mirrors StatusBadge's semantic buckets (green/amber/red/grey).
const STATUS_TONES: Record<string, TimelineTone> = {
  active: 'positive',
  open: 'positive',
  registered: 'positive',
  administration: 'warning',
  'voluntary-arrangement': 'warning',
  receivership: 'warning',
  'insolvency-proceedings': 'warning',
  dissolved: 'negative',
  liquidation: 'negative',
};

type FieldChange = { old: string | null; new: string | null };

// A same-day chain of merged same-category candidates.
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

/** Compose one side of an address change from the fields present in a chain. */
function composeAddress(
  fields: Map<string, FieldChange>,
  side: 'old' | 'new',
): string {
  return ADDRESS_COLUMNS.map((col) => fields.get(col)?.[side])
    .filter(Boolean)
    .join(', ');
}

/** Tone for a company status value, bucketed like StatusBadge. */
function statusTone(status: string | null): TimelineTone {
  return (status && STATUS_TONES[status]) || 'neutral';
}

/** Humanize a hyphenated CH enum value ("voluntary-arrangement" → "Voluntary Arrangement"). */
function humanizeEnum(value: string | null): string {
  return titleCase((value ?? '').replace(/-/g, ' '));
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
      // Same category + same event day → merge into the chain (keeps the
      // chain's `old`, takes the candidate's `new`) so flip-flops collapse.
      let chain: Chain | undefined;
      for (let i = chains.length - 1; i >= 0; i--) {
        if (chains[i].kind === kind && chains[i].dateKey === dateKey) {
          chain = chains[i];
          break;
        }
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
      return { ...base, title: 'Registered address changed', from, to };
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
      if (overdue) {
        return {
          ...base,
          title: 'Accounts overdue flag cleared',
          tone: 'positive',
        };
      }
      // Only accountsNextMadeUpTo (CH deadline recalc) — bookkeeping noise.
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
      const recorded = fields.get('hasInsolvencyHistory')?.new === 'true';
      return {
        ...base,
        title: recorded
          ? 'Insolvency history recorded'
          : 'Insolvency history flag cleared',
        tone: recorded ? 'negative' : 'neutral',
      };
    }
    case 'liquidation': {
      const recorded = fields.get('hasBeenLiquidated')?.new === 'true';
      return {
        ...base,
        title: recorded ? 'Liquidation recorded' : 'Liquidation flag cleared',
        tone: recorded ? 'negative' : 'neutral',
      };
    }
    case 'charges': {
      const recorded = fields.get('hasCharges')?.new === 'true';
      return {
        ...base,
        title: recorded ? 'Charges registered' : 'Charges cleared',
      };
    }
    case 'company-type': {
      const change = fields.get('companyType');
      if (!change?.new) return null;
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
}): TimelineEvent[] {
  const sortable: { event: TimelineEvent; sortTs: string }[] = [];
  for (const chain of buildChains(input.rows)) {
    const event = renderChain(chain, input.sicDescriptions);
    if (event) sortable.push({ event, sortTs: chain.sortTs });
  }

  sortable.push({
    sortTs: '',
    event: {
      id: `tracking-start:${TRACKING_SINCE}`,
      kind: 'tracking-start',
      dateISO: TRACKING_SINCE,
      dateLabel: formatDate(TRACKING_SINCE),
      title: 'Change tracking began',
      detail: 'Earlier changes aren’t shown',
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
