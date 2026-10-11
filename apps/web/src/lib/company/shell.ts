import { titleCase } from '../../utils';
import { searchTermInput } from '../search/params';
import { CLIENT_RENDER } from '../session/calls';

/**
 * The search a company page keeps: the term the list was filtered by, and the edge's mark on a
 * page it serves as the app shell (`src/lib/session/calls.ts`).
 */
export type CompanySearch = { search: string; render?: typeof CLIENT_RENDER };

/**
 * The company route's `validateSearch`. It keeps the shell mark, or the router would redirect the
 * shell's URL to the plain one; anything else under that key is dropped.
 */
export function companySearch(search: Record<string, unknown>): CompanySearch {
  return {
    // searchTermInput: the router JSON-parses ?search=365 into a NUMBER — a raw
    // string cast + .trim() throws on URLs the app itself mints.
    search: searchTermInput(search.search),
    ...(search.render === CLIENT_RENDER ? { render: CLIENT_RENDER } : {}),
  };
}

/** Whether a company page is the app shell, rendered in the browser. */
export function isShell(search: Partial<CompanySearch> | undefined): boolean {
  return search?.render === CLIENT_RENDER;
}

/**
 * Whether a company page is shown without its data, and so titled from its URL: the shell, or a
 * page still loading or failed in the browser (whose address never carries the shell mark).
 */
export function shownWithoutData(match: {
  loaderData?: unknown;
  search: Partial<CompanySearch> | undefined;
  status: string;
}): boolean {
  if (match.loaderData) return false;
  return (
    isShell(match.search) ||
    match.status === 'pending' ||
    match.status === 'error'
  );
}

/** The shell's name for a company, which it has no data to look up: the one its slug spells. */
export function shellName(slug: string): string {
  return titleCase(slug.replace(/-/g, ' '));
}
