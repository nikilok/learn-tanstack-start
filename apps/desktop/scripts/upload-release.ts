/**
 * Uploads this platform's electron-builder artifacts to Vercel Blob and records
 * the release in the DB via POST /api/releases. Run once per matrix platform in
 * the desktop release workflow, after `electron-builder --publish never`.
 *
 * Page installers (dmg/exe/deb/rpm/AppImage) go to a permanent per-asset GUID
 * path: downloads/<platform>/<guid>/<version>/<file>. The electron-updater feed
 * (latest*.yml, .blockmap, the universal zip, the user nsis, the AppImage) is
 * mirrored to the overwritten downloads/latest/ path.
 *
 * Env: RELEASE_PLATFORM, RELEASE_VERSION, BLOB_READ_WRITE_TOKEN,
 *      DESKTOP_RELEASE_SECRET, SITE_URL (optional; default the prod domain).
 */
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { put } from '@vercel/blob';

/** Reads a required env var or exits non-zero. */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[upload-release] missing env ${name}`);
    process.exit(1);
  }
  return v;
}

const PLATFORM = requireEnv('RELEASE_PLATFORM');
const VERSION = requireEnv('RELEASE_VERSION');
const TOKEN = requireEnv('BLOB_READ_WRITE_TOKEN');
const SECRET = requireEnv('DESKTOP_RELEASE_SECRET');
const SITE = process.env.SITE_URL ?? 'https://sponsorsearch.co.uk';
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

// Mirrors DESKTOP_FORMATS in apps/web/src/api/desktopPlatforms.ts (a cross-package
// import from this standalone CI script isn't worth the coupling) — keep in sync.
const FORMAT_BY_EXT: Record<string, string> = {
  dmg: 'dmg',
  exe: 'exe',
  deb: 'deb',
  rpm: 'rpm',
  appimage: 'appimage',
};

type Asset = {
  platform: string;
  arch: string;
  format: string;
  installScope: string;
  guid: string;
  fileName: string;
  url: string;
  size: number;
};

/** {arch, format, installScope} parsed from an artifact filename. */
function parse(file: string): {
  arch: string;
  format: string | null;
  installScope: string;
} {
  const lower = file.toLowerCase();
  const ext = lower.split('.').pop() ?? '';
  const format = FORMAT_BY_EXT[ext] ?? null;
  const arch = /arm64|aarch64/.test(lower)
    ? 'arm64'
    : /universal/.test(lower)
      ? 'universal'
      : 'x64';
  const installScope = /-system/.test(lower)
    ? 'system'
    : /-user/.test(lower)
      ? 'user'
      : '';
  return { arch, format, installScope };
}

/** True for artifacts electron-updater needs in the stable latest/ feed. */
function isFeedArtifact(file: string): boolean {
  const l = file.toLowerCase();
  // Only the updater's own channel files — NOT every .yml: electron-builder drops
  // builder-debug.yml (runner paths, build config) into dist/, which must never
  // reach the public feed.
  if (l.endsWith('.yml')) return /^latest.*\.yml$/.test(l);
  if (l.endsWith('.blockmap')) return true;
  if (PLATFORM === 'mac' && l.endsWith('.zip')) return true;
  if (PLATFORM === 'win' && l.endsWith('-user.exe')) return true;
  if (PLATFORM === 'linux' && l.endsWith('.appimage')) return true;
  return false;
}

async function main() {
  const files = await readdir(DIST);
  const assets: Asset[] = [];

  for (const file of files) {
    const { arch, format, installScope } = parse(file);
    if (!format) continue; // not a page installer
    const guid = randomBytes(8).toString('hex');
    const body = await readFile(join(DIST, file));
    const path = `downloads/${PLATFORM}/${guid}/${VERSION}/${file}`;
    await put(path, body, {
      access: 'public',
      addRandomSuffix: false,
      token: TOKEN,
    });
    assets.push({
      platform: PLATFORM,
      arch,
      format,
      installScope,
      guid,
      fileName: file,
      url: `${SITE}/${path}`,
      size: body.length,
    });
    console.log(
      `[upload-release] versioned: ${file} (${arch} ${format} ${installScope || '-'})`,
    );
  }

  // Bail BEFORE mirroring the update feed — a build with no recognized installer
  // (naming drift / partial failure) must not overwrite the live downloads/latest/
  // feed with a broken/mismatched one.
  if (assets.length === 0) {
    console.error('[upload-release] no page installers found in dist/');
    process.exit(1);
  }

  for (const file of files) {
    if (!isFeedArtifact(file)) continue;
    const body = await readFile(join(DIST, file));
    await put(`downloads/latest/${file}`, body, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      token: TOKEN,
    });
    console.log(`[upload-release] feed: ${file}`);
  }

  const res = await fetch(`${SITE}/api/releases`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-desktop-release-secret': SECRET,
    },
    body: JSON.stringify({ version: VERSION, assets }),
  });
  // withSecret answers a neutral 202 to a bad secret (deliberately no auth signal),
  // so res.ok is NOT success — only an authenticated 200 { ok, releaseId } is.
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    releaseId?: number;
  } | null;
  if (res.status !== 200 || !body?.ok) {
    const hint =
      res.status === 202
        ? ' (neutral auth response — DESKTOP_RELEASE_SECRET likely mismatched between GitHub and Vercel)'
        : '';
    console.error(
      `[upload-release] record failed: ${res.status} ${JSON.stringify(body)}${hint}`,
    );
    process.exit(1);
  }
  console.log(
    `[upload-release] recorded ${assets.length} ${PLATFORM} asset(s) for ${VERSION} (release ${body.releaseId})`,
  );
}

main().catch((err) => {
  console.error('[upload-release] failed', err);
  process.exit(1);
});
