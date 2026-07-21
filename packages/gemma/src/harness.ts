// The browser side of the local Gemma stack: a self-contained page that loads
// LiteRT-LM's WebGPU runtime and exposes window.gemmaInit/gemmaAsk for a host
// to call over its page bridge (Playwright evaluate today, Electron IPC later).
import { createRequire } from 'node:module';
import { dirname, join, normalize, sep } from 'node:path';

/** Benchmark stats returned by a single harness generation. */
export interface GemmaAskRaw {
  text: string;
  elapsedMs: number;
  bench: {
    lastPrefillTokensPerSecond: number;
    lastPrefillTokenCount: number;
    lastDecodeTokensPerSecond: number;
    lastDecodeTokenCount: number;
    timeToFirstTokenInSecond: number;
  } | null;
}

/** Result of the harness's engine init: the WebGPU adapter it landed on. */
export interface GemmaInitResult {
  adapter: string;
  fallback: boolean;
}

/** Functions HARNESS_HTML installs on window; hand-kept mirror of the script below. */
export interface HarnessWindow {
  gemmaInit(opts: { maxNumTokens: number }): Promise<GemmaInitResult>;
  gemmaAsk(args: { prompt: string; system: string }): Promise<GemmaAskRaw>;
}

// The serving contract every host must implement at its origin root —
// HARNESS_HTML interpolates these paths into its importmap and module imports.
// `model` must send content-length (the engine reads it for load progress);
// `core`/`wasmUtils` are prefixes onto the litertAssetRoots() directories.
export const HARNESS_ROUTES = {
  harness: '/',
  model: '/model',
  core: '/core/',
  wasmUtils: '/wasm-utils/',
} as const;

export const HARNESS_HTML = `<!doctype html>
<title>@ss/gemma harness</title>
<script type="importmap">{"imports":{"@litertjs/wasm-utils":"${HARNESS_ROUTES.wasmUtils}dist/index.js"}}</script>
<script type="module">
import { Engine, SamplerType, loadLiteRtLm } from '${HARNESS_ROUTES.core}dist/index.js';

let engine;

window.gemmaInit = async ({ maxNumTokens }) => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter available in this browser context');
  const info = adapter.info;
  await loadLiteRtLm('${HARNESS_ROUTES.core}wasm/');
  engine = await Engine.create({
    model: '${HARNESS_ROUTES.model}',
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
    // maxOutputTokens mirrors the anthropic path's max_tokens: a greedy 2B
    // repetition loop must fail fast, not decode the whole 8k context.
    sessionConfig: {
      samplerParams: { type: SamplerType.GREEDY },
      maxOutputTokens: 1024,
    },
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
    return { text, elapsedMs, bench };
  } finally {
    await conversation.delete();
  }
};

window.gemmaReady = true;
</script>`;

/** Resolves an installed package's root directory via its package.json. */
function packageRoot(specifier: string, fromFile: string): string {
  return dirname(createRequire(fromFile).resolve(`${specifier}/package.json`));
}

/** Locates the on-disk LiteRT runtime dirs the harness routes are served from. */
export function litertAssetRoots(): {
  coreRoot: string;
  wasmUtilsRoot: string;
} {
  const coreRoot = packageRoot('@litert-lm/core', import.meta.url);
  // wasm-utils is core's own dependency, so resolve it from core's context.
  const wasmUtilsRoot = packageRoot(
    '@litertjs/wasm-utils',
    join(coreRoot, 'package.json'),
  );
  return { coreRoot, wasmUtilsRoot };
}

/** Resolves a request path inside a package root, refusing path traversal. */
export function resolvePackageFilePath(
  root: string,
  rest: string,
): string | null {
  const path = normalize(join(root, rest));
  if (path !== root && !path.startsWith(root + sep)) return null;
  return path;
}

/** Maps a harness asset path to a content-type, or null for the host's fallback. */
export function harnessAssetContentType(path: string): string | null {
  if (path.endsWith('.wasm')) return 'application/wasm';
  if (path.endsWith('.js')) return 'text/javascript';
  return null;
}

/** Chromium switches that expose a hardware WebGPU adapter for the harness. */
export function webgpuChromiumFlags(platform: string): string[] {
  const base = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  // macOS: ANGLE Metal. Linux (e.g. a GPU CI runner): the Vulkan recipe.
  return platform === 'darwin'
    ? [...base, '--use-angle=metal']
    : [
        ...base,
        '--enable-features=Vulkan',
        '--use-angle=vulkan',
        '--disable-vulkan-surface',
      ];
}

/** Merges repeated --enable-features switches — Chromium keeps only the last. */
export function mergeEnableFeatures(flags: string[]): string[] {
  const features = flags.filter((f) => f.startsWith('--enable-features='));
  if (features.length <= 1) return flags;
  const merged = [
    ...new Set(
      features.flatMap((f) => f.slice('--enable-features='.length).split(',')),
    ),
  ]
    .filter(Boolean)
    .join(',');
  return [
    ...flags.filter((f) => !f.startsWith('--enable-features=')),
    `--enable-features=${merged}`,
  ];
}
