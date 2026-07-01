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
- `src/preload/` — exposes `window.isSponsorSearchDesktop` (shell marker) + the
  `window.ssDesktop` command bridge (`onCommand`/`reportCursor`/`pokeTheme`/`copy`)
  (CommonJS — required for a sandboxed preload).
- The renderer is the remote site; there is no local renderer bundle.

## Package locally

```bash
bun --filter @ss/desktop package:dir   # unpacked app for the current OS (unsigned)
bun --filter @ss/desktop package       # installer for the current OS (unsigned)
```

Output lands in `apps/desktop/dist/`.

## Release (CI)

Releases are **manually triggered**: GitHub → Actions → **Desktop App** → **Run
workflow** → pick a semver bump (`patch` / `minor` / `major`).
`.github/workflows/desktop-release.yml` then:

1. **version** — `bun pm version <bump>` on `apps/desktop`, commits + tags `vX.Y.Z`,
   pushes to the branch.
2. **build** (matrix mac / win / linux) — builds every variant (mac dmg
   arm64·x64·universal + universal zip; Windows nsis x64·arm64 in User + System;
   Linux AppImage·deb·rpm × arch), uploads them to **Vercel Blob**, and records the
   release + per-variant URLs in the DB via `POST /api/releases`.

Downloads are served from `sponsorsearch.co.uk/downloads/...` (a Nitro route that
redirects to Blob) and listed on `/download` straight from the DB — no GitHub
Releases. Auto-update reads a **generic** electron-updater feed at `/downloads/latest/`
(the universal-zip mac / user-nsis / AppImage subset). Artifact names encode arch +
install-scope (`SponsorSearch-mac-arm64.dmg`, `SponsorSearch-win-x64-user.exe`,
`SponsorSearch-linux-arm64.deb`, …) so `scripts/upload-release.ts` can parse each.

### Required repository secrets

| Secret | Purpose |
| --- | --- |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob upload token (also set as a Vercel project env) |
| `DESKTOP_RELEASE_SECRET` | shared secret for `POST /api/releases` (also a Vercel env) |
| `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | base64 Developer ID Application `.p12` + password |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarization |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows code-signing `.pfx` + password (optional) |

Signing + notarization are skipped when those secrets are absent (the build still
succeeds, unsigned). The **version** job pushes a commit + tag, so the branch it runs
on must permit that push (a protected `main` needs a PAT/app token). Also set
`BLOB_PUBLIC_BASE` in the Vercel project env so the `/downloads/...` route resolves to Blob.
