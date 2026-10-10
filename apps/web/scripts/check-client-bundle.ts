/**
 * Fails the build when the Ask engine reaches the browser. The engine's
 * barrel refuses to load where a window exists, and that refusal's text is
 * the sentinel: no file the client output ships may carry it.
 *
 *   bun scripts/check-client-bundle.ts   (after vite build)
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Glob } from 'bun';

const SENTINEL = '@nikilok/thoth-engine is server-only';
const CLIENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../.vercel/output/static',
);

let scanned = 0;
const carriers: string[] = [];
for await (const file of new Glob('**/*.{js,mjs}').scan({ cwd: CLIENT_DIR })) {
  scanned++;
  if ((await Bun.file(join(CLIENT_DIR, file)).text()).includes(SENTINEL))
    carriers.push(file);
}
if (!scanned) {
  console.error(`No client scripts under ${CLIENT_DIR}: did the output move?`);
  process.exit(1);
}
if (carriers.length) {
  console.error(
    `The engine reached the client bundle:\n  ${carriers.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`Client bundle clean: ${scanned} scripts, none carry the engine.`);
