/**
 * The supported desktop platforms — single source of truth for the
 * `DesktopPlatform` type and the runtime list (validation Sets, display order).
 * Dependency-free so server routes can import it via `#/api/desktopPlatforms`
 * without pulling in the server-fn / db machinery of `api/releases`.
 */
export const DESKTOP_PLATFORMS = ['mac', 'win', 'linux'] as const;

export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];
