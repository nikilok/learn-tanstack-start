import { describe, expect, test } from 'bun:test';

import {
  classifyClient,
  installedVersion,
  parseFeedRequest,
  updaterLogLine,
} from './updaterLog';

const base = {
  userAgent: 'electron-builder',
  appVersion: null,
  country: 'GB',
  range: null,
};

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

  test('a crafted path or header cannot inject fields or newlines', () => {
    const line = updaterLogLine({
      ...base,
      userAgent: 'DotBot',
      path: 'latest/evil client=updater\nFAKE',
      appVersion: '9.9.9 client=updater',
    });
    // The separators an injection needs (space, `=`, newline) are all stripped.
    expect(line).toBe(
      '[updater] download client=other from=9.9.9clientupdater country=GB partial=0 file=evilclientupdaterFAKE',
    );
  });
});
