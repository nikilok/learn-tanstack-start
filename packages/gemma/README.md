# @ss/gemma

Runs Gemma 4 (E2B, `.litertlm` web build) fully locally via Google's LiteRT-LM
Web API (`@litert-lm/core`). The runtime is WebGPU-only, so inference always
happens in a Chromium page — this package is the runtime-agnostic core, and a
runtime supplies a `HarnessHost` adapter that owns the page.

## Split

- **Core (this package)** — the browser harness (`HARNESS_HTML`) and its
  serving contract (`HARNESS_ROUTES`, `litertAssetRoots`,
  `resolvePackageFilePath`, `harnessAssetContentType`), model
  download/pin/verify (`ensureModel`, `src/model-pin.ts`), and client
  orchestration (`createGemmaClient(host, config)`: init, warmup, timeouts,
  stats).
- **Hosts (per runtime)** — implement `HarnessHost`
  (`load(modelPath)`/`init`/`ask`/`dispose`): serve the harness routes at an
  origin root — the model path arrives via `load`, after the core has verified
  it — load the page in a WebGPU-capable Chromium, and bridge
  `window.gemmaInit`/`gemmaAsk`.
  - `apps/web/scripts/lib/gemma-host-playwright.ts` — Bun.serve on loopback +
    Playwright headless Chromium; used by the HMRC CSV discovery script and
    the scheduled ingestion workflow.
  - Electron (planned) — a hidden `BrowserWindow` + `protocol.handle` + IPC in
    `apps/desktop`, running the same harness on the same engine.

## CI coupling

The HMRC ingestion workflow's model cache key is
`hashFiles('packages/gemma/src/model-pin.ts')` — bump the model revision and
sha256 together in that file and the 2GB cache rolls with it. Never hand-write
the cache key.
