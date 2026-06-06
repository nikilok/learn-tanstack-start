/**
 * LinkedIn "in" mark used as the visual label for outbound links to LinkedIn.
 * Brand blue square with a white glyph (the white stays visible on a blue hover);
 * sized via `className`.
 */
export default function LinkedInLogo({ className }: { className?: string }) {
  return (
    <svg
      focusable="false"
      role="img"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      aria-label="LinkedIn"
      className={className}
    >
      <title>LinkedIn</title>
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <path
        fill="#fff"
        d="M7.12 20.45H3.56V9h3.56v11.45zM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14zM20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29z"
      />
    </svg>
  );
}
