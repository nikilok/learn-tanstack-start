export type Platform = 'mac' | 'windows' | 'linux' | 'chromeos' | 'unknown';

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

export function getShortcutLabel(platform: Platform): string {
  switch (platform) {
    case 'mac':
      return '⌘K';
    case 'chromeos':
    case 'linux':
      return 'Ctrl+F';
    case 'windows':
      return 'Ctrl+K';
    default:
      return '';
  }
}
