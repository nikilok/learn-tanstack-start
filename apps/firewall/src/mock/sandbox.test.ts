import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fabricateEnv,
  prepareSandbox,
  readSandboxEnv,
  sandboxEnvPath,
  sandboxPath,
} from './sandbox';

// Set by the preload, and other files depend on them, so every one this suite touches goes back.
const TOUCHED = [
  'REVALIDATE_MARKER_HEADER',
  'VERCEL_TOKEN',
  'VERCEL_PROJECT_ID',
  'VERCEL_TEAM_ID',
  'FW_BLOCKED_JA4',
  'FW_CHALLENGE_JA4',
  'FW_BLOCKED_ASN',
  'FW_BLOCKED_UA',
  'FW_ALLOWED_BOTS',
  'FW_SERVERFN_LIMIT',
  'FW_SEARCH_LIMIT',
  'FW_TILES_LIMIT',
  'FW_JA4_LIMIT',
  'FW_SERVERFN_SUSTAINED_LIMIT',
  'FW_SEARCH_SUSTAINED_LIMIT',
  'FW_COMPANY_LIMIT',
  'FW_COMPANY_SUSTAINED_LIMIT',
  'FW_DOWNLOADS_LIMIT',
  'FW_WATCH_HOURS',
  'FW_WATCH_INTERVAL_MIN',
  'FW_WATCH_MIN_REQUESTS',
  'FW_NOTIFY_IMESSAGE',
  'FW_AUTO_BAN',
];

let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fw-sandbox-'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('the fabricated environment', () => {
  // The load-bearing line of the whole mode. credentials.ts reads process.env, so once these are
  // fake there is no path left in the process that can produce the real token.
  test('overwrites the credentials even when real ones are already exported', () => {
    process.env.VERCEL_TOKEN = 'a-real-looking-token';
    process.env.VERCEL_PROJECT_ID = 'prj_real';
    process.env.VERCEL_TEAM_ID = 'team_real';
    fabricateEnv();
    expect(process.env.VERCEL_TOKEN).not.toBe('a-real-looking-token');
    expect(process.env.VERCEL_PROJECT_ID).toBe('prj_mock');
    expect(process.env.VERCEL_TEAM_ID).toBe('team_mock');
  });

  test('supplies every value the rule set refuses to build without', () => {
    for (const k of TOUCHED) delete process.env[k];
    fabricateEnv();
    for (const name of [
      'FW_SERVERFN_LIMIT',
      'FW_SEARCH_LIMIT',
      'FW_TILES_LIMIT',
      'FW_JA4_LIMIT',
      'FW_SERVERFN_SUSTAINED_LIMIT',
      'FW_SEARCH_SUSTAINED_LIMIT',
      'FW_COMPANY_LIMIT',
      'FW_COMPANY_SUSTAINED_LIMIT',
      'FW_BLOCKED_JA4',
      'FW_CHALLENGE_JA4',
      'FW_BLOCKED_ASN',
      'FW_ALLOWED_BOTS',
    ])
      expect(process.env[name]).toBeTruthy();
  });

  // One notifies a real phone; the other lets an unattended tick stage bans off synthetic traffic.
  test('refuses to inherit the notify and auto-ban switches', () => {
    process.env.FW_NOTIFY_IMESSAGE = '+440000000000';
    process.env.FW_AUTO_BAN = '1';
    fabricateEnv();
    expect(process.env.FW_NOTIFY_IMESSAGE).toBeUndefined();
    expect(process.env.FW_AUTO_BAN).toBeUndefined();
  });

  test('a value persisted by a previous mock session wins over the default', () => {
    fabricateEnv({ FW_BLOCKED_JA4: 't13d1516h2_dddddddddddd_444444444444' });
    expect(process.env.FW_BLOCKED_JA4).toBe(
      't13d1516h2_dddddddddddd_444444444444',
    );
  });

  test('the fabricated ceilings are not the real ones', () => {
    fabricateEnv();
    // Round numbers by construction. A mock session must never be a way to read the calibration.
    expect(Number(process.env.FW_JA4_LIMIT) % 100).toBe(0);
  });
});

describe('reading a sandbox .env.local back', () => {
  test('an absent file reads as no overrides', () => {
    expect(readSandboxEnv(join(dir, 'nothing'))).toEqual({});
  });

  test('parses assignments, skipping comments and blank lines', () => {
    const path = join(dir, '.env.local');
    writeFileSync(
      path,
      ['# a comment', '', 'FW_BLOCKED_ASN=64512', '  FW_WATCH_HOURS=3  '].join(
        '\n',
      ),
    );
    expect(readSandboxEnv(path)).toEqual({
      FW_BLOCKED_ASN: '64512',
      FW_WATCH_HOURS: '3',
    });
  });

  test('strips the quotes a persisted list is written with', () => {
    const path = join(dir, '.env.local');
    writeFileSync(path, 'FW_BLOCKED_JA4="a,b"\n');
    expect(readSandboxEnv(path).FW_BLOCKED_JA4).toBe('a,b');
  });

  test('keeps a value containing an equals sign whole', () => {
    const path = join(dir, '.env.local');
    writeFileSync(path, 'FW_BLOCKED_UA=token=1\n');
    expect(readSandboxEnv(path).FW_BLOCKED_UA).toBe('token=1');
  });

  // The sandbox file is writable by anyone with the repo. It must not be a way to reintroduce a
  // credential into a session whose entire safety rests on not having one.
  test('reads FW_ keys only — a token pasted into the sandbox is not a credential', () => {
    const path = join(dir, '.env.local');
    writeFileSync(
      path,
      ['VERCEL_TOKEN=a-real-looking-token', 'FW_WATCH_HOURS=3'].join('\n'),
    );
    const read = readSandboxEnv(path);
    expect(read.VERCEL_TOKEN).toBeUndefined();
    expect(read.FW_WATCH_HOURS).toBe('3');
  });
});

describe('preparing the sandbox', () => {
  test('creates the directory and seeds an env file', () => {
    prepareSandbox(join(dir, 'box'));
    expect(existsSync(join(dir, 'box', '.env.local'))).toBe(true);
  });

  test('the seeded file is readable by the reader that loads it', () => {
    const box = join(dir, 'box');
    prepareSandbox(box);
    expect(readSandboxEnv(sandboxEnvPath(box)).FW_BLOCKED_JA4).toBeTruthy();
  });

  // The point of a directory rather than a temp dir: a watch list built up over a few sessions,
  // and the denies a previous session applied, survive.
  test('leaves an existing env file alone', () => {
    const box = join(dir, 'box');
    prepareSandbox(box);
    writeFileSync(sandboxEnvPath(box), 'FW_WATCH_HOURS=99\n');
    prepareSandbox(box);
    expect(readFileSync(sandboxEnvPath(box), 'utf8')).toBe(
      'FW_WATCH_HOURS=99\n',
    );
  });

  test('the default sandbox is a directory in the repo, not the repo itself', () => {
    expect(sandboxPath().endsWith('.firewall-mock')).toBe(true);
  });
});
