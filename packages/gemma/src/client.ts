// Runtime-agnostic orchestration: model acquisition, engine init + warmup,
// timeouts, and per-ask stats, all over a HarnessHost supplied by the runtime
// (Playwright in apps/web scripts today; an Electron BrowserWindow later).
import type { GemmaAskRaw, GemmaInitResult } from './harness';
import { ensureModel, type GemmaModelConfig } from './model';

// Generation is normally seconds; the caps only exist so a wedged WebGPU
// device fails loudly instead of hanging the caller forever.
const INIT_TIMEOUT_MS = 600_000;
const ASK_TIMEOUT_MS = 300_000;

/** What a runtime provides: a loaded harness page the core can call into. */
export interface HarnessHost {
  /** Serve the harness + assets for the verified model file and load the page. */
  load(modelPath: string): Promise<void>;
  /** Invoke window.gemmaInit in the page. */
  init(opts: { maxNumTokens: number }): Promise<GemmaInitResult>;
  /** Invoke window.gemmaAsk in the page. */
  ask(args: { prompt: string; system: string }): Promise<GemmaAskRaw>;
  /** Tear everything down; must be safe to call at any point, twice included. */
  dispose(): Promise<void>;
}

export interface GemmaAskResult {
  text: string;
  stats: string;
}

export interface GemmaClient {
  ask(prompt: string, system: string): Promise<GemmaAskResult>;
  stop(): Promise<void>;
}

/** Everything createGemmaClient needs beyond the host itself. */
export interface GemmaClientConfig {
  model: GemmaModelConfig;
  /** Engine context budget in tokens. */
  maxNumTokens: number;
}

/** Rejects with a labeled error when a promise doesn't settle in time. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Formats a generation's benchmark numbers into a compact log line. */
function formatStats(result: GemmaAskRaw): string {
  const bench = result.bench;
  return bench
    ? `prefill ${bench.lastPrefillTokenCount} tok @ ${bench.lastPrefillTokensPerSecond.toFixed(0)} tok/s, ` +
        `decode ${bench.lastDecodeTokenCount} tok @ ${bench.lastDecodeTokensPerSecond.toFixed(1)} tok/s, ` +
        `${(result.elapsedMs / 1000).toFixed(1)}s total`
    : `${(result.elapsedMs / 1000).toFixed(1)}s total`;
}

/** Boots the local Gemma stack on a host: model, harness, engine init, warmup. */
export async function createGemmaClient(
  host: HarnessHost,
  config: GemmaClientConfig,
): Promise<GemmaClient> {
  if (!Number.isInteger(config.maxNumTokens) || config.maxNumTokens <= 0) {
    throw new Error(
      `maxNumTokens must be a positive integer, got ${config.maxNumTokens}`,
    );
  }
  await ensureModel(config.model);
  // Any failure past this point must reap the host — the caller never gets a
  // client handle to stop().
  try {
    // The host serves exactly the file ensureModel just verified.
    await host.load(config.model.path);
    const t0 = performance.now();
    const { adapter, fallback } = await withTimeout(
      host.init({ maxNumTokens: config.maxNumTokens }),
      INIT_TIMEOUT_MS,
      'Gemma engine init',
    );
    console.log(
      `[gemma] engine ready in ${((performance.now() - t0) / 1000).toFixed(1)}s ` +
        `(WebGPU: ${adapter}${fallback ? ' — software fallback' : ''}, context: ${config.maxNumTokens} tokens)`,
    );
    // First generation pays a one-time shader compile / weight conversion cost
    // (~25s observed); absorb it here so per-step timings are representative.
    const tWarm = performance.now();
    await withTimeout(
      host.ask({
        prompt: 'Reply with exactly: OK',
        system: 'You reply with exactly what is asked, nothing else.',
      }),
      INIT_TIMEOUT_MS,
      'Gemma warmup generation',
    );
    console.log(
      `[gemma] warmup generation in ${((performance.now() - tWarm) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    await host.dispose().catch(() => {});
    throw err;
  }
  return {
    async ask(prompt, system) {
      const result = await withTimeout(
        host.ask({ prompt, system }),
        ASK_TIMEOUT_MS,
        'Gemma generation',
      );
      return { text: result.text, stats: formatStats(result) };
    },
    async stop() {
      await host.dispose();
    },
  };
}
