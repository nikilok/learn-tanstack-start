import { appendFileSync } from 'node:fs';

/**
 * Publish one `key=value` pair to $GITHUB_OUTPUT.
 *
 * Appends, and does so synchronously. `Bun.file().writer()` starts at byte 0
 * every call, so two outputs from one script overwrote each other in place and
 * left a corrupt key ("written=567\nnsors=1234"). $GITHUB_OUTPUT is an
 * append-only file by contract, and a script may legitimately set several.
 */
export function setGitHubOutput(key: string, value: string) {
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    appendFileSync(ghOutput, `${key}=${value}\n`);
  }
}
