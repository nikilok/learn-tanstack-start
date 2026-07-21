// Model acquisition for the local Gemma provider: cache-path default, download
// with progress + sha256 verification, and cached-file re-verify with self-heal.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';

import { MODEL_REVISION } from './model-pin';

/** Where the model lives and how to fetch/verify it. */
export interface GemmaModelConfig {
  /** Absolute path of the .litertlm file (downloaded here when missing). */
  path: string;
  url: string;
  /** Expected sha256 hex digest, or null to skip verification. */
  sha256: string | null;
  /** Re-hash an existing file before trusting it (CI restores from a cache). */
  verifyCached: boolean;
}

/** Default cache path; embeds the pin revision so a bump can't reuse an old file. */
export function defaultModelPath(): string {
  return join(
    homedir(),
    '.cache',
    'litert-lm',
    `gemma-4-E2B-it-web-${MODEL_REVISION.slice(0, 7)}.litertlm`,
  );
}

/** Creates a 10%-step progress gate: returns the step to log once per decade, else null. */
export function createProgressGate(): (pct: number) => number | null {
  let logged = -10;
  return (pct) => {
    if (pct < logged + 10) return null;
    logged = pct - (pct % 10);
    return logged;
  };
}

/** Streams a file through sha256 and returns the hex digest. */
async function fileSha256(path: string): Promise<string> {
  const hasher = createHash('sha256');
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest('hex');
}

/** Downloads the .litertlm model to config.path when it isn't cached yet. */
export async function ensureModel(config: GemmaModelConfig): Promise<void> {
  if (existsSync(config.path)) {
    if (!(config.sha256 && config.verifyCached)) return;
    const digest = await fileSha256(config.path);
    if (digest === config.sha256) {
      console.log('[gemma] cached model sha256 verified');
      return;
    }
    console.warn(
      `[gemma] cached model sha256 mismatch (${digest}), re-downloading`,
    );
    unlinkSync(config.path);
  }
  console.log(`[gemma] model not found, downloading to ${config.path}`);
  console.log(`[gemma] source: ${config.url}`);
  mkdirSync(dirname(config.path), { recursive: true });
  const res = await fetch(config.url);
  if (!res.ok || !res.body) {
    throw new Error(`Model download failed: ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const partial = `${config.path}.partial`;
  const writer = createWriteStream(partial);
  // A write error with no listener attached (e.g. ENOSPC mid-download) crashes
  // the process; capture it so the loop surfaces it through the throw path.
  let writeError: Error | null = null;
  writer.on('error', (err) => {
    writeError = err;
  });
  const hasher = config.sha256 ? createHash('sha256') : null;
  const progress = createProgressGate();
  let received = 0;
  try {
    for await (const chunk of res.body) {
      if (writeError) throw writeError;
      if (!writer.write(chunk)) await once(writer, 'drain');
      hasher?.update(chunk);
      received += chunk.byteLength;
      const step = progress(total ? Math.floor((received / total) * 100) : 0);
      if (step !== null) {
        console.log(
          `[gemma] download ${step}% (${(received / 1e9).toFixed(2)} GB)`,
        );
      }
    }
    writer.end();
    await finished(writer);
    if (hasher) {
      const digest = hasher.digest('hex');
      if (digest !== config.sha256) {
        throw new Error(
          `Model sha256 mismatch: expected ${config.sha256}, got ${digest} — refusing to use the download`,
        );
      }
      console.log('[gemma] sha256 verified');
    }
  } catch (err) {
    // Reap the fd and the multi-GB partial on any failed transfer.
    writer.destroy();
    rmSync(partial, { force: true });
    throw err;
  }
  renameSync(partial, config.path);
  console.log(`[gemma] download complete (${(received / 1e9).toFixed(2)} GB)`);
}
