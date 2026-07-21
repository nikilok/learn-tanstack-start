import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

import {
  harnessAssetContentType,
  litertAssetRoots,
  resolvePackageFilePath,
} from './harness';

describe('resolvePackageFilePath', () => {
  const root = join(sep, 'srv', 'pkg');

  test('resolves files inside the root', () => {
    expect(resolvePackageFilePath(root, 'dist/index.js')).toBe(
      join(root, 'dist', 'index.js'),
    );
  });

  test('refuses .. traversal out of the root', () => {
    expect(resolvePackageFilePath(root, '../secret')).toBeNull();
  });

  test('refuses traversal hidden behind inner segments', () => {
    expect(resolvePackageFilePath(root, 'dist/../../other')).toBeNull();
  });

  test('refuses sibling dirs sharing the root as a name prefix', () => {
    expect(resolvePackageFilePath(root, '../pkg-evil/file')).toBeNull();
  });
});

describe('harnessAssetContentType', () => {
  test('wasm and js get explicit types', () => {
    expect(harnessAssetContentType('core/wasm/a.wasm')).toBe(
      'application/wasm',
    );
    expect(harnessAssetContentType('dist/index.js')).toBe('text/javascript');
  });

  test('anything else falls back to the host', () => {
    expect(harnessAssetContentType('dist/index.d.ts')).toBeNull();
  });
});

describe('litertAssetRoots', () => {
  test('resolves the runtime dirs the harness routes serve from', () => {
    const { coreRoot, wasmUtilsRoot } = litertAssetRoots();
    expect(existsSync(join(coreRoot, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(coreRoot, 'wasm'))).toBe(true);
    expect(existsSync(join(wasmUtilsRoot, 'dist', 'index.js'))).toBe(true);
  });
});
