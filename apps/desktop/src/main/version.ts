/**
 * Version comparison for the Linux update feed. Dependency-free (no semver) and
 * electron-free so it stays unit-testable. The feed always carries clean x.y.z
 * versions, but this tolerates a leading `v`, +build metadata, and prereleases
 * so a stray format never silently suppresses (or falsely triggers) an update.
 */

interface ParsedVersion {
  core: number[]; // [major, minor, patch], each coerced to a finite number
  isPrerelease: boolean;
}

/** Leniently parses a version: strips a leading v/V and +build metadata, splits the prerelease at the first '-', and coerces each core segment to a number (non-numeric or missing -> 0). */
function parse(version: string): ParsedVersion {
  const cleaned = version.trim().replace(/^v/i, '').replace(/\+.*$/, '');
  const dash = cleaned.indexOf('-');
  const coreStr = dash === -1 ? cleaned : cleaned.slice(0, dash);
  const nums = coreStr.split('.').map((s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  });
  return {
    core: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
    isPrerelease: dash !== -1,
  };
}

/** True when `feed` is a newer version than `current`: compares the numeric x.y.z core, then ranks a full release above a prerelease of the same core (0.3.0 > 0.3.0-rc.1). Equal or uncomparable -> false, so a malformed feed never falsely triggers an update. (Two prereleases of one core compare equal — we never ship prereleases.) */
export function isNewer(feed: string, current: string): boolean {
  const f = parse(feed);
  const c = parse(current);
  for (let i = 0; i < 3; i++) {
    const a = f.core[i] ?? 0;
    const b = c.core[i] ?? 0;
    if (a !== b) return a > b;
  }
  if (f.isPrerelease !== c.isPrerelease) return c.isPrerelease;
  return false;
}
