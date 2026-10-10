// What the listing shows when a query has nothing: the no-results scene, the
// ask's quiet offer, or the frame a load fills. Pure, so the rule that keeps
// the WebGPU scene mounted across a refine is tested rather than read.

/** Whether the last settled empty view was the scene: a settled empty state records it; rows, or a query dropped below the floor, clear it; a load leaves it. */
export function nextSceneLast(
  prev: boolean,
  s: {
    confirmedEmpty: boolean;
    quiet: boolean;
    hasRows: boolean;
    queryActive: boolean;
  },
): boolean {
  if (s.confirmedEmpty) return !s.quiet;
  if (s.hasRows || !s.queryActive) return false;
  return prev;
}

/**
 * Whether the scene shows: on a settled empty text the quiet offer does not
 * cover, or across a refine-load from the scene when there is a WebGPU hole
 * worth keeping mounted (its zoom plays once). A refine from the quiet offer
 * had no hole, so it loads as the offer or as skeletons instead.
 */
export function sceneShown(s: {
  quiet: boolean;
  confirmedEmpty: boolean;
  loading: boolean;
  sceneLast: boolean;
  webGpu: () => boolean;
}): boolean {
  if (s.quiet) return false;
  return s.confirmedEmpty || (s.loading && s.sceneLast && s.webGpu());
}
