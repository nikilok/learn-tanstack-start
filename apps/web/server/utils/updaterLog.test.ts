import { describe, expect, test } from 'bun:test';

import {
  APP_VERSION_HEADER,
  classifyClient,
  installedVersion,
  normalizeCountry,
  parseFeedRequest,
  updaterLogLine,
} from './updaterLog';

const base = {
  userAgent: 'electron-builder',
  appVersion: null,
  country: 'GB',
  range: null,
};

describe('APP_VERSION_HEADER', () => {
  // Mirrored in apps/desktop/src/main/feed.ts, which asserts the same literal.
  // The workspaces never import each other, so only the paired tests catch a
  // rename — and a silent rename drops `from=` from every line until the next
  // desktop release.
  test('matches the header apps/desktop sends', () => {
    expect(APP_VERSION_HEADER).toBe('x-app-version');
  });
});

describe('parseFeedRequest', () => {
  test('ignores user-initiated installer paths (they are logged to the DB instead)', () => {
    expect(
      parseFeedRequest(
        'mac/20260724162252-86a696c0/0.3.0/SponsorSearch-mac-0.3.0-universal.dmg',
      ),
    ).toBeNull();
  });

  test('ignores a bare or over-deep latest path', () => {
    expect(parseFeedRequest('latest')).toBeNull();
    expect(parseFeedRequest('latest/')).toBeNull();
    expect(parseFeedRequest('latest/nested/file.yml')).toBeNull();
  });

  test('maps each channel file to the platform that polls it', () => {
    expect(parseFeedRequest('latest/latest.yml')).toMatchObject({
      event: 'check',
      platform: 'win',
    });
    expect(parseFeedRequest('latest/latest-mac.yml')).toMatchObject({
      event: 'check',
      platform: 'mac',
    });
    expect(parseFeedRequest('latest/latest-linux.yml')).toMatchObject({
      event: 'check',
      platform: 'linux',
    });
  });

  test('recognises the arch-suffixed Linux channel file as a check', () => {
    // electron-updater's Provider.getChannelFilePrefix() appends the arch on
    // Linux for anything that is not x64, so arm64 installs poll this file.
    // Missing it counted every arm64 poll as a full installer download.
    expect(parseFeedRequest('latest/latest-linux-arm64.yml')).toMatchObject({
      event: 'check',
      platform: 'linux',
    });
    expect(parseFeedRequest('latest/latest-linux-armv7l.yml')).toMatchObject({
      event: 'check',
      platform: 'linux',
    });
  });

  test('reads platform and version off an installer name', () => {
    expect(
      parseFeedRequest('latest/SponsorSearch-win-0.4.0-x64-user.exe'),
    ).toMatchObject({ event: 'download', platform: 'win', version: '0.4.0' });
  });

  test('does not mistake the arch for a prerelease tag', () => {
    expect(
      parseFeedRequest('latest/SponsorSearch-mac-0.4.0-arm64.zip'),
    ).toMatchObject({ version: '0.4.0' });
    expect(
      parseFeedRequest('latest/SponsorSearch-mac-0.4.0-beta.1-arm64.zip'),
    ).toMatchObject({ version: '0.4.0' });
  });

  test('separates the differential blockmap from the installer itself', () => {
    expect(
      parseFeedRequest('latest/SponsorSearch-mac-0.4.0-arm64.zip.blockmap'),
    ).toMatchObject({ event: 'blockmap', version: '0.4.0' });
  });

  test('keeps the .blockmap suffix on a name long enough to have been clamped', () => {
    // The suffix is the only thing separating a differential chunk from a full
    // pull, so it must be read off the whole name, never a truncated one.
    const long = `latest/SponsorSearch-win-0.4.0-${'x'.repeat(50)}.exe.blockmap`;
    expect(parseFeedRequest(long)).toMatchObject({ event: 'blockmap' });
  });

  test('rejects a filename carrying anything outside the artifact charset', () => {
    // Rejecting, not stripping: stripping rewrote a path that 404s at Blob into
    // a real channel name and logged a check that never happened.
    expect(parseFeedRequest("latest/latest'-mac.yml")).toBeNull();
    expect(parseFeedRequest('latest/evil client=updater\nFAKE')).toBeNull();
    expect(parseFeedRequest(`latest/${'x'.repeat(200)}.yml`)).toBeNull();
  });

  test('rejects prototype keys rather than resolving them off Object.prototype', () => {
    // A bare object-literal lookup returned Object.prototype.toString here,
    // which interpolated a multi-line function body into the log line.
    for (const key of [
      'toString',
      'valueOf',
      'constructor',
      'hasOwnProperty',
      '__proto__',
      '__defineGetter__',
    ]) {
      expect(parseFeedRequest(`latest/${key}`)).toBeNull();
    }
  });

  test('rejects an unrecognised file rather than calling it a download', () => {
    expect(parseFeedRequest('latest/robots.txt')).toBeNull();
    expect(parseFeedRequest('latest/index.html')).toBeNull();
  });
});

describe('classifyClient', () => {
  test('electron-updater is the only UA that counts as update traffic', () => {
    expect(classifyClient('electron-builder')).toBe('updater');
    expect(classifyClient('SponsorSearchDesktop/0.3.0')).toBe('app');
    expect(classifyClient('Mozilla/5.0 (compatible; DotBot/1.2)')).toBe(
      'other',
    );
    expect(classifyClient(null)).toBe('other');
  });
});

describe('installedVersion', () => {
  test('prefers the header, falls back to the app UA, else absent', () => {
    expect(installedVersion('0.4.0', 'electron-builder')).toBe('0.4.0');
    expect(installedVersion(null, 'SponsorSearchDesktop/0.3.0')).toBe('0.3.0');
    expect(installedVersion(null, 'electron-builder')).toBeNull();
  });

  test('an empty or junk header falls through to the UA instead of winning', () => {
    // Headers.get returns '' for a header sent with no value, and `??` only
    // falls through on null — so validating before the fallback is what keeps
    // `from=` alive for the Linux manual check, the one client sending both.
    expect(installedVersion('', 'SponsorSearchDesktop/0.3.0')).toBe('0.3.0');
    expect(installedVersion('a b=c', 'SponsorSearchDesktop/0.3.0')).toBe(
      '0.3.0',
    );
  });
});

describe('normalizeCountry', () => {
  test('accepts a two-letter code and rejects anything else', () => {
    expect(normalizeCountry('gb')).toBe('GB');
    expect(normalizeCountry('GBR')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });
});

describe('updaterLogLine', () => {
  test('returns null for a user download so the DB stays the only record', () => {
    expect(
      updaterLogLine({
        ...base,
        path: 'win/abc123/0.3.0/SponsorSearch-win-0.3.0-x64-user.exe',
      }),
    ).toBeNull();
  });

  test('a mac poll from an updater that sends its version', () => {
    expect(
      updaterLogLine({
        ...base,
        path: 'latest/latest-mac.yml',
        appVersion: '0.3.0',
      }),
    ).toBe('[updater] check platform=mac client=updater from=0.3.0 country=GB');
  });

  test('a full installer pull is partial=0, a differential chunk partial=1', () => {
    expect(
      updaterLogLine({
        ...base,
        path: 'latest/SponsorSearch-win-0.4.0-x64-user.exe',
      }),
    ).toBe(
      '[updater] download platform=win version=0.4.0 client=updater country=GB partial=0 file=SponsorSearch-win-0.4.0-x64-user.exe',
    );
    expect(
      updaterLogLine({
        ...base,
        path: 'latest/SponsorSearch-win-0.4.0-x64-user.exe',
        range: 'bytes=0-16383',
      }),
    ).toContain('partial=1');
  });

  test('a crawler on the feed is logged as client=other, not update traffic', () => {
    expect(
      updaterLogLine({
        ...base,
        path: 'latest/latest-linux.yml',
        userAgent: 'Mozilla/5.0 (compatible; DotBot/1.2)',
        country: null,
      }),
    ).toBe('[updater] check platform=linux client=other');
  });

  test('an unparseable country is dropped rather than logged raw', () => {
    expect(
      updaterLogLine({ ...base, path: 'latest/latest.yml', country: 'GBR' }),
    ).not.toContain('country=');
  });

  test('no line can contain a newline or a forged field', () => {
    // The charset gate runs before classification, so every path that could
    // carry a separator is rejected outright rather than sanitised into a line.
    for (const path of [
      'latest/evil client=updater\nFAKE',
      'latest/toString',
      "latest/latest'-mac.yml",
      'latest/robots.txt',
    ]) {
      expect(updaterLogLine({ ...base, path })).toBeNull();
    }
    const line = updaterLogLine({
      ...base,
      path: 'latest/latest.yml',
      appVersion: '9.9.9 client=updater\nFAKE',
    });
    expect(line).toBe('[updater] check platform=win client=updater country=GB');
  });
});
