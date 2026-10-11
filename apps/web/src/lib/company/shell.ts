import { titleCase } from '../../utils';
import { searchTermInput } from '../search/params';
import { CLIENT_RENDER } from '../session/calls';

/**
 * The search a company page keeps: the term the list was filtered by, and the edge's mark on a
 * page it serves as the app shell (`src/lib/session/calls.ts`).
 */
export type CompanySearch = { search: string; render?: typeof CLIENT_RENDER };

/**
 * The company route's `validateSearch`. The router redirects a URL to the one its validated search
 * spells, so the shell mark must be kept here, or the shell's URL would redirect to the plain one,
 * which the edge rewrites back to the shell. Anything but the mark itself is dropped, so no other
 * URL gains it.
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
 * Whether a company page is shown without its data, and so titled by the name its URL spells: the
 * app shell, or a page whose data the browser is still loading or failed to load. Only the server
 * sees the shell's mark: the edge adds it to the request, so the address the browser shows never
 * carries it, and there the shell is a page still loading.
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
