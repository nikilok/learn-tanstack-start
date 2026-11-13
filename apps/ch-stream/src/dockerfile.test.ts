import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../..');

/** The workspaces bun.lock lists, the root aside: a frozen install refuses unless every one's manifest is on disk. */
function lockedWorkspaces(): string[] {
  const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf8');
  const block = lock.match(/"workspaces":\s*\{([\s\S]*?)\n {2}\}/);
  if (!block) throw new Error('bun.lock lists no workspaces');
  return [...block[1].matchAll(/^ {4}"([^"]+)":\s*\{/gm)]
    .map((m) => m[1])
    .filter((name) => name !== '');
}

describe('the image', () => {
  test('copies every workspace manifest the lockfile lists, so its frozen install never refuses one it cannot see', () => {
    const dockerfile = readFileSync(
      join(import.meta.dir, '../Dockerfile'),
      'utf8',
    );
    const workspaces = lockedWorkspaces();
    expect(workspaces.length).toBeGreaterThan(1);
    for (const workspace of workspaces) {
      expect(dockerfile).toContain(
        `COPY ${workspace}/package.json ${workspace}/package.json`,
      );
    }
  });
});
