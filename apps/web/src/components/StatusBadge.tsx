import { titleCase } from '../utils';

/**
 * Known Companies House `company_status` values, sourced from the production
 * `companies_house_profiles.company_status` column. New values added by
 * Companies House will fall through to the neutral grey tone.
 */
type CompanyStatus =
  | 'active'
  | 'dissolved'
  | 'liquidation'
  | 'open'
  | 'registered'
  | 'converted-closed'
  | 'administration'
  | 'closed'
  | 'voluntary-arrangement'
  | 'insolvency-proceedings'
  | 'receivership'
  | 'removed';

export type Tone = 'green' | 'amber' | 'red' | 'grey';

// Exported so the timeline's dot tones stay in lockstep with the badge.
export const STATUS_TONES: Record<CompanyStatus, Tone> = {
  active: 'green',
  open: 'green',
  registered: 'green',
  administration: 'amber',
  'voluntary-arrangement': 'amber',
  receivership: 'amber',
  'insolvency-proceedings': 'amber',
  dissolved: 'red',
  liquidation: 'red',
  'converted-closed': 'grey',
  closed: 'grey',
  removed: 'grey',
};

// Theme-paired shades live in styles.css (--status-*) so the badge and the
// timeline dots draw from one palette.
const TONE_CLASSES: Record<Tone, string> = {
  green: 'border border-(--status-green)/40 text-(--status-green)',
  amber: 'border border-(--status-amber)/40 text-(--status-amber)',
  red: 'border border-(--status-red)/40 text-(--status-red)',
  grey: 'border border-(--status-grey)/40 text-(--status-grey)',
};

/**
 * Pill badge for a Companies House company status. Tone is derived from a
 * semantic bucket (operating / in-trouble / terminated / administrative)
 * rather than per-status, with theme-paired shades for light + dark contrast.
 */
export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONES[status as CompanyStatus] ?? 'grey';
  return (
    <span
      className={`inline-block rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {titleCase(status)}
    </span>
  );
}
