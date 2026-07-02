import { DESKTOP_PLATFORMS, type DesktopFormat } from '../api/desktopPlatforms';
import type { DesktopAsset, DesktopPlatform } from '../api/releases';

export const PLATFORM_ORDER: readonly DesktopPlatform[] = DESKTOP_PLATFORMS;

export const PLATFORM_LABEL: Record<DesktopPlatform, string> = {
  mac: 'macOS',
  win: 'Windows',
  linux: 'Linux',
};

/** Pretty arch token for a label. */
function archLabel(arch: string): string {
  if (arch === 'universal') return 'Universal';
  if (arch === 'arm64') return 'ARM64';
  return 'x64';
}

/** Human variant label mirroring cursor.com/download naming. */
export function assetLabel(a: DesktopAsset): string {
  if (a.platform === 'mac') {
    return a.arch === 'universal'
      ? 'Mac Universal'
      : `Mac (${archLabel(a.arch)})`;
  }
  if (a.platform === 'win') {
    const scope = a.installScope === 'system' ? 'System' : 'User';
    return `Windows (${archLabel(a.arch)}) (${scope})`;
  }
  const fmt = a.format.toLowerCase();
  const fmtLabel =
    fmt === 'appimage' ? 'AppImage' : fmt === 'deb' ? '.deb' : '.rpm';
  return `Linux ${fmtLabel} (${archLabel(a.arch)})`;
}

// Typed on DesktopFormat so adding a format to DESKTOP_FORMATS forces a rank here.
const FORMAT_RANK: Record<DesktopFormat, number> = {
  dmg: 0,
  exe: 0,
  deb: 0,
  rpm: 1,
  appimage: 2,
};
// arm64 leads on mac/linux (Apple Silicon dominant, matches Cursor); Windows
// leads with x64 (ARM is niche there).
const ARCH_RANK: Record<string, number> = { arm64: 0, x64: 1, universal: 2 };
const WIN_ARCH_RANK: Record<string, number> = { x64: 0, arm64: 1 };
const SCOPE_RANK: Record<string, number> = { system: 0, user: 1, '': 0 };

/** Composite display-order key (format → arch → scope). */
function orderKey(a: DesktopAsset, archRank: Record<string, number>): number {
  return (
    (FORMAT_RANK[a.format.toLowerCase() as DesktopFormat] ?? 9) * 100 +
    (archRank[a.arch] ?? 9) * 10 +
    (SCOPE_RANK[a.installScope] ?? 9)
  );
}

/** Stable Cursor-like display order within a platform column. */
export function sortAssets(assets: DesktopAsset[]): DesktopAsset[] {
  const archRank = assets[0]?.platform === 'win' ? WIN_ARCH_RANK : ARCH_RANK;
  return [...assets].sort(
    (x, y) => orderKey(x, archRank) - orderKey(y, archRank),
  );
}

const RECOMMENDED: Record<DesktopPlatform, (a: DesktopAsset) => boolean> = {
  mac: (a) => a.arch === 'universal',
  win: (a) => a.arch === 'x64' && a.installScope !== 'system',
  linux: (a) => a.format.toLowerCase() === 'appimage' && a.arch === 'x64',
};

/** The single variant a "Download for <OS>" hero button should point to. */
export function recommendedAsset(
  platform: DesktopPlatform,
  assets: DesktopAsset[],
): DesktopAsset | null {
  return assets.find(RECOMMENDED[platform]) ?? assets[0] ?? null;
}

/** Small monochrome OS glyph for a platform-column header. */
export function OsIcon({
  platform,
  className,
}: {
  platform: DesktopPlatform;
  className?: string;
}) {
  if (platform === 'mac') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        className={className}
        aria-hidden="true"
      >
        <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 8.42 7.34c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.9 4.05zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </svg>
    );
  }
  if (platform === 'win') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        className={className}
        aria-hidden="true"
      >
        <path d="M3 5.6 10 4.6v6.9H3zM11 4.45 21 3v8.5H11zM3 12.5h7v6.9l-7-1zM11 12.5h10V21l-10-1.45z" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2c-1.9 0-3.1 1.6-3.1 3.5 0 .7.1 1.3.3 1.8C8 8.6 6.6 10.9 6.6 13.4c0 1-.5 1.8-1 2.5-.4.5-.8 1.1-.8 1.8 0 .6.5 1 1.1 1 .7 0 1.4-.3 1.9-.7.5 1.4 2 2.3 4.2 2.3s3.7-.9 4.2-2.3c.5.4 1.2.7 1.9.7.6 0 1.1-.4 1.1-1 0-.7-.4-1.3-.8-1.8-.5-.7-1-1.5-1-2.5 0-2.5-1.4-4.8-2.6-6.1.2-.5.3-1.1.3-1.8C15.1 3.6 13.9 2 12 2Zm-1.4 4.1c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9Zm2.8 0c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9Z" />
    </svg>
  );
}
