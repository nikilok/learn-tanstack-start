import { describe, expect, test } from 'bun:test';

import { nextSceneLast, sceneShown } from './empty-state';

const gpu = () => true;
const noGpu = () => false;

describe('nextSceneLast', () => {
  test('a settled empty state records whether the scene showed', () => {
    expect(
      nextSceneLast(false, {
        confirmedEmpty: true,
        quiet: false,
        hasRows: false,
        queryActive: true,
      }),
    ).toBe(true);
    expect(
      nextSceneLast(true, {
        confirmedEmpty: true,
        quiet: true,
        hasRows: false,
        queryActive: true,
      }),
    ).toBe(false);
  });

  test('rows, or a query dropped below the floor, clear it; a load leaves it', () => {
    expect(
      nextSceneLast(true, {
        confirmedEmpty: false,
        quiet: false,
        hasRows: true,
        queryActive: true,
      }),
    ).toBe(false);
    expect(
      nextSceneLast(true, {
        confirmedEmpty: false,
        quiet: false,
        hasRows: false,
        queryActive: false,
      }),
    ).toBe(false);
    expect(
      nextSceneLast(true, {
        confirmedEmpty: false,
        quiet: false,
        hasRows: false,
        queryActive: true,
      }),
    ).toBe(true);
  });
});

describe('sceneShown', () => {
  test('the quiet offer never shows the scene, settled or loading', () => {
    expect(
      sceneShown({
        quiet: true,
        confirmedEmpty: true,
        loading: false,
        sceneLast: true,
        webGpu: gpu,
      }),
    ).toBe(false);
    expect(
      sceneShown({
        quiet: true,
        confirmedEmpty: false,
        loading: true,
        sceneLast: true,
        webGpu: gpu,
      }),
    ).toBe(false);
  });

  test('a settled empty text shows it', () => {
    expect(
      sceneShown({
        quiet: false,
        confirmedEmpty: true,
        loading: false,
        sceneLast: false,
        webGpu: noGpu,
      }),
    ).toBe(true);
  });

  test('a refine-load keeps it only from the scene, and only with a hole to keep', () => {
    const load = (sceneLast: boolean, webGpu: () => boolean) =>
      sceneShown({
        quiet: false,
        confirmedEmpty: false,
        loading: true,
        sceneLast,
        webGpu,
      });
    expect(load(true, gpu)).toBe(true);
    expect(load(true, noGpu)).toBe(false);
    expect(load(false, gpu)).toBe(false);
  });
});
