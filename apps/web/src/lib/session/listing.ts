import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';

import { rendersListing } from './listing.server';

/**
 * Whether the home page renders a search's first page of results into the current request's
 * document (`rendersListing`); in the browser, where results load through the session, false.
 * Its server half lives apart, so nothing it reads reaches the browser's bundle.
 */
export const listingRenderedHere = createIsomorphicFn()
  .server((): Promise<boolean> => rendersListing(getRequest()))
  .client(async (): Promise<boolean> => false);
