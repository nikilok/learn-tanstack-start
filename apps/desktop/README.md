# @ss/desktop

Native desktop client for [SponsorSearch](https://sponsorsearch.co.uk) — an Electron
**thin wrapper** that loads the hosted site in a Chromium window. There is no local
server or database: all data comes from the same remote server the website uses.
Electron is chosen over Tauri so every platform renders in Chromium (the engine the
web app is tuned for), keeping the WebKit/Safari workarounds dormant.

## Develop

```bash
bun --filter @ss/desktop dev      # launches the app pointed at https://web.local (start the web dev server first)
```

Override the target with `DESKTOP_APP_URL` (e.g. `DESKTOP_APP_URL=https://sponsorsearch.co.uk bun --filter @ss/desktop dev` to point dev at production). Packaged builds default to production.

- `src/main/` — main process: window, hardened `webPreferences`, external-link
  handling, native menu, auto-update.
- `src/preload/` — exposes `window.isSponsorSearchDesktop` (shell marker) + the
  `window.ssDesktop` command bridge (`onCommand`/`reportCursor`/`pokeTheme`/`copy`)
  (CommonJS — required for a sandboxed preload).
- `src/renderer/` — the custom title bar's small local React bundle; the main
  site view itself is the remote site (no local site bundle).

## Package locally

```bash
bun --filter @ss/desktop package:dir   # unpacked app for the current OS (unsigned)
bun --filter @ss/desktop package       # installer for the current OS (unsigned)
```

Output lands in `apps/desktop/dist/`.

## Release (CI)

Releases are **manually triggered**: GitHub → Actions → **Desktop App** → **Run
workflow** → pick a semver bump (`patch` / `minor` / `major`). Dispatch from `main`
only — the version job refuses any other ref (its bump PR would squash-merge that
entire ref into `main`). Release notes ship from the `## Unreleased` section of
`apps/desktop/CHANGELOG.md` — write them there (ideally in the PR that makes the
change) and the release archives the section under the new version's header in the
same bump commit, leaving `Unreleased` empty for the next cycle. Empty `Unreleased`
⇒ the release ships without notes (with a run warning); the run summary always shows
exactly what was picked up. A non-empty notes input overrides the changelog and
leaves it untouched — but GitHub's dispatch field is single-line, so multiline
overrides need `gh workflow run`. `.github/workflows/desktop-release.yml` then:

1. **version** — `bun pm version <bump>` on `apps/desktop`, commits the bump + the
   archived changelog and tags `vX.Y.Z` on a `release/desktop-vX.Y.Z` branch, then
   opens a PR and merges it back into `main` (auto-merge when checks gate it, direct
   merge otherwise). If the PR can't merge, the job deletes the pushed branch + tag
   and fails, so a re-dispatch starts clean.
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
succeeds, unsigned). The **version** job never pushes `main` directly: it pushes a
release branch + tag and merges a bump PR, which the default `GITHUB_TOKEN` can do on
a protected `main` — unless the ruleset requires status checks (`GITHUB_TOKEN` PRs
never trigger Actions runs, so the merge poll would time out, roll back, and fail;
that setup needs a PAT/app token instead). Also set `BLOB_PUBLIC_BASE` in the Vercel
project env so the `/downloads/...` route resolves to Blob.
