#!/bin/sh
# Vercel's Ignored Build Step for @ss/web.
#
# Exit 0 SKIPS the build. Any non-zero exit BUILDS. Every failure path here exits non-zero on
# purpose: a needless build costs a few minutes, a wrongly skipped one costs a production change
# that silently never shipped, and nothing reports the second kind.
#
# Lives in a file because `vercel.json`'s `ignoreCommand` is capped at 256 characters — a limit
# that is only reported once the deployment fails schema validation, with no local check.
#
# `git diff --name-only` prints paths relative to the repository root whatever the Root Directory
# setting is, so the patterns below are repo-root-relative even though this runs under apps/web.

set -u

# The last commit Vercel actually deployed for this branch, NOT HEAD^. A push is many commits, and
# comparing only the last one skipped the build for everything behind it — a web change followed by
# a docs or firewall commit was dropped. Empty on a branch's first deployment, so fall back.
BASE=${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}

# A range git cannot resolve — a shallow clone without HEAD^, a SHA from a force-pushed branch —
# used to produce an empty diff, which then read as "nothing changed" and skipped. A build that
# cannot tell what changed must build.
CHANGED=$(git diff --name-only "$BASE" HEAD) || exit 1
[ -z "$CHANGED" ] && exit 1

# Paths that cannot affect this app's build output. @ss/web depends on @ss/db and @ss/skyline only,
# so the other workspaces are irrelevant to it.
#
# Deliberately NOT listed: .gitignore, the root package.json, bun.lock and turbo.json. Each is at
# least arguable, they change rarely, and the cost of being wrong is asymmetric.
IGNORED='^(docs/|apps/(firewall|desktop|ch-stream)/|packages/gemma/|\.github/|\.claude/|\.coderabbit\.yaml$|README\.md$)'

# Anything outside the list means build. `grep -q` exits 0 when it finds such a path.
echo "$CHANGED" | grep -qvE "$IGNORED" && exit 1

exit 0
