// @ss/gemma — local Gemma 4 (E2B, .litertlm) via LiteRT-LM's WebGPU-only Web
// API, split runtime-agnostic: this core owns the browser harness, the serving
// contract, model download/pin/verify, and client orchestration. A runtime
// supplies a HarnessHost adapter — Bun + Playwright in apps/web scripts today,
// an Electron BrowserWindow host in apps/desktop when it grows local inference.
export {
  createGemmaClient,
  type GemmaAskResult,
  type GemmaClient,
  type GemmaClientConfig,
  type HarnessHost,
} from './client';
export {
  type GemmaAskRaw,
  type GemmaInitResult,
  HARNESS_HTML,
  HARNESS_ROUTES,
  harnessAssetContentType,
  type HarnessWindow,
  litertAssetRoots,
  mergeEnableFeatures,
  resolvePackageFilePath,
  webgpuChromiumFlags,
} from './harness';
export {
  createProgressGate,
  defaultModelPath,
  ensureModel,
  type GemmaModelConfig,
} from './model';
export { DEFAULT_MODEL_SHA256, DEFAULT_MODEL_URL, MODEL_REVISION } from './model-pin';
