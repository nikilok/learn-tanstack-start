// The one depth-sensitive path in the tool. Everything that needs the repo root derives from here.
//
// A `new URL('../..', import.meta.url)` breaks silently when its file moves — a deny once landed in
// apps/.env.local while the rules kept rebuilding from the untouched root file, so the next apply
// LIFTED the ban and reported success. One copy, locked by a marker test.

import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Files that only exist at the repo root, so a test can assert the path by what is there rather than by counting `../`. */
export const ROOT_MARKERS = ['turbo.json', 'bun.lock'] as const;
