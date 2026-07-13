export type TimelineTone = 'positive' | 'neutral' | 'warning' | 'negative';

export type TimelineEventKind =
  | 'status'
  | 'address'
  | 'accounts'
  | 'accounts-overdue'
  | 'confirmation'
  | 'sic'
  | 'rename'
  | 'insolvency'
  | 'liquidation'
  | 'charges'
  | 'company-type'
  | 'jurisdiction'
  | 'incorporation-date-fix'
  | 'deleted'
  | 'tracking-start'
  | 'incorporated';

/** One display-ready node on the company timeline, curated server-side. */
export type TimelineEvent = {
  id: string;
  kind: TimelineEventKind;
  dateISO: string;
  dateLabel: string;
  title: string;
  detail?: string;
  from?: string;
  to?: string;
  // Address changes where both sides carry a postcode — geocodable for the map.
  mappable?: boolean;
  tone: TimelineTone;
};

/** Raw trail row with timestamps as `::text` strings (never JS Dates — the
 * neon driver parses naive timestamps in the local TZ and truncates µs). */
export type TrailRow = {
  columnName: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  publishedAt: string | null;
};
