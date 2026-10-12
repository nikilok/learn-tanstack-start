import {
  filterParamsOf,
  parseSearchFilters,
  type SearchFilters,
} from './params';

/** The first page of results a home page's document can carry: a filter listing's, or a name search's. */
export type ListingToStart =
  | { kind: 'filter'; filters: SearchFilters }
  | { kind: 'name'; term: string };

/**
 * Starts the home page's first page of results with its document, when it is rendered there at all
 * (`rendered`: asked only when there is a search to start). With any filter set the filter listing
 * serves it, the name term riding along once it is 3 characters; otherwise a term of 3 or more is a
 * name search. Resolves once it has decided; what it starts is not awaited.
 */
export async function startListing(input: {
  term: string;
  /** The route's search beside the term, filters and anything else. */
  params: Record<string, unknown>;
  rendered: () => Promise<boolean>;
  start: (listing: ListingToStart) => void;
}): Promise<void> {
  const { term } = input;
  const urlFilters = filterParamsOf(input.params);
  const filterMode = Object.keys(urlFilters).length > 0;
  if (!filterMode && term.length < 3) return;
  if (!(await input.rendered())) return;
  if (!filterMode) {
    input.start({ kind: 'name', term });
    return;
  }
  const { filters } = parseSearchFilters({
    ...urlFilters,
    q: term.length >= 3 ? term : undefined,
  });
  input.start({ kind: 'filter', filters });
}
