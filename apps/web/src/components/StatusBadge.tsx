import { titleCase } from '../utils';

/**
 * Pill badge for a Companies House company status. Green styling is reserved
 * for the exact string `'active'`; everything else (dissolved, liquidation,
 * etc.) uses a red variant.
 */
export function StatusBadge({ status }: { status: string }) {
  const isActive = status === 'active';
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${
        isActive
          ? 'border border-[#166534]/40 text-[#166534] dark:border-[#4ade80]/40 dark:text-[#4ade80]'
          : 'border border-[#b91c1c]/40 text-[#b91c1c] dark:border-[#f87171]/40 dark:text-[#f87171]'
      }`}
    >
      {titleCase(status)}
    </span>
  );
}
