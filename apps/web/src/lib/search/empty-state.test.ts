import { describe, expect, test } from 'bun:test';

import { cooldownHold, cooldownNotice } from '../ask/cooldown';
import {
  nextSceneLast,
  quietListing,
  sceneNote,
  sceneShown,
} from './empty-state';

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

  test('a device waiting out a cooldown is offered nothing: the scene, or the rows, say so', () => {
    expect(quietListing({ status: 'cooldown' }, settled)).toBe(false);
    expect(quietListing({ status: 'cooldown' }, rows)).toBe(false);
    expect(
      quietListing(
        { status: 'cooldown' },
        { confirmedEmpty: false, loading: true },
      ),
    ).toBe(false);
  });
});

describe('sceneNote', () => {
  // When the device may ask again, and when the rest of an answer can load.
  const UNTIL = Date.UTC(2026, 10, 22, 14, 5);
  const HELD = Date.UTC(2026, 10, 22, 18, 30);
  const keyboard = false;

  test('a device waiting out a cooldown is told when it can ask again', () => {
    expect(
      sceneNote({ status: 'cooldown', until: UNTIL, keyboard }, null),
    ).toBe(cooldownNotice(UNTIL));
  });

  test('an ask that could not run says so', () => {
    expect(sceneNote({ status: 'unavailable', keyboard }, null)).toBe(
      'Ask isn’t available right now.',
    );
  });

  test('an empty answer says why, by its reason', () => {
    for (const [reason, line] of [
      [
        'name',
        'That reads as one organisation’s name, and it isn’t on the register.',
      ],
      ['beyond', 'That asks for something the register doesn’t hold.'],
      [
        'unmatched',
        'Nothing we’ve read on a sponsor’s website describes that.',
      ],
      ['none', 'Couldn’t turn that into filters.'],
    ] as const)
      expect(sceneNote({ status: 'empty', reason, keyboard }, null)).toBe(line);
  });

  test('the ask’s own line wins over a wait holding the rest of an answer', () => {
    expect(
      sceneNote({ status: 'cooldown', until: UNTIL, keyboard }, HELD),
    ).toBe(cooldownNotice(UNTIL));
    expect(sceneNote({ status: 'unavailable', keyboard }, HELD)).toBe(
      'Ask isn’t available right now.',
    );
    expect(
      sceneNote({ status: 'empty', reason: 'beyond', keyboard }, HELD),
    ).toBe('That asks for something the register doesn’t hold.');
  });

  test('with no line of the ask’s own, a wait holding the rest of an answer says when it can load', () => {
    for (const ask of [
      null,
      { status: 'eligible', keyboard },
      { status: 'pending', keyboard },
    ] as const)
      expect(sceneNote(ask, HELD)).toBe(cooldownHold(HELD));
  });

  test('with nothing to say and no wait, there is no second line', () => {
    for (const ask of [
      null,
      { status: 'eligible', keyboard },
      { status: 'pending', keyboard },
    ] as const)
      expect(sceneNote(ask, null)).toBeNull();
  });

  test('a question’s listing with no rows, its further slices held by a wait, shows the scene and says when the rest can load', () => {
    // An applied question gives the listing no ask hint at all.
    const settled = { confirmedEmpty: true, loading: false };
    const quiet = quietListing(null, settled);
    expect(
      sceneShown({ quiet, ...settled, sceneLast: false, webGpu: noGpu }),
    ).toBe(true);
    const note = sceneNote(null, HELD);
    expect(note).toBe(cooldownHold(HELD));
    expect(note).toStartWith(
      'That’s the limit for questions for now. More matches can load after ',
    );
  });
});
