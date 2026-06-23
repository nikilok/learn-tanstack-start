import type { ReactNode } from 'react';

// Shared uppercase micro-label style for field <dt>s and section headings.
export const LABEL_CLASS =
  'text-[10px] font-medium tracking-wider text-(--sea-ink-soft) uppercase';

/** A label/value pair in a definition-list grid; `literal` blocks iOS auto-linking of ID-like values. */
export function DetailField({
  label,
  value,
  className,
  valueClassName = 'mt-1 text-sm text-(--sea-ink)',
  literal = false,
}: {
  label: string;
  value: ReactNode;
  className?: string;
  valueClassName?: string;
  literal?: boolean;
}) {
  return (
    <div className={className}>
      <dt className={LABEL_CLASS}>{label}</dt>
      <dd className={valueClassName}>
        {literal ? <span x-apple-data-detectors="false">{value}</span> : value}
      </dd>
    </div>
  );
}
