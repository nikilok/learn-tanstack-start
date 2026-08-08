# Changelog

Write the next release's notes under `## Unreleased` (ideally in the same PR
as the change; `### Subheadings` are fine). The release workflow ships that
section to [/download](https://sponsorsearch.co.uk/download) and archives it
here under the version's header — only edit `Unreleased` by hand. Full flow:
[README.md](./README.md).

## Unreleased

- **A proper screen when the site can't be reached** — if you lose your connection, or SponsorSearch briefly stops answering because you have been searching hard enough to trip its rate limit, the app no longer drops you on a bare "Forbidden" page. It shows its own screen instead, drawn entirely inside the app so it works with no connection at all: what happened, a countdown to the next check, and a "Try now" button. The app keeps checking in the background and puts you back on the page you were reading the moment it can, with nothing to click.
- **Something to do while you wait** — that screen comes with a small game. Press Space and the SponsorSearch lens sets off across a skyline you have to jump; your best score is kept between visits. Entirely optional, and it stops the moment your page comes back.

- **Update checks include your app version** — when SponsorSearch checks for or downloads a new release it now sends the version you are running, so we can see which versions update cleanly and which get stuck on an old build. It goes into our server logs along with the request, is deleted with them, and is not tied to any account. Nothing about how updates work has changed.

## v0.4.0 — 2026-07-28

- **Screensaver** — leave SponsorSearch alone for a minute and the app dissolves away, leaving its own backdrop behind with a slow drifting coil of particles on top: blue through violet on the dark theme, with the brand red running out along its tentacles, and the full amber-to-blue rail spectrum on the light one. Points of light wander through the scene around it, blooming and sharpening as they drift through focus. The curve itself is a tweet-length Processing sketch by @yuruyurau, credited on screen. The title bar and window buttons step aside so it has the whole window to itself. Move the mouse or press any key and you are straight back where you were.
- **Cleaner home title** — the title bar now reads "UK Sponsor Search" on the home page instead of echoing the website's full SEO title, matching the site's new branding.

## v0.3.0 — 2026-07-24

- **Filter the register from the title bar** — a new sliders button (next to Share) opens SponsorSearch's filters: visa routes, licence ratings, cities, industries, incorporation dates, company status and health signals. Your choices stick until you reset them, and a small badge on the icon counts the filters currently shaping your list — kept in sync wherever you are in the app.
- **`⌘⇧F` for filters** — open the filters page without reaching for the mouse (`Ctrl+Shift+F` on Windows & Linux; hover the button for the keycap tooltip). The page itself is fully keyboard-drivable from there: `⌥1`–`⌥9` jump straight to a section, `⌘↵` applies, `R` resets, and `Esc` takes you back to where you were.
- **Linux update prompts** — `.deb` (Debian/Ubuntu) and `.rpm` (Fedora) installs can't update themselves in place, so SponsorSearch now checks for new releases and shows a prompt linking to the download page, instead of silently staying on an old version.

## v0.2.1 — 2026-07-17

- **Fixed macOS auto-updates** — 0.2.0 couldn't install its own updates on Apple Silicon or Intel Macs (a packaging mismatch: it shipped a universal update package the updater couldn't match to your Mac's architecture). Now fixed with per-architecture packages, so updates apply cleanly again. Windows and Linux were unaffected — and if you're updating from 0.1.5 on a Mac, this also brings the full 0.2.0 title-bar refresh.

## v0.2.0 — 2026-07-17

A polish pass on the native title bar — flatter, more keyboard-driven, and easier to read.

- **Redesigned title bar** — a cleaner, flatter chrome: the pills and dividers around the logo, back/forward arrows, and page title are gone, the wordmark is larger, and the share / cursor / theme buttons now sit together at the top-right with spacing that matches the web app.
- **Keyboard shortcuts** — get around without the mouse: `⌘[` / `⌘]` go back / forward (`Ctrl+[` / `Ctrl+]` on Windows & Linux), and `⌘⇧S` / `⌘⇧C` / `⌘⇧D` trigger Share, the custom cursor, and the theme toggle.
- **Keycap tooltips** — hover any title-bar button to see what it does and its shortcut, drawn as little keycaps that follow your light / dark theme.
- **Smarter page title** — the title centers in the space between the arrows and the icons, showing in full whenever it fits and shortening with an ellipsis only when it genuinely can't.
- **Scroll blur** — page content softly blurs into the title bar as you scroll, so the two read as one continuous surface.
- **Matching cursor button** — the custom-cursor toggle now uses the same icon as the web app (solid when on, dotted when off).
- **Fixes** — no more border flash on the title bar when switching themes, no stray blur lingering after you return home, and clicks near the title bar land where you expect.

## v0.1.3 — 2026-07-03

The first public build of the SponsorSearch desktop app.

Everything from [sponsorsearch.co.uk](https://sponsorsearch.co.uk) in its own native window — search the full HMRC register of licensed UK visa sponsors, enriched with Companies House data — plus the desktop touches:

- **Native experience** — custom title bar, native menus and shortcuts, and external links open in your default browser.
- **Auto-updates** — future releases download in the background and apply when you relaunch, so this is the last version you'll ever need to install by hand.
- **Mac and Windows** — macOS (Apple Silicon + Intel) and Windows x64/ARM64 (per-user or system-wide installers).

This is release one — fixes and improvements will arrive automatically from here on.
