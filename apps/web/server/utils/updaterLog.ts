/**
 * Structured runtime-log lines for the desktop updater feed (`/downloads/latest/*`).
 *
 * `desktop_downloads` deliberately records only user-initiated installer
 * downloads, so auto-update activity has no row anywhere. These lines give it a
 * home in the runtime logs, keyed so `[updater] check`, `[updater] download` and
 * `client=updater` are each a single-substring filter. They are ordinary
 * `console.log` output with whatever retention the plan gives runtime logs —
 * the `incomingRequest` observability dataset remains the aggregate source.
 *
 * Unlike the `desktop_downloads` write on the same route, no field here is
 * cross-checked against `desktop_release_assets`: `platform`, `version` and
 * `file` say what was ASKED for, and `client` keys on a User-Agent anyone can
 * send. A line is a record of a request, not proof of an install. Only
 * recognised feed artifacts are logged at all, so an arbitrary path under
 * `latest/` cannot mint lines at request rate.
 *
 * Everything here is pure so the shipping code is the tested code; the route
 * only reads headers and calls `updaterLogLine`.
 */
import {
  DESKTOP_FORMATS,
  DESKTOP_PLATFORMS,
  type DesktopPlatform,
} from '#/api/desktopPlatforms';

/** The header apps/desktop sends with its installed version, so a line can carry `from=`. Mirrored in apps/desktop/src/main/feed.ts — both copies are locked by tests. */
export const APP_VERSION_HEADER = 'x-app-version';

/** What the requester asked the feed for. */
export type UpdaterEvent = 'check' | 'download' | 'blockmap';

/** Who asked: electron-updater, the app's own Linux feed check, or anything else (crawlers reach this path too). */
export type UpdaterClient = 'updater' | 'app' | 'other';

/** electron-updater's fixed User-Agent — the discriminator between real update traffic and everything else on this path. Spoofable, so `client=updater` is a claim, not proof. */
const UPDATER_UA = 'electron-builder';

/** The app's own UA, built as `SponsorSearchDesktop/${version}` in apps/desktop/src/main/updater.ts — keep the two in sync. */
const APP_UA = /^SponsorSearchDesktop\/(\S+)$/;

/** Channel files, per electron-updater's `Provider.getChannelFilePrefix()`: Windows is bare, macOS is always `-mac`, and Linux appends its arch for anything that is not x64 (so arm64 installs poll `latest-linux-arm64.yml`). */
const CHANNEL = /^latest(-mac|-linux(?:-[a-z0-9_]+)?)?\.yml$/;

/** Installer/blockmap names are `SponsorSearch-<platform>-<version>-<arch>[-scope].<ext>` (apps/desktop/electron-builder.yml `artifactName`, whose prefix is its `productName` — rename that and this stops matching). A prerelease tag is dropped, never mistaken for the arch. */
const ARTIFACT = new RegExp(
  `^SponsorSearch-(${DESKTOP_PLATFORMS.join('|')})-(\\d+\\.\\d+\\.\\d+)-`,
);

/** The prefix alone would accept `SponsorSearch-win-0.4.0-anything`, so a real extension is required too. `zip` is the mac updater package, which is not a page installer and so is absent from DESKTOP_FORMATS; a new *target* format has to be added there. The arch is deliberately NOT pinned — electron-builder's arch tokens drift (arm64/x64/universal/amd64/x86_64/aarch64) and pinning them would silently stop logging real downloads. */
const FEED_EXT = new RegExp(
  `\\.(?:${[...DESKTOP_FORMATS, 'zip'].join('|')})(?:\\.blockmap)?$`,
  'i',
);

/** A plausible feed filename. Validates rather than strips: stripping would normalise a crafted path onto a real channel name and log a check that never happened, and the charset already excludes every log-injection separator. */
const FEED_FILE = /^[\w.-]{1,100}$/;

/** A plausible version string, from a header anyone can set. */
const FEED_VERSION = /^[\w.-]{1,32}$/;

/** A parsed feed hit. */
export interface UpdaterFeedRequest {
  event: UpdaterEvent;
  platform: DesktopPlatform;
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

/** The platform a channel file belongs to, from its filename suffix. */
function channelPlatform(suffix: string | undefined): DesktopPlatform {
  if (!suffix) return 'win';
  return suffix.startsWith('-mac') ? 'mac' : 'linux';
}

/** Renders present fields as `key=value`, dropping absent ones. */
function fields(pairs: Array<[string, string | null]>): string {
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

/** Vercel's client-country header, normalised. Exported so the route's `desktop_downloads` write and this log line can never disagree on what counts as a country. */
export function normalizeCountry(value: string | null): string | null {
  return value && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null;
}

/** Parses the `/downloads/:path` route param into a feed request, or null when it is not a recognised `latest/` feed artifact. */
export function parseFeedRequest(path: string): UpdaterFeedRequest | null {
  const segments = path.split('/');
  if (segments.length !== 2 || segments[0] !== 'latest') return null;

  const file = segments[1];
  if (!file || !FEED_FILE.test(file)) return null;

  const channel = CHANNEL.exec(file);
  if (channel) {
    return {
      event: 'check',
      platform: channelPlatform(channel[1]),
      version: null,
      file,
    };
  }

  // Anything else under latest/ is a probe for a file that does not exist
  // (crawlers reach this path constantly); logging it would mint `download`
  // lines at request rate for names that were never released.
  const artifact = ARTIFACT.exec(file);
  if (!artifact || !FEED_EXT.test(file)) return null;

  return {
    event: file.endsWith('.blockmap') ? 'blockmap' : 'download',
    platform: artifact[1] as DesktopPlatform,
    version: artifact[2] ?? null,
    file,
  };
}

/** Classifies the requester from its User-Agent. */
export function classifyClient(userAgent: string | null): UpdaterClient {
  if (userAgent === UPDATER_UA) return 'updater';
  if (userAgent && APP_UA.test(userAgent)) return 'app';
  return 'other';
}

/** The version the requester is updating FROM: the header when it carries one, else the app UA's own token. Absent on shells that predate the header. */
export function installedVersion(
  appVersion: string | null,
  userAgent: string | null,
): string | null {
  // Validate each source before falling through, or a header sent empty (which
  // `Headers.get` returns as '') wins the `??` and suppresses the UA fallback.
  return (
    validVersion(appVersion) ?? validVersion(APP_UA.exec(userAgent ?? '')?.[1])
  );
}

/** A version string, or null when it is absent or not plausibly one. */
function validVersion(value: string | null | undefined): string | null {
  return value && FEED_VERSION.test(value) ? value : null;
}

/** Builds the `[updater] …` line for a feed hit, or null when the path is not a recognised updater-feed artifact. */
export function updaterLogLine(input: UpdaterLogInput): string | null {
  const request = parseFeedRequest(input.path);
  if (!request) return null;

  const pairs: Array<[string, string | null]> = [
    ['platform', request.platform],
    ['version', request.version],
    ['client', classifyClient(input.userAgent)],
    ['from', installedVersion(input.appVersion, input.userAgent)],
    ['country', normalizeCountry(input.country)],
  ];
  // A ranged GET is a differential chunk, so `partial=0` counts the machines
  // actually pulling a full new installer.
  if (request.event === 'download') {
    pairs.push(['partial', input.range ? '1' : '0']);
  }
  if (request.event !== 'check') pairs.push(['file', request.file]);

  return `[updater] ${request.event} ${fields(pairs)}`;
}
