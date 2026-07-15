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
workflow**. Every dispatch first runs a **resolve** gate that validates the inputs and
computes the per-OS build matrix from the `build_mac` / `build_win` / `build_linux`
toggles (defaults: mac + win on, linux off). There are two modes:

- **Bump (default)** — pick a semver bump (`patch` / `minor` / `major`). Dispatch from
  `main` only (the bump PR would squash-merge any other ref into `main` wholesale).
  Release notes ship from the `## Unreleased` section of `apps/desktop/CHANGELOG.md` —
  write them there (ideally in the PR that makes the change) and the release archives
  the section under the new version's header in the same bump commit, leaving
  `Unreleased` empty for the next cycle. Empty `Unreleased` ⇒ the release ships without
  notes (with a run warning); the run summary always shows exactly what was picked up. A
  non-empty notes input overrides the changelog and leaves it untouched — but GitHub's
  dispatch field is single-line, so multiline overrides need `gh workflow run`.
- **Re-release an existing version** — tick **Rebuild an existing version** and set
  **manual_version** (e.g. `0.1.5`). No bump: the **version** job is skipped and
  **build** checks out the existing `vX.Y.Z` tag, rebuilds only the ticked OSes, and
  upserts them onto the existing release row (notes preserved). Use it to add an OS to a
  shipped version (e.g. Linux for `0.1.5`) or reissue one platform. Allowed from **any
  branch** (it builds an immutable tag and does no bump/PR), so you can iterate a build
  fix without merging to `main` first. See "Re-release an existing version" below.

`.github/workflows/desktop-release.yml` then:

1. **version** (bump mode only) — `bun pm version <bump>` on `apps/desktop`, commits the
   bump + the archived changelog and tags `vX.Y.Z` on a `release/desktop-vX.Y.Z` branch,
   then opens a PR and merges it back into `main` (auto-merge when checks gate it, direct
   merge otherwise). If the PR can't merge, the job deletes the pushed branch + tag and
   fails, so a re-dispatch starts clean.
2. **build** (matrix = the ticked OSes) — checks out `vX.Y.Z` (the fresh tag in bump
   mode, the existing tag in manual mode) and builds each ticked platform's variants
   (mac dmg arm64·x64·universal + universal zip; Windows nsis x64·arm64 in User + System;
   Linux AppImage + deb x64 to start, growing to rpm/arm64 as they prove green), uploads
   them to **Vercel Blob**, and records the release + per-variant URLs in the DB via
   `POST /api/releases`.

If the **version** job fails, its rollback deletes the pushed branch + tag — fix the
cause and re-dispatch. If **build** jobs fail *after* the bump merged, use **Re-run
failed jobs** on the same run (version, tag, and resolved notes are all preserved,
and uploads upsert idempotently); a fresh dispatch would mint a new version from a
`main` whose `Unreleased` was already archived and ship noteless — if you must
re-dispatch, move the archived section body back under `## Unreleased` first. Notes
merged to `main` mid-release are flagged by a run warning (they'd otherwise vanish
into the just-archived section).

### Re-release an existing version

Tick **Rebuild an existing version**, set **manual_version** to a released version, and
pick the OSes. `resolve` verifies the `vX.Y.Z` tag exists and whether it's the newest
tag (for the updater feed). `build` then:

- Checks out the **existing tag** so the artifact reproduces that version's source, and
  **overlays the current `scripts/upload-release.ts`** from the dispatched commit (the
  tag carries the old one). Keep that script a single self-contained file (only
  `@vercel/blob` + node builtins) or the overlay breaks against older tags.
- Builds only the ticked OSes. **Linux fixes are workflow/runner-level only** —
  `electron-builder.yml` stays frozen at the tag, so Linux targets/arch come from the
  `electron-builder --linux …` CLI flags in the build step and any missing tooling is
  `apt-get`'d there.
- Uploads to a fresh timestamp-prefixed blob folder (never overwrites prior uploads) and
  upserts onto the existing `desktop_releases` row — **existing notes are preserved** and
  visibility is untouched (adding assets to an already-public version makes them appear
  on `/download` after the cache purge).
- **Update-feed downgrade guard:** the overwritten `downloads/latest/` feed is mirrored
  only when `manual_version` is the newest tag; re-releasing an older version logs a
  warning and leaves the feed alone (`RELEASE_SKIP_FEED`).

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
