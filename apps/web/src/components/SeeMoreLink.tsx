import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';

const PILL_CLASS =
  'glass brand-link inline-flex w-fit items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-black no-underline transition-[box-shadow]! duration-300! dark:text-white';

/**
 * Outbound pill link for the "See more on" section: a glass pill with an
 * optional brand logo, optional text label, and a trailing external-link icon,
 * opening in a new tab. `brand-link` is inert unless the logo carries
 * `brand-mark`, so it's safe to share across tinted and brand-coloured logos.
 * Without `href` it is the pill alone, inert and hidden from assistive tech:
 * the page's frame while the company it would link to loads.
 */
export function SeeMoreLink({
  href,
  logo,
  label,
  ariaLabel,
}: {
  href?: string;
  logo?: ReactNode;
  label?: string;
  ariaLabel?: string;
}) {
  const content = (
    <>
      {logo}
      {label && <span>{label}</span>}
      <ExternalLink size={14} aria-hidden="true" />
    </>
  );
  if (!href)
    return (
      <span aria-hidden className={`${PILL_CLASS} pointer-events-none`}>
        {content}
      </span>
    );
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={ariaLabel}
      className={PILL_CLASS}
    >
      {content}
    </a>
  );
}
