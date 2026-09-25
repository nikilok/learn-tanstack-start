import type { CompanyExtras } from './extras';

/** getCompanyExtras' answer: the extras, or a refusal of the token presented. */
export type ExtrasResponse =
  | { status: 'ok'; extras: CompanyExtras }
  | { status: 'denied' };

/** The page whose extras are wanted: its slug, the licence rows it rendered and the company it shows. */
export type ExtrasPage = {
  slug: string;
  slugIds: string[];
  companyNumber: string | null;
};

type Mint = (key: string) => Promise<string | null>;

type Load = (
  page: ExtrasPage,
  key: string,
  token: string,
) => Promise<ExtrasResponse>;

/**
 * Loads a page's extras with one token per document, minted on the first load
 * and shared by every later one. A refused token is replaced once, by whichever
 * load gets there first, and the load retried. A second refusal, or a mint that
 * issues no token, resolves null. A mint that fails is dropped, so the load
 * rejects and the next attempt mints again.
 */
export function createExtrasLoader(mint: Mint, load: Load) {
  let current: Promise<string | null> | null = null;

  const mintToken = (key: string) => {
    const minted = mint(key);
    current = minted;
    minted.catch(() => {
      if (current === minted) current = null;
    });
    return minted;
  };

  return async (
    page: ExtrasPage,
    key: string,
  ): Promise<CompanyExtras | null> => {
    const used = current ?? mintToken(key);
    const token = await used;
    if (token === null) return null;
    const first = await load(page, key, token);
    if (first.status === 'ok') return first.extras;
    // Another load may already have replaced the refused token.
    if (current === used) current = null;
    const fresh = await (current ?? mintToken(key));
    if (fresh === null) return null;
    const second = await load(page, key, fresh);
    return second.status === 'ok' ? second.extras : null;
  };
}
