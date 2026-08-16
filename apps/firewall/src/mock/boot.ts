// Everything a mock or recording session does before the app exists.
//
// Order is the whole design here. `client.ts` and `rules.ts` read the environment at IMPORT time,
// so the credentials have to be fabricated before either is pulled in — which is why every import
// below is dynamic and why this runs from the entrypoint rather than from a module that something
// else already imported.

// The static imports below are all safe: ../util, ../env, ../env-file and ../repo-root reach the
// environment only from inside functions, never at module evaluation — env.ts says so in its own
// header, and that is the property this depends on.
//
// The three that DO read at evaluation — ../rules, ../client, ../observability — must stay dynamic
// imports inside bootMock, after fabricateEnv. A static import of any of them is what silently
// breaks the credential fabrication.
import { appendFileSync } from 'node:fs';

import { errMsg } from '../util';
import type { Miss } from './backend';
import {
  CASSETTE_VERSION,
  ensureOwnerOnly,
  ensureOwnerOnlyFile,
  headerVersionOf,
  loadCassette,
  resetCassette,
} from './cassette';
import {
  type CassetteInfo,
  type Drawer,
  NAME_RULE,
  cassettePathFor,
  listCassettes,
  resolveDrawer,
  prepareCassettesDir,
  validCassetteName,
} from './cassette-store';
import type { RecordingStats } from './record';
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

/**
 * Append one diagnostic line to the miss log, creating it owner-only.
 *
 * PRECONDITION: an EXISTING log must already have been secured — the create-mode below covers a
 * file this writes, not one that was already there. bootMock does that once at session start and
 * drops the log entirely if it cannot. Do not call this on an unvalidated path.
 */
export function appendMissLog(path: string, line: string): void {
  try {
    // 0600 like the cassette: a miss line carries the QUERY, and a query's filter names the client
    // IP or TLS fingerprint it was about. The default 0644 makes that readable by every account on
    // the machine — measured at 375 such lines in one session's log.
    appendFileSync(path, `${new Date().toISOString()}  ${line}\n`, {
      mode: 0o600,
    });
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
  /** Injected for the same reason `available` is. Reading it here made every message depend on whether a private repo happened to be checked out, which is why these passed locally and failed in CI. */
  drawer: Drawer = resolveDrawer(),
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
    if (!found) {
      if (available.length)
        return {
          kind: 'refused',
          message: `No cassette named "${named}".\nRecorded: ${available
            .map((c) => c.name)
            .join(', ')}`,
        };
      // Empty for two very different reasons: nothing recorded yet, or the drawer is unreachable.
      // Telling someone to record into a drawer that cannot be found sends them in a circle.
      return {
        kind: 'refused',
        message: `No cassette named "${named}".\n\n${
          drawer.kind === 'found' ? RECORD_FIRST : drawer.message
        }`,
      };
    }
    return { kind: 'chose', info: found };
  }
  if (!available.length)
    return {
      kind: 'refused',
      message: drawer.kind === 'found' ? RECORD_FIRST : drawer.message,
    };
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
  // ageDays comes from the listing rather than a second stat: listCassettes already read the
  // mtime to rank the drawer, and re-reading it after the chdir was a redundant syscall.
  const { name: cassetteName, path: cassetteFile, ageDays } = chosen.info;

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

  // Captured before the chdir below. bootMock runs IN-PROCESS in tests, so a failure after it
  // would leave every later test running from the sandbox — the exact live-state hazard the test
  // preload's own chdir exists to prevent.
  const startedIn = process.cwd();
  const dir = prepareSandbox();
  // Read BEFORE the overwrite, which is the only moment it is knowable. A real token here means
  // the session was launched through firewall:setup rather than firewall:mock, so it is running on
  // one safety layer instead of two — still sandboxed, but worth saying out loud.
  const inherited = Boolean(process.env.VERCEL_TOKEN);
  const restoreEnv = fabricateEnv(readSandboxEnv(sandboxEnvPath()));
  // Every state file this tool keeps is resolved from cwd, so one chdir redirects the watch list,
  // the ignore list, the watch log and the investigated set at once. The test preload already
  // does exactly this, for exactly the same reason.
  process.chdir(dir);

  const logPath = missLogPath();
  // Once, up front, like the cassette: a log left over from an earlier session keeps whatever mode
  // it had, and appending never tightens it.
  //
  // FAIL CLOSED. Swallowing this and writing anyway defeated the guard entirely: a symlink at the
  // miss-log path was refused here, the refusal was discarded as "diagnostics", and every later
  // append went through the link into whatever it pointed at. Diagnostics still must not take the
  // session down — so the log is dropped, not forced.
  let log: string | undefined = logPath;
  let logRefusal: string | undefined;
  try {
    ensureOwnerOnlyFile(logPath, '', 'miss log');
  } catch (error) {
    log = undefined;
    logRefusal = errMsg(error);
  }
  const misses = new Map<string, number>();
  const onMiss = (miss: Miss) => {
    misses.set(miss.reason, (misses.get(miss.reason) ?? 0) + 1);
    if (log) appendMissLog(log, `${miss.reason}  ${miss.key}`);
  };

  // Everything from here can throw — a dynamic import of a module poisoned by a failed evaluation,
  // or an installer refusing. The cwd goes back before the refusal so the caller is left where it
  // started; in a test process that is the difference between one failed case and every later
  // case running from the sandbox.
  try {
    const { mockObservability, mockWaf, recordedLiveConfig } =
      await import('./backend');
    const { decodeLiveConfig } = await import('./codec');
    // BOTH modules resolve before EITHER backend is installed. Installing observability and then
    // failing to import ../client left the process with a mock reader and a live writer — and
    // ../client is exactly the module that can fail to import, since a failed evaluation of its
    // module-scope credential read poisons it for the rest of the process.
    const observability = await import('../observability');
    const client = await import('../client');
    observability.installObservabilityBackend(
      mockObservability(cassette, onMiss),
    );
    client.installWafBackend(
      mockWaf(decodeLiveConfig(recordedLiveConfig(cassette))),
    );
  } catch (error) {
    // Both halves. Restoring the cwd and leaving fabricated credentials behind is the same bug
    // with a smaller blast radius.
    process.chdir(startedIn);
    restoreEnv();
    return { kind: 'refused', message: errMsg(error) };
  }

  if (log)
    appendMissLog(
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
          ageDays >= STALE_CASSETTE_DAYS
            ? `the cassette is ${ageDays} days old — re-record it, or delete it (it holds real client IPs and fingerprints)`
            : '',
          unrecorded ? `${unrecorded} queries had nothing recorded` : '',
          substituted ? `${substituted} answered from another window` : '',
          log && (unrecorded || substituted) ? `see ${log}` : '',
          // Said out loud rather than swallowed: without it, a session whose misses went nowhere
          // looks identical to one that had none.
          logRefusal ? `miss log disabled — ${logRefusal}` : '',
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
  // One try covers creating the drawer and securing the file. Creating it was outside the guard
  // and unhandled, so a read-only ops checkout surfaced a raw `EACCES: permission denied, mkdir`
  // through main().catch() instead of a refusal naming the cassette.
  let path: string;
  /** The format that was discarded, when re-recording had to reset a stale cassette. */
  let replaced: number | undefined;
  try {
    const drawer = prepareCassettesDir(where.dir);
    // Neither can be undefined here — the drawer is `found` and the name was validated above — but
    // asserting that with a cast means a future change to either fails as `undefined is not a
    // string` somewhere further on.
    if (!drawer)
      return { kind: 'refused', message: `could not prepare ${where.dir}` };
    const target = cassettePathFor(name, drawer);
    if (!target)
      return {
        kind: 'refused',
        message: `"${name}" is not a usable cassette name — ${NAME_RULE}`,
      };
    // Once, up front: a cassette copied in from elsewhere arrives with whatever mode it had.
    ensureOwnerOnly(target);
    // A recording APPENDS. Into a cassette this build cannot read, that buries fresh entries under
    // a stale header and the file stays refused — which made the refusal's own advice, "re-record
    // it", lead nowhere. Reset it to a bare current header first.
    const existing = headerVersionOf(target);
    if (existing !== undefined && existing !== CASSETTE_VERSION) {
      resetCassette(target);
      replaced = existing;
    }

    path = target;
  } catch (error) {
    return { kind: 'refused', message: errMsg(error) };
  }
  const stats: RecordingStats = { written: 0, failed: 0 };
  try {
    const { recordingObservability, recordingWaf } = await import('./record');
    // Both first, then install — same reason as bootMock: a half-installed pair leaves a mock
    // reader against a live writer, which is the worst of both.
    const observability = await import('../observability');
    const client = await import('../client');
    observability.installObservabilityBackend(
      recordingObservability(observability.liveObservability, path, stats),
    );
    client.installWafBackend(recordingWaf(client.liveWaf, path, stats));
  } catch (error) {
    return { kind: 'refused', message: errMsg(error) };
  }
  return {
    kind: 'started',
    session: {
      summary: () =>
        [
          `recorded ${stats.written} ${stats.written === 1 ? 'response' : 'responses'} to ${path}`,
          replaced !== undefined
            ? `replaced a format ${replaced} cassette this build could not read`
            : '',
          stats.failed
            ? `${stats.failed} could NOT be written — the cassette is incomplete${
                stats.firstError ? ` (${stats.firstError})` : ''
              }`
            : '',
          stats.written === 0
            ? 'nothing was recorded; a mock session will refuse this cassette'
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
    },
  };
}
