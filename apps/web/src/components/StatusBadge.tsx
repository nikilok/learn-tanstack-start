import { titleCase } from '../utils';

/**
 * Known Companies House `company_status` values, sourced from the production
 * `companies_house_profiles.company_status` column. New values added by
 * Companies House will fall through to the neutral grey tone.
 */
export type CompanyStatus =
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

type Tone = 'green' | 'amber' | 'red' | 'grey';

const STATUS_TONES: Record<CompanyStatus, Tone> = {
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

// Each tone pairs a dark shade (Tailwind 700/800) for light-mode text on white
// with a light shade (Tailwind 400) for dark-mode text on near-black, matching
// the green/red contrast already used in this project.
const TONE_CLASSES: Record<Tone, string> = {
  green:
    'border border-[#166534]/40 text-[#166534] dark:border-[#4ade80]/40 dark:text-[#4ade80]',
  amber:
    'border border-[#92400e]/40 text-[#92400e] dark:border-[#fbbf24]/40 dark:text-[#fbbf24]',
  red: 'border border-[#b91c1c]/40 text-[#b91c1c] dark:border-[#f87171]/40 dark:text-[#f87171]',
  grey: 'border border-[#374151]/40 text-[#374151] dark:border-[#9ca3af]/40 dark:text-[#9ca3af]',
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
      className={`inline-block whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {titleCase(status)}
    </span>
  );
}
