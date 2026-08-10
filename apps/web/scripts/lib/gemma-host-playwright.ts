// Bun + Playwright HarnessHost for @ss/gemma: a loopback Bun.serve hands the
// page the harness, the LiteRT runtime + wasm, and the model file; WebGPU-
// enabled headless Chromium runs the inference. No data leaves the machine.
//
// Env: GEMMA_MODEL_PATH (default ~/.cache/litert-lm/<model>-<revision>.litertlm),
//      GEMMA_MODEL_URL (download used when the file is missing; overriding skips
//      the sha256 check unless GEMMA_MODEL_SHA256 is also set),
//      GEMMA_MAX_TOKENS (context budget, default 8192), GEMMA_DEBUG=1 (browser logs),
//      GEMMA_CHROMIUM_FLAGS (extra space-separated Chromium args, e.g. CI GPU experiments).
import {
  createGemmaClient,
  createProgressGate,
  DEFAULT_MODEL_SHA256,
  DEFAULT_MODEL_URL,
  defaultModelPath,
  type GemmaClient,
  type GemmaClientConfig,
  HARNESS_HTML,
  HARNESS_ROUTES,
  harnessAssetContentType,
  type HarnessHost,
  type HarnessWindow,
  litertAssetRoots,
  mergeEnableFeatures,
  resolvePackageFilePath,
  webgpuChromiumFlags,
} from '@ss/gemma';
import { type Browser, chromium, type Page } from 'playwright';

import { parseStrictInt } from './script-utils';

const DEBUG = process.env.GEMMA_DEBUG === '1';

/** Engine context budget when GEMMA_MAX_TOKENS is unset. Exported so callers
 *  sizing prompts against the window share the number instead of re-guessing. */
export const DEFAULT_GEMMA_MAX_TOKENS = 8192;

/** Reads an env var, treating unset/empty/whitespace values as undefined. */
function envStr(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Builds the client config from GEMMA_* env vars. */
function readEnvConfig(): GemmaClientConfig {
  const rawMaxTokens = envStr('GEMMA_MAX_TOKENS');
  // parseStrictInt rejects coercing forms ('8e3', '0x2000') with a labeled
  // error; createGemmaClient owns the positivity check at the API boundary.
  const maxNumTokens = rawMaxTokens
    ? parseStrictInt(rawMaxTokens, 'GEMMA_MAX_TOKENS')
    : DEFAULT_GEMMA_MAX_TOKENS;
  return {
    model: {
      path: envStr('GEMMA_MODEL_PATH') ?? defaultModelPath(),
      url: envStr('GEMMA_MODEL_URL') ?? DEFAULT_MODEL_URL,
      sha256:
        envStr('GEMMA_MODEL_SHA256') ??
        (envStr('GEMMA_MODEL_URL') ? null : DEFAULT_MODEL_SHA256),
      // Local runs trust the once-verified download (hashing 2GB costs ~6s);
      // CI restores from actions/cache, where key/revision drift or a stale
      // entry would otherwise run silently — verify there, self-heal on mismatch.
      verifyCached: Boolean(process.env.CI || process.env.GEMMA_VERIFY === '1'),
    },
    maxNumTokens,
  };
}

/** The harness WebGPU switch recipe plus GEMMA_CHROMIUM_FLAGS extras, merged. */
function webgpuFlags(): string[] {
  const extra = (envStr('GEMMA_CHROMIUM_FLAGS') ?? '')
    .split(/\s+/)
    .filter(Boolean);
  // Merge --enable-features so an extra flag can't silently drop the platform's.
  return mergeEnableFeatures([
    ...webgpuChromiumFlags(process.platform),
    ...extra,
  ]);
}

/** Serves a file from within a package root, refusing path traversal. */
function servePackageFile(root: string, rest: string): Response {
  const path = resolvePackageFilePath(root, rest);
  if (!path) return new Response('forbidden', { status: 403 });
  const file = Bun.file(path);
  const type =
    harnessAssetContentType(path) ?? file.type ?? 'application/octet-stream';
  return new Response(file, { headers: { 'content-type': type } });
}

/** Serves the harness, runtime assets, and model over loopback for one host. */
function startAssetServer(modelPath: string) {
  const { coreRoot, wasmUtilsRoot } = litertAssetRoots();
  const model = Bun.file(modelPath);
  const progress = createProgressGate();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === HARNESS_ROUTES.harness) {
        return new Response(HARNESS_HTML, {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (pathname === HARNESS_ROUTES.model) {
        let sent = 0;
        const counter = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            sent += chunk.byteLength;
            const step = progress(Math.floor((sent / model.size) * 100));
            if (step !== null) {
              console.log(`[gemma] model → browser ${step}%`);
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
      if (pathname.startsWith(HARNESS_ROUTES.core)) {
        return servePackageFile(
          coreRoot,
          pathname.slice(HARNESS_ROUTES.core.length),
        );
      }
      if (pathname.startsWith(HARNESS_ROUTES.wasmUtils)) {
        return servePackageFile(
          wasmUtilsRoot,
          pathname.slice(HARNESS_ROUTES.wasmUtils.length),
        );
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { server, modelSize: model.size };
}

/** HarnessHost that boots the harness in Playwright's WebGPU-enabled Chromium. */
export function createPlaywrightHost(): HarnessHost {
  let server: ReturnType<typeof startAssetServer>['server'] | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  return {
    async load(modelPath) {
      // A second load would strand the first server/browser with no handle.
      if (server || browser) {
        throw new Error('Playwright Gemma host is already loaded');
      }
      const assets = startAssetServer(modelPath);
      server = assets.server;
      console.log(
        `[gemma] model: ${modelPath} (${(assets.modelSize / 1e9).toFixed(2)} GB)`,
      );
      browser = await chromium.launch({ headless: true, args: webgpuFlags() });
      const opened = await browser.newPage();
      opened.on('pageerror', (err) =>
        console.error('[gemma:browser]', err.message),
      );
      opened.on('console', (msg) => {
        // LiteRT's glog chatter (I…/W…/INFO:/WARNING: lines) lands on console.error; keep it debug-only.
        const isGlogNoise = /^(?:INFO:|WARNING:|[IW]\d{4})/.test(msg.text());
        if (DEBUG || (msg.type() === 'error' && !isGlogNoise)) {
          console.log(`[gemma:browser:${msg.type()}]`, msg.text());
        }
      });
      await opened.goto(`http://127.0.0.1:${assets.server.port}/`, {
        waitUntil: 'domcontentloaded',
      });
      await opened.waitForFunction(() => 'gemmaReady' in window);
      page = opened;
    },
    async init(opts) {
      if (!page) throw new Error('Gemma harness is not loaded');
      return page.evaluate(
        (o) => (window as unknown as HarnessWindow).gemmaInit(o),
        opts,
      );
    },
    async ask(args) {
      if (!page) throw new Error('Gemma harness is not loaded');
      return page.evaluate(
        (a) => (window as unknown as HarnessWindow).gemmaAsk(a),
        args,
      );
    },
    async dispose() {
      await browser?.close().catch(() => {});
      browser = undefined;
      page = undefined;
      await server?.stop(true).catch(() => {});
      server = undefined;
    },
  };
}

/** Env-configured Gemma client on the Playwright host (Bun scripts / CI). */
export async function createPlaywrightGemmaClient(): Promise<GemmaClient> {
  const config = readEnvConfig();
  return createGemmaClient(createPlaywrightHost(), config);
}
