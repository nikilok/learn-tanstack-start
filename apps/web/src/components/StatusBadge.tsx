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
          ? 'border border-[#16a34a]/40 text-[#16a34a]'
          : 'border border-[#dc2626]/40 text-[#dc2626]'
      }`}
    >
      {titleCase(status)}
    </span>
  );
}
