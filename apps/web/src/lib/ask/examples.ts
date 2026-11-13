// What the register can be asked, by example: the home page rotates these in
// place of its filters row while asking is open (components/AskExamples), and
// asks one as written when it is chosen. The rotation's beats live here with
// the list, so the timer that advances it and the letters' own animations
// keep the same time.

/** How long the row's entrance runs before the first example starts typing, in ms. */
export const EXAMPLE_ENTER_MS = 800;

/** One letter's beat as an example types in, left to right, in ms. */
export const EXAMPLE_TYPE_MS = 40;

/** How long an example takes to erase, right to left and whatever its length, in ms. */
export const EXAMPLE_ERASE_MS = 300;

/** How long a typed-out example holds before it is erased, in ms. */
export const EXAMPLE_HOLD_MS = 3000;

/**
 * Example questions in the order shown, each an answer on the register as
 * probed on 2026-11-12 (at least eight ranked, the first of them on point):
 * what they do with where, with a rating, and alone. A phrase the planner
 * reads as a whole sector ("law firms") answers with the sector's listing
 * instead, so none is one. Each is asked as written, so each clears the
 * ask's own gate (lib/ask/eligibility) and fits one line on a phone.
 */
export const ASK_EXAMPLES: readonly string[] = [
  'care homes in Leeds',
  'video game studios in Guildford',
  'Japanese restaurants in London',
  'solicitors in Manchester with an A rating',
  'software companies in Edinburgh',
  'animation studios in Bristol',
  'renewable energy companies in Glasgow',
  'charities helping refugees',
];

/** An example's letters as typed, its spaces among them: one beat each. */
export function letters(text: string): string[] {
  return Array.from(text);
}

/** Which example is shown and which, if any, it replaced: the one erased as it typed. */
export type ExampleRotation = { shown: number; leaving: number | null };

/** The rotation at mount: the first example, nothing before it. */
export const FIRST_EXAMPLE: ExampleRotation = { shown: 0, leaving: null };

/** The rotation one dwell later: the next example shown, wrapping to the first past the last, with the one shown leaving. */
export function advanceExamples(
  rotation: ExampleRotation,
  count = ASK_EXAMPLES.length,
): ExampleRotation {
  return { shown: (rotation.shown + 1) % count, leaving: rotation.shown };
}

/** How long `rotation`'s example waits before it types, in ms: the row's entrance for the first, the erase of the one leaving after it. */
export function exampleWaitMs(rotation: ExampleRotation): number {
  return rotation.leaving === null ? EXAMPLE_ENTER_MS : EXAMPLE_ERASE_MS;
}

/** How long the rotation dwells on `rotation`, in ms: its example's wait, a beat per letter, and its hold once typed. */
export function exampleDwellMs(
  rotation: ExampleRotation,
  examples: readonly string[] = ASK_EXAMPLES,
): number {
  return (
    exampleWaitMs(rotation) +
    letters(examples[rotation.shown]).length * EXAMPLE_TYPE_MS +
    EXAMPLE_HOLD_MS
  );
}

/** The example a click asks: the one shown, unless the one it replaced is still being erased, which is what was read. */
export function visibleExample(
  rotation: ExampleRotation,
  erased: boolean,
  examples: readonly string[] = ASK_EXAMPLES,
): string {
  return rotation.leaving !== null && !erased
    ? examples[rotation.leaving]
    : examples[rotation.shown];
}
