/**
 * Google Chrome brand logo. Full-colour by design (the PWA install path is
 * Chromium-only) so it reads as "Chrome" and stays distinct from the monochrome
 * download/control glyphs. `aria-hidden` — the button supplies the label.
 */
export default function ChromeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* white backing → the thin spokes between the colours read white */}
      <circle cx="24" cy="24" r="22" fill="#fff" />
      <path fill="#EA4335" d="M24 24L5.65 11.86A22 22 0 0 1 42.35 11.86Z" />
      <path fill="#34A853" d="M24 24L22.66 45.96A22 22 0 0 1 4.31 14.18Z" />
      <path fill="#FBBC05" d="M24 24L43.69 14.18A22 22 0 0 1 25.34 45.96Z" />
      <circle cx="24" cy="24" r="10.5" fill="#fff" />
      <circle cx="24" cy="24" r="9" fill="#4285F4" />
    </svg>
  );
}
