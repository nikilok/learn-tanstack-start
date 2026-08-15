// The directory a mock session lives in, and the environment it lives on.
//
// Both exist so mock mode cannot reach live state by ACCIDENT rather than by flag. `--dry-run` is a
// boolean somebody has to get right at every write; this is a process whose credentials are fake
// and whose cwd is not the repo, so the writes have nowhere real to land.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../repo-root';

export const SANDBOX_DIR = '.firewall-mock';

/** The mock session's working directory: its own watch list, ignore list, watch log and .env.local. */
export function sandboxPath(): string {
  return join(REPO_ROOT, SANDBOX_DIR);
}

/** Where a replayed query with nothing recorded for it is logged, so an empty pane can be told from an empty result. */
export function missLogPath(dir: string = sandboxPath()): string {
  return join(dir, 'mock-misses.log');
}

/** The sandbox's own .env.local — what an applied deny is persisted to instead of the real one. */
export function sandboxEnvPath(dir: string = sandboxPath()): string {
  return join(dir, '.env.local');
}

// Deliberately round and obviously synthetic. The real ceilings are calibration figures kept out
// of this repo, and a mock session must never be a way to read them.
const MOCK_JA4_DENIED = 't13d1516h2_aaaaaaaaaaaa_111111111111';
const MOCK_JA4_CHALLENGED = 't13d1517h2_bbbbbbbbbbbb_222222222222';

// Everything rules.ts and tuning.ts refuse to build without. A new required value added there
// fails a mock boot by name, which is the right way for this list to go out of date.
const MOCK_ENV: Record<string, string> = {
  REVALIDATE_MARKER_HEADER: 'x-mock-revalidate-marker',
  FW_SERVERFN_LIMIT: '1000',
  FW_SEARCH_LIMIT: '1000',
  FW_TILES_LIMIT: '1000',
  FW_JA4_LIMIT: '1000',
  FW_SERVERFN_SUSTAINED_LIMIT: '10000',
  FW_SEARCH_SUSTAINED_LIMIT: '10000',
  FW_COMPANY_LIMIT: '1000',
  FW_COMPANY_SUSTAINED_LIMIT: '10000',
  FW_DOWNLOADS_LIMIT: '1000',
  FW_BLOCKED_UA: 'mock-scraper-agent',
  FW_BLOCKED_JA4: MOCK_JA4_DENIED,
  FW_CHALLENGE_JA4: MOCK_JA4_CHALLENGED,
  FW_BLOCKED_ASN: '64512',
  FW_ALLOWED_BOTS: 'googlebot,bingbot',
  FW_WATCH_HOURS: '6',
  FW_WATCH_INTERVAL_MIN: '15',
  FW_WATCH_MIN_REQUESTS: '500',
};

// Never inherited into a mock session: the first would notify a real phone, the second would let an
// unattended tick stage bans off synthetic traffic.
const REFUSED_ENV = ['FW_NOTIFY_IMESSAGE', 'FW_AUTO_BAN'];

/** Refuse a path that is a symlink: every writer here follows one, so it would act on the target. */
function refuseLink(path: string, what: string): void {
  // lstatSync directly, NOT existsSync first: existsSync FOLLOWS the link, so a DANGLING one
  // reported false, skipped this guard, and prepareSandbox then wrote through it and created the
  // link's target. Only an absent path is allowed to pass; anything else is re-thrown.
  let stat;
  try {
    stat = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (stat.isSymbolicLink())
    throw new Error(
      `${path} is a symlink, and the ${what} must not be — a mock session would write through it`,
    );
}

/** FW_* assignments from a sandbox .env.local, so a deny persisted by one mock session is live in the next. */
export function readSandboxEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // FW_* only. A real token pasted into the sandbox file must still not become a credential.
    if (!key.startsWith('FW_')) continue;
    out[key] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Replace this process's environment with the mock one, before any module has read it.
 *
 * The VERCEL_* overwrite is the second of two layers. The first is the script: `--no-env-file`
 * stops bun auto-loading the repo's own .env.local, so the real token is never in the process at
 * all. This one covers a hand-run `bun src/setup.tsx --mock`, where it is — `credentials.ts` reads
 * process.env, so once these are fake there is no path left that can produce the real one.
 */
export function fabricateEnv(sandboxEnv: Record<string, string> = {}): void {
  process.env.VERCEL_TOKEN = 'mock-token-not-a-credential';
  process.env.VERCEL_PROJECT_ID = 'prj_mock';
  process.env.VERCEL_TEAM_ID = 'team_mock';
  for (const [key, value] of Object.entries(MOCK_ENV)) process.env[key] = value;
  for (const [key, value] of Object.entries(sandboxEnv))
    process.env[key] = value;
  for (const key of REFUSED_ENV) delete process.env[key];
}

/** Create the sandbox if it is not there yet and return it. Existing contents are left alone: a watch list built up over a few sessions is the point of a directory rather than a temp dir. */
export function prepareSandbox(dir: string = sandboxPath()): string {
  // Neither the sandbox nor its env file may be a symlink. Everything a mock session writes lands
  // under here, so a link would put an applied deny — and the whole cwd-derived state — somewhere
  // real. The cassette and the miss log refuse links for the same reason.
  refuseLink(dir, 'sandbox directory');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = sandboxEnvPath(dir);
  refuseLink(env, 'sandbox .env.local');
  if (!existsSync(env))
    writeFileSync(
      env,
      [
        '# Written by --mock. Synthetic values only; nothing here is a real credential or a real ceiling.',
        '# Applied denies from a mock session are persisted here and read back on the next one.',
        '# Only FW_* is read back, so nothing else edited here has any effect.',
        ...Object.entries(MOCK_ENV).map(([k, v]) => `${k}=${v}`),
        '',
      ].join('\n'),
    );
  return dir;
}
