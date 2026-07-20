// Runs Gemma 4 (E2B, .litertlm web build) fully locally via Google's LiteRT-LM
// Web API (@litert-lm/core). The runtime is WebGPU-only, so inference happens in
// a headless Chromium page driven by Playwright; a local Bun server hands the
// page the runtime, its wasm, and the model file. No data leaves the machine.
//
// Env: GEMMA_MODEL_PATH (default ~/.cache/litert-lm/gemma-4-E2B-it-web.litertlm),
//      GEMMA_MODEL_URL (download used when the file is missing; overriding skips
//      the sha256 check unless GEMMA_MODEL_SHA256 is also set),
//      GEMMA_MAX_TOKENS (context budget, default 8192), GEMMA_DEBUG=1 (browser logs),
//      GEMMA_CHROMIUM_FLAGS (extra space-separated Chromium args, e.g. CI GPU experiments).
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';

import { type Browser, chromium } from 'playwright';

// Pinned to litert-community/gemma-4-E2B-it-litert-lm@main as of 2026-07-20
// (revision 9262660, file lfs oid below) — bump URL revision and sha together.
const DEFAULT_MODEL_URL =
  'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/9262660a1676eed6d0c477ab1a86344430854664/gemma-4-E2B-it-web.litertlm';
const DEFAULT_MODEL_SHA256 =
  '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5';

const MODEL_URL = process.env.GEMMA_MODEL_URL ?? DEFAULT_MODEL_URL;
const MODEL_SHA256 =
  process.env.GEMMA_MODEL_SHA256 ??
  (process.env.GEMMA_MODEL_URL ? null : DEFAULT_MODEL_SHA256);
const MODEL_PATH =
  process.env.GEMMA_MODEL_PATH ??
  join(homedir(), '.cache', 'litert-lm', 'gemma-4-E2B-it-web.litertlm');
const MAX_NUM_TOKENS = Number(process.env.GEMMA_MAX_TOKENS ?? 8192);
const DEBUG = process.env.GEMMA_DEBUG === '1';

export interface GemmaAskResult {
  text: string;
  stats: string;
}

export interface GemmaClient {
  ask(prompt: string, system: string): Promise<GemmaAskResult>;
  stop(): Promise<void>;
}

interface HarnessWindow {
  gemmaInit(opts: {
    maxNumTokens: number;
  }): Promise<{ adapter: string; fallback: boolean }>;
  gemmaAsk(args: { prompt: string; system: string }): Promise<{
    text: string;
    elapsedMs: number;
    tokens: number | null;
    bench: {
      lastPrefillTokensPerSecond: number;
      lastPrefillTokenCount: number;
      lastDecodeTokensPerSecond: number;
      lastDecodeTokenCount: number;
      timeToFirstTokenInSecond: number;
    } | null;
  }>;
}

/** Chromium flags that expose a hardware WebGPU adapter in headless mode. */
function webgpuFlags(): string[] {
  const base = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  // macOS: ANGLE Metal. Linux (e.g. a GPU CI runner): the Vulkan recipe.
  const platform =
    process.platform === 'darwin'
      ? [...base, '--use-angle=metal']
      : [
          ...base,
          '--enable-features=Vulkan',
          '--use-angle=vulkan',
          '--disable-vulkan-surface',
        ];
  const extra = (process.env.GEMMA_CHROMIUM_FLAGS ?? '').split(/\s+/).filter(Boolean);
  return [...platform, ...extra];
}

/** Resolves an installed package's root directory from its dist entry point. */
function packageRoot(specifier: string, from: string): string {
  const entry = Bun.resolveSync(specifier, from);
  const marker = `${sep}dist${sep}`;
  const idx = entry.lastIndexOf(marker);
  if (idx === -1)
    throw new Error(`Cannot locate package root for ${specifier} (${entry})`);
  return entry.slice(0, idx);
}

/** Streams a file through sha256 and returns the hex digest. */
async function fileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

/** Downloads the .litertlm model to MODEL_PATH when it isn't cached yet. */
async function ensureModel(): Promise<void> {
  if (existsSync(MODEL_PATH)) {
    // Local runs trust the once-verified download (hashing 2GB costs ~6s); CI
    // restores from actions/cache, where cache-key/revision drift or a stale
    // entry would otherwise run silently — verify there, self-heal on mismatch.
    const verifyExisting =
      MODEL_SHA256 && (process.env.CI || process.env.GEMMA_VERIFY === '1');
    if (!verifyExisting) return;
    const digest = await fileSha256(MODEL_PATH);
    if (digest === MODEL_SHA256) {
      console.log('[gemma] cached model sha256 verified');
      return;
    }
    console.warn(`[gemma] cached model sha256 mismatch (${digest}), re-downloading`);
    unlinkSync(MODEL_PATH);
  }
  console.log(`[gemma] model not found, downloading to ${MODEL_PATH}`);
  console.log(`[gemma] source: ${MODEL_URL}`);
  mkdirSync(dirname(MODEL_PATH), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Model download failed: ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const partial = `${MODEL_PATH}.partial`;
  const writer = Bun.file(partial).writer();
  const hasher = MODEL_SHA256 ? new Bun.CryptoHasher('sha256') : null;
  let received = 0;
  let lastPct = -10;
  for await (const chunk of res.body) {
    writer.write(chunk);
    hasher?.update(chunk);
    received += chunk.byteLength;
    const pct = total ? Math.floor((received / total) * 100) : 0;
    if (pct >= lastPct + 10) {
      lastPct = pct - (pct % 10);
      console.log(
        `[gemma] download ${lastPct}% (${(received / 1e9).toFixed(2)} GB)`,
      );
    }
  }
  await writer.end();
  if (hasher) {
    const digest = hasher.digest('hex');
    if (digest !== MODEL_SHA256) {
      unlinkSync(partial);
      throw new Error(
        `Model sha256 mismatch: expected ${MODEL_SHA256}, got ${digest} — refusing to use the download`,
      );
    }
    console.log('[gemma] sha256 verified');
  }
  renameSync(partial, MODEL_PATH);
  console.log(`[gemma] download complete (${(received / 1e9).toFixed(2)} GB)`);
}

/** Serves a file from within a package root, refusing path traversal. */
function servePackageFile(root: string, rest: string): Response {
  const path = normalize(join(root, rest));
  if (path !== root && !path.startsWith(root + sep))
    return new Response('forbidden', { status: 403 });
  const file = Bun.file(path);
  const type = path.endsWith('.wasm')
    ? 'application/wasm'
    : path.endsWith('.js')
      ? 'text/javascript'
      : (file.type ?? 'application/octet-stream');
  return new Response(file, { headers: { 'content-type': type } });
}

const HARNESS_HTML = `<!doctype html>
<title>gemma-litert harness</title>
<script type="importmap">{"imports":{"@litertjs/wasm-utils":"/wasm-utils/dist/index.js"}}</script>
<script type="module">
import { Engine, SamplerType, loadLiteRtLm } from '/core/dist/index.js';

let engine;

window.gemmaInit = async ({ maxNumTokens }) => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter available in this browser context');
  const info = adapter.info;
  await loadLiteRtLm('/core/wasm/');
  engine = await Engine.create({
    model: '/model',
    mainExecutorSettings: { maxNumTokens },
    benchmarkEnabled: true,
  });
  return {
    adapter: [info?.vendor, info?.architecture].filter(Boolean).join(' '),
    fallback: adapter.isFallbackAdapter === true,
  };
};

window.gemmaAsk = async ({ prompt, system }) => {
  const conversation = await engine.createConversation({
    preface: { messages: [{ role: 'system', content: system }] },
    sessionConfig: { samplerParams: { type: SamplerType.GREEDY } },
  });
  try {
    const t0 = performance.now();
    const response = await conversation.sendMessage(prompt);
    const elapsedMs = performance.now() - t0;
    const text = typeof response.content === 'string'
      ? response.content
      : (response.content ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
    const bench = await conversation.getBenchmarkInfo().catch(() => null);
    const tokens = await conversation.getTokenCount().catch(() => null);
    return { text, elapsedMs, tokens, bench };
  } finally {
    await conversation.delete();
  }
};

window.gemmaReady = true;
</script>`;

/** Boots the local Gemma stack: model cache, asset server, WebGPU Chromium, engine. */
export async function createGemmaClient(): Promise<GemmaClient> {
  await ensureModel();

  const coreRoot = packageRoot('@litert-lm/core', import.meta.dir);
  const wasmUtilsRoot = packageRoot('@litertjs/wasm-utils', coreRoot);
  const model = Bun.file(MODEL_PATH);

  let transferLogged = -10;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/') {
        return new Response(HARNESS_HTML, {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (pathname === '/model') {
        let sent = 0;
        const counter = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            sent += chunk.byteLength;
            const pct = Math.floor((sent / model.size) * 100);
            if (pct >= transferLogged + 10) {
              transferLogged = pct - (pct % 10);
              console.log(`[gemma] model → browser ${transferLogged}%`);
            }
            controller.enqueue(chunk);
          },
        });
        return new Response(model.stream().pipeThrough(counter), {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(model.size),
          },
        });
      }
      if (pathname.startsWith('/core/'))
        return servePackageFile(coreRoot, pathname.slice('/core/'.length));
      if (pathname.startsWith('/wasm-utils/')) {
        return servePackageFile(
          wasmUtilsRoot,
          pathname.slice('/wasm-utils/'.length),
        );
      }
      return new Response('not found', { status: 404 });
    },
  });

  console.log(
    `[gemma] model: ${MODEL_PATH} (${(model.size / 1e9).toFixed(2)} GB)`,
  );

  // Any init failure past this point must reap the server (it holds the event
  // loop open) and the browser — the caller never gets a client to stop().
  let browser: Browser | undefined;
  try {
    const launched = await chromium.launch({
      headless: true,
      args: webgpuFlags(),
    });
    browser = launched;
    const page = await launched.newPage();
    page.on('pageerror', (err) =>
      console.error('[gemma:browser]', err.message),
    );
    page.on('console', (msg) => {
      // LiteRT's glog chatter (I…/W…/INFO:/WARNING: lines) lands on console.error; keep it debug-only.
      const isGlogNoise = /^(?:INFO:|WARNING:|[IW]\d{4})/.test(msg.text());
      if (DEBUG || (msg.type() === 'error' && !isGlogNoise)) {
        console.log(`[gemma:browser:${msg.type()}]`, msg.text());
      }
    });

    const t0 = performance.now();
    await page.goto(`http://127.0.0.1:${server.port}/`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => 'gemmaReady' in window);
    const { adapter, fallback } = await page.evaluate(
      (opts) => (window as unknown as HarnessWindow).gemmaInit(opts),
      { maxNumTokens: MAX_NUM_TOKENS },
    );
    console.log(
      `[gemma] engine ready in ${((performance.now() - t0) / 1000).toFixed(1)}s ` +
        `(WebGPU: ${adapter}${fallback ? ' — software fallback' : ''}, context: ${MAX_NUM_TOKENS} tokens)`,
    );

    // First generation pays a one-time shader compile / weight conversion cost
    // (~25s observed); absorb it here so per-step timings are representative.
    const tWarm = performance.now();
    await page.evaluate(
      (args) => (window as unknown as HarnessWindow).gemmaAsk(args),
      {
        prompt: 'Reply with exactly: OK',
        system: 'You reply with exactly what is asked, nothing else.',
      },
    );
    console.log(
      `[gemma] warmup generation in ${((performance.now() - tWarm) / 1000).toFixed(1)}s`,
    );

    return {
      async ask(prompt, system) {
        const result = await page.evaluate(
          (args) => (window as unknown as HarnessWindow).gemmaAsk(args),
          { prompt, system },
        );
        const bench = result.bench;
        const stats = bench
          ? `prefill ${bench.lastPrefillTokenCount} tok @ ${bench.lastPrefillTokensPerSecond.toFixed(0)} tok/s, ` +
            `decode ${bench.lastDecodeTokenCount} tok @ ${bench.lastDecodeTokensPerSecond.toFixed(1)} tok/s, ` +
            `${(result.elapsedMs / 1000).toFixed(1)}s total`
          : `${(result.elapsedMs / 1000).toFixed(1)}s total`;
        return { text: result.text, stats };
      },
      async stop() {
        await launched.close();
        server.stop(true);
      },
    };
  } catch (err) {
    await browser?.close().catch(() => {});
    server.stop(true);
    throw err;
  }
}
