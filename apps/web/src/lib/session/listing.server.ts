import { CLIENT_RENDER, RENDER_PARAM } from './calls';
import { decideDocument, type DocumentMode, documentMode } from './decide';
import { ownerRequest } from './owner';
import { crawlerRanges, type Ranges } from './ranges';

/** What can be swapped out, for tests. Absent, each is read as production reads it. */
export type ListingDeps = {
  mode?: DocumentMode | null;
  ranges?: () => Promise<Ranges | null>;
  /** Whether the request comes from the owner's browser (`owner.ts`). */
  owner?: () => Promise<boolean>;
};

/**
 * Whether the home page renders a search's first page of results into its document: for whoever
 * is served a company page in full (`decideDocument`: the owner and a crawler), and for everyone
 * while company pages are not enforced (`DOCUMENT_MODE`). Anyone else's results load in the
 * browser through their session (`SESSION_CALLS`), as does a page asked for with the shell mark,
 * which shows what a visitor gets. Never throws.
 */
export async function rendersListing(
  request: { url: string; headers: Headers },
  deps: ListingDeps = {},
): Promise<boolean> {
  if (new URL(request.url).searchParams.get(RENDER_PARAM) === CLIENT_RENDER)
    return false;
  const mode = 'mode' in deps ? deps.mode : documentMode();
  if (mode !== 'enforce') return true;
  const { headers } = request;
  const decided = decideDocument({
    headers,
    ranges: await (deps.ranges ?? crawlerRanges)(),
    owner: await (deps.owner ?? (() => ownerRequest(headers)))(),
  });
  return decided.render === 'server';
}
