# @ss/desktop

Native desktop client for [SponsorSearch](https://sponsorsearch.co.uk) — an Electron
**thin wrapper** that loads the hosted site in a Chromium window. There is no local
server or database: all data comes from the same remote server the website uses.
Electron is chosen over Tauri so every platform renders in Chromium (the engine the
web app is tuned for), keeping the WebKit/Safari workarounds dormant.

## Develop

```bash
bun --filter @ss/desktop dev      # launches the app pointed at production
```

Override the target with `DESKTOP_APP_URL` (e.g. `DESKTOP_APP_URL=https://web.local bun --filter @ss/desktop dev`).

- `src/main/` — main process: window, hardened `webPreferences`, external-link
  handling, native menu, auto-update.
- `src/preload/` — exposes only `window.isSponsorSearchDesktop` (CommonJS — required
  for a sandboxed preload).
- The renderer is the remote site; there is no local renderer bundle.

## Package locally

```bash
bun --filter @ss/desktop package:dir   # unpacked app for the current OS (unsigned)
bun --filter @ss/desktop package       # installer for the current OS (unsigned)
```

Output lands in `apps/desktop/dist/`.

## Release (CI)

Push a tag `vX.Y.Z` (matching `package.json` `version`, bumped via `bun pm version`).
`.github/workflows/desktop-release.yml` builds the macOS / Windows / Linux installers,
signs + notarizes them, and uploads them to a GitHub Release. electron-builder creates
a **draft** release — review it and click *Publish* to make the `/download` links and
auto-update go live.

Stable, version-less artifact names (`SponsorSearch-mac-universal.dmg`,
`SponsorSearch-win-x64.exe`, `SponsorSearch-linux-x64.AppImage`) keep the
`releases/latest/download/<file>` links on the site's `/download` page stable.

### Required repository secrets

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | base64 Developer ID Application `.p12` + password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarization |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows code-signing `.pfx` + password (optional for v1) |

`GITHUB_TOKEN` is provided automatically. Without the Apple secrets a tagged macOS
build fails at the signing step (notarization needs a signed app) — set them before
tagging, or use **Run workflow** (manual dispatch) for an unsigned cross-platform
smoke build.
