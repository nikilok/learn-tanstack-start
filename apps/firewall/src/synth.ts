// Launcher for the cassette synthesiser, which lives in the private ops repo.
//
// Only the entrypoint is here. The scenarios, the findings and the generated corpora stay in
// sponsorsearch-ops — a generator that outputs working bypasses is a stronger map than any
// threshold. This exists so the command is `bun run firewall:synth` like every other one, rather
// than something you can only run after cd-ing into another repo.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  OPS_PATH_KEY,
  configuredOpsPath,
  opsRepoDir,
} from './mock/cassette-store';
import { errMsg } from './util';

const TOOL = join('firewall-redteam', 'synthesise.ts');

async function main() {
  const ops = configuredOpsPath() ?? opsRepoDir();
  if (!ops)
    throw new Error(
      `Could not find the ops repo, which holds ${TOOL}.\n` +
        `Set its absolute path as ${OPS_PATH_KEY} in the repo-root .env.local.`,
    );
  const tool = join(ops, TOOL);
  if (!existsSync(tool)) {
    // Listing is diagnostics, and it must not become the error: readdir on a path that does not
    // exist throws ENOENT, which replaced this message with a scandir stack.
    let has = '';
    try {
      has = `\nIt has: ${readdirSync(ops)
        .filter((e) => !e.startsWith('.'))
        .join(', ')}`;
    } catch {
      has = '\nThat directory could not be read.';
    }
    throw new Error(`${tool} is missing.${has}`);
  }
  // argv is passed through untouched, so the tool parses exactly what it would standalone.
  await import(tool);
}

main().catch((error) => {
  console.error(errMsg(error));
  process.exit(1);
});
