/**
 * Full SponsorSearch.co.uk wordmark — mirrors the web app's Logo (Union-Jack lens +
 * text), themed via the title-bar tokens (`--tb-mark` navy, `--tb-mark-red`) so it
 * flips with light/dark. Fixed text offsets assume the Geist face loaded in style.css.
 */
export function Logo({ className }: { className?: string }) {
  const navy = 'var(--tb-mark)';
  const red = 'var(--tb-mark-red)';
  return (
    <svg
      className={className}
      viewBox="0 0 735 150"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      role="img"
      aria-label="SponsorSearch.co.uk"
    >
      <g transform="translate(30, 10)">
        <path
          d="M75,10 H20 A10,10 0 0 0 10,20 V100 A10,10 0 0 0 20,110 H85"
          fill="none"
          stroke={navy}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M100,35 V20 A10,10 0 0 0 90,10 H85"
          fill="none"
          stroke={navy}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <rect
          x="95"
          y="100"
          width="14"
          height="30"
          rx="6"
          ry="6"
          fill={navy}
          transform="rotate(-45 95 100)"
        />
        <rect
          x="98"
          y="80"
          width="7"
          height="30"
          rx="6"
          ry="6"
          fill={navy}
          transform="rotate(-45 95 100)"
        />
        <circle cx="60" cy="60" r="38" fill={navy} />
        <clipPath id="tb-logo-clip">
          <circle cx="60" cy="60" r="29" />
        </clipPath>
        <g clipPath="url(#tb-logo-clip)">
          <rect x="18" y="18" width="84" height="84" fill="#012169" />
          <path
            d="M18,18 L102,102 M102,18 L18,102"
            stroke="white"
            strokeWidth="12"
          />
          <path
            d="M18,18 L102,102 M102,18 L18,102"
            stroke={red}
            strokeWidth="4"
          />
          <path d="M60,18 V102 M18,60 H102" stroke="white" strokeWidth="20" />
          <path d="M60,18 V102 M18,60 H102" stroke={red} strokeWidth="12" />
        </g>
      </g>
      <text
        x="145"
        y="95"
        fontSize="82"
        fill={navy}
        fontFamily="Geist"
        fontWeight="600"
      >
        Sponsor
      </text>
      <text
        x="460"
        y="95"
        fontSize="82"
        fill={red}
        fontFamily="Geist"
        fontWeight="600"
      >
        Search
      </text>
      <text
        x="735"
        y="130"
        fontSize="40"
        textAnchor="end"
        fill={navy}
        fontFamily="Geist"
        fontWeight="600"
      >
        .co.uk
      </text>
    </svg>
  );
}
