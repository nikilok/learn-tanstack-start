import { describe, expect, test } from 'bun:test';

import { nextSceneLast, quietListing, sceneShown } from './empty-state';

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

describe('quietListing', () => {
  const settled = { confirmedEmpty: true, loading: false };
  const rows = { confirmedEmpty: false, loading: false };

  test('a running question is quiet whatever the name search found: its answer is on the way', () => {
    expect(quietListing({ status: 'pending' }, settled)).toBe(true);
    expect(quietListing({ status: 'pending' }, rows)).toBe(true);
  });

  test('the offer is quiet only while the text has nothing by name or is still loading', () => {
    expect(quietListing({ status: 'eligible' }, settled)).toBe(true);
    expect(
      quietListing(
        { status: 'eligible' },
        { confirmedEmpty: false, loading: true },
      ),
    ).toBe(true);
    expect(quietListing({ status: 'eligible' }, rows)).toBe(false);
  });

  test('an empty or failed answer, or no ask at all, leaves the listing to the scene', () => {
    expect(quietListing({ status: 'empty' }, settled)).toBe(false);
    expect(quietListing({ status: 'unavailable' }, settled)).toBe(false);
    expect(quietListing(null, settled)).toBe(false);
  });
});
