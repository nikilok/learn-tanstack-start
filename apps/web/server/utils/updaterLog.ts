/**
 * Structured runtime-log lines for the desktop updater feed (`/downloads/latest/*`).
 *
 * `desktop_downloads` deliberately records only user-initiated installer
 * downloads, so auto-update activity had no durable home — it lived solely in
 * the 7-day observability window. These lines put it in Vercel's runtime logs
 * alongside every other API log, keyed so `[updater] check`, `[updater] download`
 * and `client=updater` are each a single-substring filter.
 *
 * Everything here is pure so the shipping code is the tested code; the route
 * only reads headers and calls `updaterLogLine`.
 */
import {
  DESKTOP_PLATFORMS,
  type DesktopPlatform,
} from '#/api/desktopPlatforms';

/** The header apps/desktop sends with its installed version, so a check line can carry `from=`. Mirrored in apps/desktop/src/main/updater.ts — keep the two in sync. */
export const APP_VERSION_HEADER = 'x-app-version';

/** What the requester asked the feed for. */
export type UpdaterEvent = 'check' | 'download' | 'blockmap';

/** Who asked: electron-updater, the app's own Linux feed check, or anything else (crawlers reach this path too). */
export type UpdaterClient = 'updater' | 'app' | 'other';

/** electron-updater's fixed User-Agent — the discriminator between real update traffic and everything else on this path. */
const UPDATER_UA = 'electron-builder';

/** The app's own UA, sent by the Linux deb/rpm manual feed check. */
const APP_UA = /^SponsorSearchDesktop\/(\S+)$/;

/** Channel file -> the platform whose updater polls it. */
const CHECK_PLATFORM: Record<string, DesktopPlatform> = {
  'latest.yml': 'win',
  'latest-mac.yml': 'mac',
  'latest-linux.yml': 'linux',
};

/** Artifacts are `SponsorSearch-<platform>-<version>-<arch>[-scope].<ext>` (electron-builder.yml artifactName). A prerelease tag is dropped, never mistaken for the arch. */
const ARTIFACT = new RegExp(
  `^SponsorSearch-(${DESKTOP_PLATFORMS.join('|')})-(\\d+\\.\\d+\\.\\d+)-`,
);

/** A parsed feed hit. */
export interface UpdaterFeedRequest {
  event: UpdaterEvent;
  platform: DesktopPlatform | null;
  version: string | null;
  file: string;
}

/** Inputs the route pulls off the request. */
export interface UpdaterLogInput {
  path: string;
  userAgent: string | null;
  appVersion: string | null;
  country: string | null;
  range: string | null;
}

/** Strips anything outside the artifact charset and clamps length, so a crafted URL or header cannot inject fields or newlines into a log line. */
function safe(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/[^\w.-]/g, '').slice(0, 64) || null;
}

/** Renders present fields as `key=value`, dropping absent ones. */
function fields(pairs: Array<[string, string | null]>): string {
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

/** Parses the `/downloads/:path` route param into a feed request, or null when it is not a `latest/` feed hit. */
export function parseFeedRequest(path: string): UpdaterFeedRequest | null {
  const segments = path.split('/');
  if (segments.length !== 2 || segments[0] !== 'latest') return null;

  const file = safe(segments[1]);
  if (!file) return null;

  const checkPlatform = CHECK_PLATFORM[file];
  if (checkPlatform) {
    return { event: 'check', platform: checkPlatform, version: null, file };
  }

  const match = ARTIFACT.exec(file);
  return {
    event: file.endsWith('.blockmap') ? 'blockmap' : 'download',
    platform: (match?.[1] as DesktopPlatform) ?? null,
    version: match?.[2] ?? null,
    file,
  };
}

/** Classifies the requester from its User-Agent. */
export function classifyClient(userAgent: string | null): UpdaterClient {
  if (userAgent === UPDATER_UA) return 'updater';
  if (userAgent && APP_UA.test(userAgent)) return 'app';
  return 'other';
}

/** The version the requester is updating FROM: the header when sent, else the app UA's own token. Absent on shells that predate the header. */
export function installedVersion(
  appVersion: string | null,
  userAgent: string | null,
): string | null {
  return safe(appVersion ?? APP_UA.exec(userAgent ?? '')?.[1]);
}

/** Builds the `[updater] …` line for a feed hit, or null when the path is not the updater feed. */
export function updaterLogLine(input: UpdaterLogInput): string | null {
  const request = parseFeedRequest(input.path);
  if (!request) return null;

  const country = /^[A-Za-z]{2}$/.test(input.country ?? '')
    ? input.country!.toUpperCase()
    : null;

  const pairs: Array<[string, string | null]> = [
    ['platform', request.platform],
    ['version', request.version],
    ['client', classifyClient(input.userAgent)],
    ['from', installedVersion(input.appVersion, input.userAgent)],
    ['country', country],
  ];
  // A ranged GET is a differential chunk, so `partial=0` counts the machines
  // actually pulling a full new installer.
  if (request.event === 'download') {
    pairs.push(['partial', input.range ? '1' : '0']);
  }
  if (request.event !== 'check') pairs.push(['file', request.file]);

  return `[updater] ${request.event} ${fields(pairs)}`;
}
