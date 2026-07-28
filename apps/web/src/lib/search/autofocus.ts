// Shortest term that runs a search — a deep link at or past it already has a
// listing on screen, so the input is no longer the thing being asked for.
const MIN_QUERY_LENGTH = 3;

/**
 * Whether the home search input may claim focus when it mounts. Autofocus
 * belongs to the empty hero, where typing a name is the only thing to do; a
 * filtered listing is already an answer, so grabbing focus there just raises
 * the mobile keyboard over the results the user came to read.
 */
export function shouldAutoFocusSearch({
  isStuck,
  search,
  filterMode,
  isPreview,
}: {
  isStuck: boolean;
  search: string;
  filterMode: boolean;
  isPreview: boolean;
}): boolean {
  return (
    !isStuck && !filterMode && !isPreview && search.length < MIN_QUERY_LENGTH
  );
}
