# learn-tanstack-start

> Replace each section. Target 50–100 lines total. INFO.md is injected
> into every AI scan batch — verbose context dilutes signal.
> See `SETUP.md` for the rubric + a coding-agent prompt.

## What this codebase does

<one paragraph: what the app does, what stack, what users it serves>

## Auth shape

<the 3–5 most important auth primitives BY NAME. The scanner doesn't
need every helper — just enough to recognize when one is missing>

## Threat model

<2–4 sentences: what an attacker would want, ranked by impact.
Skip generic security boilerplate>

## Project-specific patterns to flag

<3–5 patterns unique to THIS codebase, one example each. Avoid
generic CWE categories — built-in matchers cover those>

## Known false-positives

- **Command injection is not a vector.** Scripts and server code use `fetch()`,
  Bun-native Postgres bindings, and `Bun.CryptoHasher` — they never shell out
  via `child_process.exec`/`spawn`. Don't construct shell-injection payloads
  against URL/argv inputs; they never reach a shell.
- **`computeHash` in `apps/web/scripts/ingest-hmrc-csv.ts` uses a `|`-joined
  sha256 as a stable slug ID** for company URLs. Hash stability is a hard
  requirement — bookmarks, slugs, and external references depend on it. The
  theoretical `|` collision case is an accepted risk: HMRC sponsor data
  contains no `|` in any field. Do not flag this as a dedup bug.

<3–5 paths/patterns that look risky but are intentional —
fork-specific stubs, dev fixtures, intended-public endpoints>
