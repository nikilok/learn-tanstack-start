interface LogoProps {
  className?: string;
  navyColor?: string;
  redColor?: string;
  domainColor?: string;
  strokeColor?: string;
}

export default function Logo({
  className,
  navyColor = 'var(--logo-navy)',
  redColor = 'var(--logo-red)',
  domainColor,
  strokeColor,
}: LogoProps) {
  const resolvedDomain = domainColor ?? navyColor;
  const resolvedStroke = strokeColor ?? navyColor;

  return (
    <svg
      className={className}
      viewBox="0 0 735 150"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      role="img"
      aria-label="SponsorSearch.co.uk"
    >
      {/* Left Icon: Frame and Magnifying Glass */}
      <g transform="translate(30, 10)">
        {/* Outer Frame (Stylized) */}
        <path
          d="M75,10 H20 A10,10 0 0 0 10,20 V100 A10,10 0 0 0 20,110 H85"
          fill="none"
          stroke={resolvedStroke}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M100,35 V20 A10,10 0 0 0 90,10 H85"
          fill="none"
          stroke={resolvedStroke}
          strokeWidth="6"
          strokeLinecap="round"
        />

        {/* Magnifying Glass Handle */}
        <rect
          x="95"
          y="100"
          width="14"
          height="30"
          rx="6"
          ry="6"
          fill={navyColor}
          transform="rotate(-45 95 100)"
        />

        {/* Magnifying Glass thin handle */}
        <rect
          x="98"
          y="80"
          width="7"
          height="30"
          rx="6"
          ry="6"
          fill={navyColor}
          transform="rotate(-45 95 100)"
        />

        {/* Magnifying Glass Circle */}
        <circle cx="60" cy="60" r="38" fill={navyColor} />

        {/* Union Jack inside Circle */}
        <clipPath id="logoCircleClip">
          <circle cx="60" cy="60" r="29" />
        </clipPath>

        <g clipPath="url(#logoCircleClip)">
          {/* UK Flag Background (Blue) */}
          <rect x="18" y="18" width="84" height="84" fill="#012169" />
          {/* White Saltire */}
          <path
            d="M18,18 L102,102 M102,18 L18,102"
            stroke="white"
            strokeWidth="12"
          />
          {/* Red Saltire */}
          <path
            d="M18,18 L102,102 M102,18 L18,102"
            stroke="#C8102E"
            strokeWidth="4"
          />
          {/* White Cross */}
          <path d="M60,18 V102 M18,60 H102" stroke="white" strokeWidth="20" />
          {/* Red Cross */}
          <path d="M60,18 V102 M18,60 H102" stroke="#C8102E" strokeWidth="12" />
        </g>
      </g>

      {/* Logo Text */}
      <text
        x="145"
        y="95"
        fontSize="82"
        fill={navyColor}
        fontFamily="Geist"
        fontWeight="600"
      >
        Sponsor
      </text>
      <text
        x="460"
        y="95"
        fontSize="82"
        fill={redColor}
        fontFamily="Geist"
        fontWeight="600"
      >
        Search
      </text>

      {/* .co.uk domain */}
      <text
        x="735"
        y="130"
        fontSize="40"
        textAnchor="end"
        fill={resolvedDomain}
        fontFamily="Geist"
        fontWeight="600"
      >
        .co.uk
      </text>
    </svg>
  );
}
