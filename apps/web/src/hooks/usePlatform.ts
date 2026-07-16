export type Platform = 'mac' | 'windows' | 'linux' | 'chromeos' | 'unknown';

/** Downloadable CPU architectures we detect a visitor as (mac ships Universal). */
export type Arch = 'x64' | 'arm64';

/**
 * Best-effort CPU arch from a user-agent string. Reliable for Firefox/Safari and for
 * every x64 client, but Chrome's reduced UA freezes desktop Linux to `x86_64` — so an
 * ARM64 Chrome reads as x64 here and must be corrected via Client Hints
 * (`navigator.userAgentData.getHighEntropyValues`; see download.tsx). mac UAs always
 * say "Intel" regardless of silicon, which is why mac uses a Universal build. Returns
 * null when no arch token is present.
 */
export function parseArch(ua: string): Arch | null {
  const lower = ua.toLowerCase();
  if (/aarch64|arm64/.test(lower)) return 'arm64';
  if (/x86_64|x86-64|amd64|x64|win64|wow64/.test(lower)) return 'x64';
  return null;
}

/** The non-standard `navigator.userAgentData` (Client Hints) surface we read — no lib-dom type yet. */
export type NavigatorUAData = {
  mobile?: boolean;
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ architecture?: string; bitness?: string }>;
};

/** `navigator.userAgentData` (undefined off Chromium) without re-casting at each call site. Client-only. */
export function getUAData(): NavigatorUAData | undefined {
  return (navigator as Navigator & { userAgentData?: NavigatorUAData })
    .userAgentData;
}

/**
 * Derive `{ platform, isMobile }` from a user-agent string via case-insensitive
 * substring checks. Unknown UAs fall back to `{ platform: 'unknown' }`.
 */
export function parsePlatform(ua: string): {
  platform: Platform;
  isMobile: boolean;
} {
  const lower = ua.toLowerCase();
  const isMobile = /iphone|ipad|ipod|android|mobile/.test(lower);
  let platform: Platform = 'unknown';
  if (lower.includes('cros')) platform = 'chromeos';
  else if (lower.includes('mac')) platform = 'mac';
  else if (lower.includes('win')) platform = 'windows';
  else if (lower.includes('linux')) platform = 'linux';
  return { platform, isMobile };
}

/**
 * Return the platform-appropriate keyboard-shortcut label for the search
 * input — `⌘K` on macOS, `Ctrl+K` everywhere else.
 */
export function getShortcutLabel(platform: Platform): string {
  return platform === 'mac' ? '⌘K' : 'Ctrl+K';
}
