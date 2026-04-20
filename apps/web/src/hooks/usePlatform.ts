export type Platform = 'mac' | 'windows' | 'linux' | 'chromeos' | 'unknown';

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
