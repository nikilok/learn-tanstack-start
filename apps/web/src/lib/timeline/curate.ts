import type { DatedPreviousName } from '@ss/db';
import { ADDRESS_COLUMNS } from '@ss/db/constants';

import { STATUS_TONES, type Tone } from '../../components/StatusBadge';
import {
  formatAddress,
  formatDate,
  humanizeEnum,
  normalizeName,
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

// A same-day chain of merged same-category candidates.
type Chain = {
  kind: TimelineEventKind;
  fields: Map<string, FieldChange>;
  sortTs: string;
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

/** Companies House's placeholder for a disputed/removed registered office —
 * not a real location, so a move to/from it is a dispute event, not a move. */
function isDefaultAddress(addr: string): boolean {
  return /COMPANIES HOUSE DEFAULT ADDRESS/i.test(addr);
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
      } else {
        chains.push({ kind, fields, sortTs: createdAt, dateKey });
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
      // The default address is a dispute/removal state, not a real place: show
      // it as the office being removed or reinstated, never a Cardiff↔X move.
      if (isDefaultAddress(from)) {
        return { ...base, title: 'Registered office reinstated', detail: to };
      }
      if (isDefaultAddress(to)) {
        return {
          ...base,
          title: 'Registered office removed',
          detail: from,
          tone: 'warning',
        };
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
      // A name entering previous_company_names is the name being given up; the
      // dated-rename rework will surface what it was renamed to.
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

// Postcode from a composed address, for comparing locations by area not text.
const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s+(\d[A-Z]{2})\b/i;
function addressPostcode(addr: string | undefined): string | null {
  const m = addr?.match(UK_POSTCODE_RE);
  return m ? `${m[1]} ${m[2]}`.toUpperCase() : null;
}

/** Whole days between two 'YYYY-MM-DD' day keys. */
function daysBetween(dayA: string, dayB: string): number {
  return (
    Math.abs(
      Date.parse(`${dayA}T00:00:00Z`) - Date.parse(`${dayB}T00:00:00Z`),
    ) / 86_400_000
  );
}

// An office that leaves the current address and returns within this many days
// is a Companies House correction (a flip), not a real move.
const FLIP_WINDOW_DAYS = 7;

/**
 * Ids of there-and-back address flips to drop: an event leaving the current
 * (newest) address paired with a later one returning to it within the window,
 * plus any hops between. Matched by postcode so a country-field difference
 * (e.g. gaining "England" on the return) doesn't defeat it, on already-
 * published-date-sorted events (immune to raw-trail ordering). Never drops the
 * last move: if every move is a flip leg, the newest flip's outbound is kept so
 * one move (with its map) still shows.
 */
function flipEventIds(events: TimelineEvent[]): Set<string> {
  const drop = new Set<string>();
  const moves = events
    .filter((e) => e.kind === 'address' && e.from && e.to)
    .sort((a, b) =>
      a.dateISO !== b.dateISO
        ? a.dateISO < b.dateISO
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : 1,
    );
  if (moves.length < 2) return drop;
  const current = addressPostcode(moves[moves.length - 1].to);
  if (!current) return drop;

  // Outbound leg of the newest flip run — kept if the collapse would otherwise
  // erase every move, so a lone round-trip still shows one move (with its map).
  let lastFlipOutbound: string | null = null;
  let i = 0;
  while (i < moves.length) {
    const leaveTo = addressPostcode(moves[i].to);
    // Departs the current address for a different, real one?
    if (
      addressPostcode(moves[i].from) === current &&
      leaveTo &&
      leaveTo !== current
    ) {
      let j = i + 1;
      while (j < moves.length && addressPostcode(moves[j].to) !== current) j++;
      if (
        j < moves.length &&
        daysBetween(moves[i].dateISO, moves[j].dateISO) <= FLIP_WINDOW_DAYS
      ) {
        for (let k = i; k <= j; k++) drop.add(moves[k].id);
        lastFlipOutbound = moves[i].id;
        i = j + 1;
        continue;
      }
    }
    i++;
  }

  // Floor: never collapse away the last move. If every move was a flip leg, keep
  // the newest flip's outbound so one move (and its map) still shows.
  if (lastFlipOutbound && moves.every((m) => drop.has(m.id))) {
    drop.delete(lastFlipOutbound);
  }
  return drop;
}

/** Build dated A→B rename events from CH's dated previous names. Each former name
 *  renamed to the next-newer one (by effectiveFrom), or the current name for the
 *  most recent former name. Ordering into the timeline is left to the caller's sort. */
function buildDatedRenameEvents(
  dated: DatedPreviousName[],
  currentName: string,
): TimelineEvent[] {
  // Oldest→newest by when each name took effect; ceasedOn breaks ties so
  // tied/null effectiveFrom entries still chain deterministically (total order).
  const key = (e: DatedPreviousName) =>
    `${e.effectiveFrom ?? ''}|${e.ceasedOn ?? ''}`;
  const sorted = [...dated].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const events: TimelineEvent[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i].name;
    const ceasedOn = sorted[i].ceasedOn;
    // No ceased_on → can't date the event; the name still shows in the SEO
    // sentence. Rare (very old records).
    if (!ceasedOn) continue;
    const to = i < sorted.length - 1 ? sorted[i + 1].name : currentName;
    // Collapse cosmetic LTD/LIMITED-only renames.
    if (normalizeName(from) === normalizeName(to)) continue;
    events.push({
      id: `rename:${i}:${ceasedOn}:${normalizeName(from)}`,
      kind: 'rename',
      dateISO: ceasedOn,
      dateLabel: formatDate(ceasedOn),
      title: 'Company renamed',
      from: titleCase(from),
      to: titleCase(to),
      tone: 'neutral',
    });
  }
  return events;
}

/** Curate ordered trail rows into display-ready events, newest first, anchors in place. */
export function curateTimeline(input: {
  rows: TrailRow[];
  dateOfCreation: string | null;
  sicDescriptions: ReadonlyMap<string, string>;
  previousCompanyNamesDated: DatedPreviousName[];
  currentName: string;
  // True when rows were capped — older history exists but wasn't fetched.
  truncated?: boolean;
}): TimelineEvent[] {
  const sortable: { event: TimelineEvent; sortTs: string }[] = [];
  const deletedDates = new Set<string>();
  // Dated renames from the CH profile are the source of truth when present;
  // suppress the trail-diff `rename` to avoid double-counting. Keyed on the
  // EMITTED events (not the raw array): if the dated entries yield none (e.g. all
  // null ceased_on), keep the trail-diff fallback so the rename doesn't vanish.
  const datedRenames = buildDatedRenameEvents(
    input.previousCompanyNamesDated,
    input.currentName,
  );
  const hasDatedRenames = datedRenames.length > 0;
  for (const chain of buildChains(input.rows)) {
    if (hasDatedRenames && chain.kind === 'rename') continue;
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
  for (const event of datedRenames) {
    // Full-timestamp sortTs (end of day) so a dated rename doesn't string-sort
    // below same-day trail events, which carry a real time.
    sortable.push({ event, sortTs: `${event.dateISO} 23:59:59` });
  }

  // Drop there-and-back address flips (CH corrections) so a week-long revert
  // isn't shown as churn — but never the last move, so one map always remains.
  const flips = flipEventIds(sortable.map((s) => s.event));
  const kept = flips.size
    ? sortable.filter((s) => !flips.has(s.event.id))
    : sortable;

  // Anchor: the truncation "Earlier changes not shown" marker is a data-honesty
  // caveat and must ALWAYS show when history was capped. The "Change tracking
  // began" marker, by contrast, reads as a contradiction sitting above older
  // dated (pre-tracking) renames, so show it only when there are none.
  if (input.truncated) {
    // Capped — anchor at the oldest retained event, not the tracking date.
    const oldestShown =
      kept.length > 0
        ? kept.reduce<string>(
            (min, s) => (s.event.dateISO < min ? s.event.dateISO : min),
            kept[0].event.dateISO,
          )
        : TRACKING_SINCE;
    kept.push({
      sortTs: '',
      event: {
        id: `tracking-start:${oldestShown}`,
        kind: 'tracking-start',
        dateISO: oldestShown,
        dateLabel: formatDate(oldestShown),
        title: 'Earlier changes not shown',
        tone: 'neutral',
      },
    });
  } else if (!hasDatedRenames) {
    kept.push({
      sortTs: '',
      event: {
        id: `tracking-start:${TRACKING_SINCE}`,
        kind: 'tracking-start',
        dateISO: TRACKING_SINCE,
        dateLabel: formatDate(TRACKING_SINCE),
        title: 'Change tracking began',
        detail: 'Automatic tracking started here',
        tone: 'neutral',
      },
    });
  }

  if (input.dateOfCreation) {
    kept.push({
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

  return kept
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
