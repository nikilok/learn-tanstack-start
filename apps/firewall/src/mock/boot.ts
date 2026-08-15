// Everything a mock or recording session does before the app exists.
//
// Order is the whole design here. `client.ts` and `rules.ts` read the environment at IMPORT time,
// so the credentials have to be fabricated before either is pulled in — which is why every import
// below is dynamic and why this runs from the entrypoint rather than from a module that something
// else already imported.

// The static imports below reach only ../repo-root, so none of them reads the environment.
// Anything that does — ../rules, ../client, ../observability — MUST stay a dynamic import inside
// bootMock, after fabricateEnv.
import { appendFileSync } from 'node:fs';

import { errMsg } from '../util';
import type { Miss } from './backend';
import {
  CASSETTE_VERSION,
  cassetteAgeDays,
  ensureOwnerOnly,
  loadCassette,
} from './cassette';
import {
  type CassetteInfo,
  NAME_RULE,
  cassettePathFor,
  listCassettes,
  resolveDrawer,
  prepareCassettesDir,
  validCassetteName,
} from './cassette-store';
import {
  fabricateEnv,
  missLogPath,
  prepareSandbox,
  readSandboxEnv,
  sandboxEnvPath,
} from './sandbox';

// Past this, traffic shapes have moved enough that the corpus describes a different site.
const STALE_CASSETTE_DAYS = 30;

export type Session = {
  /** What to print once the TUI has given the terminal back. */
  summary: () => string;
};

/** What the picker settled on. */
export type Choice =
  | { kind: 'cassette'; info: CassetteInfo }
  | { kind: 'quit' };

/** How a mock session asks which corpus to replay. Injected so the ordering rules above stay in this module and a test can answer without a terminal. */
export type Picker = (available: readonly CassetteInfo[]) => Promise<Choice>;

/**
 * How a boot ended.
 *
 * A mock session with nothing to replay is refused rather than started empty: every traffic pane
 * would read zero, which looks exactly like a working session over a quiet window, and an operator
 * cannot tell those two apart from inside the TUI.
 */
export type Boot =
  | { kind: 'started'; session: Session }
  | { kind: 'quit' }
  | { kind: 'refused'; message: string };

function note(path: string, line: string): void {
  try {
    appendFileSync(path, `${new Date().toISOString()}  ${line}\n`);
  } catch {
    // The miss log is diagnostics. Losing it must not take the session down.
  }
}

export const RECORD_FIRST =
  'No cassettes recorded yet, and a mock session has nothing to replay without one.\n' +
  'Record one from a live session, driving the panes you want covered:\n\n' +
  '  bun run firewall:record --cassette <name>';

export type Chosen = { kind: 'chose'; info: CassetteInfo };

/** Resolve which cassette to replay: the one named on the command line, or whatever the picker returns. Takes the drawer's contents rather than reading them, so the decision is testable without one. */
export async function chooseCassette(
  available: readonly CassetteInfo[],
  named: string | undefined,
  pick: Picker | undefined,
): Promise<Boot | Chosen> {
  if (named !== undefined) {
    if (!validCassetteName(named))
      return {
        kind: 'refused',
        message: `"${named}" is not a usable cassette name — ${NAME_RULE}`,
      };
    const found = available.find((c) => c.name === named);
    // Named-but-missing is reported rather than started empty. A typo produces exactly the same
    // silent nothing as a real empty corpus, and an operator reads that as a broken tool.
    if (!found)
      return {
        kind: 'refused',
        message: `No cassette named "${named}".${
          available.length
            ? `\nRecorded: ${available.map((c) => c.name).join(', ')}`
            : `\n\n${RECORD_FIRST}`
        }`,
      };
    return { kind: 'chose', info: found };
  }
  if (!available.length) {
    const where = resolveDrawer();
    return {
      kind: 'refused',
      message: where.kind === 'found' ? RECORD_FIRST : where.message,
    };
  }
  if (!pick)
    return {
      kind: 'refused',
      message: 'no way to choose a cassette — pass --cassette <name>',
    };
  const choice = await pick(available);
  return choice.kind === 'quit'
    ? { kind: 'quit' }
    : { kind: 'chose', info: choice.info };
}

/**
 * Boot a mock session: choose a corpus, sandbox the state, fabricate the environment, and serve
 * every read from the recording.
 *
 * The cassette is chosen FIRST, before anything is created, so quitting at the picker leaves no
 * trace — and because the corpus decides what every pane will say, which makes it the wrong thing
 * to pick after the panes have already drawn themselves from a different one.
 */
export async function bootMock(
  opts: { named?: string; pick?: Picker } = {},
): Promise<Boot> {
  const chosen = await chooseCassette(listCassettes(), opts.named, opts.pick);
  if (chosen.kind !== 'chose') return chosen;
  const { name: cassetteName, path: cassetteFile } = chosen.info;

  // Read and checked BEFORE the sandbox is built or the environment is replaced, so a refusal
  // leaves the process exactly as it found it. A cassette whose keys mean something else answers
  // NOTHING, and an empty pane reads as "the recorder missed this" rather than "wrong format" —
  // which is how a real 108 MB corpus went dead unnoticed.
  const cassette = loadCassette(cassetteFile);
  if (cassette.version !== CASSETTE_VERSION)
    return {
      kind: 'refused',
      message:
        `"${cassetteName}" is cassette format ${cassette.version} and this build reads ${CASSETTE_VERSION}.\n` +
        'Its keys no longer mean the same thing, so every query would silently miss.\n\n' +
        `Re-record it:  bun run firewall:record --cassette ${cassetteName}`,
    };

  // A cassette that recorded nothing is refused for the same reason an empty drawer is: every
  // pane reads zero, which is indistinguishable from a working session over a quiet window. A
  // recording session that failed to boot leaves exactly this behind.
  if (cassette.entries.size === 0)
    return {
      kind: 'refused',
      message:
        `"${cassetteName}" has no recordings in it.\n` +
        `Re-record it:  bun run firewall:record --cassette ${cassetteName}`,
    };

  const dir = prepareSandbox();
  // Read BEFORE the overwrite, which is the only moment it is knowable. A real token here means
  // the session was launched through firewall:setup rather than firewall:mock, so it is running on
  // one safety layer instead of two — still sandboxed, but worth saying out loud.
  const inherited = Boolean(process.env.VERCEL_TOKEN);
  fabricateEnv(readSandboxEnv(sandboxEnvPath()));
  // Every state file this tool keeps is resolved from cwd, so one chdir redirects the watch list,
  // the ignore list, the watch log and the investigated set at once. The test preload already
  // does exactly this, for exactly the same reason.
  process.chdir(dir);

  const ageDays = cassetteAgeDays(cassetteFile);
  const log = missLogPath();
  const misses = new Map<string, number>();
  const onMiss = (miss: Miss) => {
    misses.set(miss.reason, (misses.get(miss.reason) ?? 0) + 1);
    note(log, `${miss.reason}  ${miss.key}`);
  };

  const { mockObservability, mockWaf, recordedLiveConfig } =
    await import('./backend');
  const { decodeLiveConfig } = await import('./codec');
  const observability = await import('../observability');
  observability.installObservabilityBackend(
    mockObservability(cassette, onMiss),
  );
  const client = await import('../client');
  client.installWafBackend(
    mockWaf(decodeLiveConfig(recordedLiveConfig(cassette))),
  );

  note(
    log,
    `session  "${cassetteName}", ${cassette.entries.size} recordings, ${cassette.skipped} unreadable lines${
      inherited ? ', launched with a real credential in the environment' : ''
    }`,
  );
  return {
    kind: 'started',
    session: {
      summary: () => {
        const unrecorded = misses.get('unrecorded') ?? 0;
        const substituted = misses.get('window-substituted') ?? 0;
        return [
          `mock session over ${cassette.entries.size} recordings from "${cassetteName}"`,
          ageDays !== undefined && ageDays >= STALE_CASSETTE_DAYS
            ? `the cassette is ${ageDays} days old — re-record it, or delete it (it holds real client IPs and fingerprints)`
            : '',
          unrecorded ? `${unrecorded} queries had nothing recorded` : '',
          substituted ? `${substituted} answered from another window` : '',
          unrecorded || substituted ? `see ${log}` : '',
          inherited
            ? 'note: a real VERCEL_TOKEN was in the environment and was overwritten — run `bun run firewall:mock` to keep it out of the process entirely'
            : '',
        ]
          .filter(Boolean)
          .join(' · ');
      },
    },
  };
}

/** Boot a recording session: a fully live run that also writes every response to the named cassette. */
export async function bootRecording(name: string): Promise<Boot> {
  if (!validCassetteName(name))
    return {
      kind: 'refused',
      message: `"${name}" is not a usable cassette name — ${NAME_RULE}`,
    };
  const where = resolveDrawer();
  if (where.kind === 'missing')
    return { kind: 'refused', message: where.message };
  const drawer = prepareCassettesDir(where.dir) as string;
  const path = cassettePathFor(name, drawer) as string;
  // Once, up front: a cassette copied in from elsewhere arrives with whatever mode it had.
  try {
    ensureOwnerOnly(path);
  } catch (error) {
    return { kind: 'refused', message: errMsg(error) };
  }
  const { recordingObservability, recordingWaf } = await import('./record');
  const observability = await import('../observability');
  observability.installObservabilityBackend(
    recordingObservability(observability.liveObservability, path),
  );
  const client = await import('../client');
  client.installWafBackend(recordingWaf(client.liveWaf, path));
  return {
    kind: 'started',
    session: { summary: () => `recording appended to ${path}` },
  };
}
