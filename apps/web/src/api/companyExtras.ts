import { companyWebsites } from '@ss/db';
import { queryOptions, skipToken } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { and, eq } from 'drizzle-orm';

import { db } from '../db.server';
import { pageExtras } from '../lib/company/extras';
import {
  createExtrasLoader,
  type ExtrasPage,
  type ExtrasResponse,
} from '../lib/company/extras-loader';
import {
  type CompanyPageRow,
  companyPageRowsSql,
  SLUG_RE,
} from '../lib/company/page-rows';
import { DEVICE_KEY_RE } from '../lib/device/key';
import { issueToken, tokenMatches } from '../lib/device/token.server';
import { publishableWebsiteGate } from '../lib/websites/publishable';
import { setRpcCacheControl } from './cache-headers';

// Tokens are a fixed 54 characters; anything much longer is not one.
const TOKEN_MAX_LENGTH = 128;

// Same shape the company_websites and mapping columns hold.
const COMPANY_NUMBER_RE = /^[A-Za-z0-9]{1,20}$/;

// A licence row's slugId: an 11-character base64url hash.
const SLUG_ID_RE = /^[\w-]{11}$/;

// A slug holds a handful of licence rows; this only bounds the payload.
const MAX_SLUG_IDS = 50;

/** The device key from an RPC payload, or a throw: a well-formed key is required by both fns. */
function deviceKey(input: unknown): string {
  const key = (input as { key?: unknown } | null)?.key;
  if (typeof key !== 'string' || !DEVICE_KEY_RE.test(key)) {
    throw new Error('Invalid input');
  }
  return key;
}

/**
 * Server fn issuing a token for a device key; the page calls it before its
 * first extras load. `null` when no token can be issued. POST and never
 * cached.
 */
const issueExtrasToken = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => ({ key: deviceKey(input) }))
  .handler(({ data: { key } }) => {
    setRpcCacheControl('private, no-store');
    const token = issueToken(key);
    if (token === null) console.error('[extras] ENGAGE_TOKEN_SECRET not set');
    return { token };
  });

/**
 * Server fn returning a company page's licence numbers and confirmed website,
 * for a device key carrying a live token issued by issueExtrasToken. The page
 * names the licence rows it rendered and the company it shows, and pageExtras
 * answers for exactly those: the page is a cached snapshot, and a mapping
 * change since must not put another company's extras on it. A refused token is
 * `denied`, never an error. POST and never cached: the answer depends on the
 * token presented.
 */
const getCompanyExtras = createServerFn({ method: 'POST' })
  .inputValidator((input: unknown) => {
    const key = deviceKey(input);
    const { slug, slugIds, companyNumber, token } = input as Record<
      string,
      unknown
    >;
    if (
      typeof slug !== 'string' ||
      !SLUG_RE.test(slug) ||
      !Array.isArray(slugIds) ||
      slugIds.length === 0 ||
      slugIds.length > MAX_SLUG_IDS ||
      !slugIds.every((id) => typeof id === 'string' && SLUG_ID_RE.test(id)) ||
      !(
        companyNumber === null ||
        (typeof companyNumber === 'string' &&
          COMPANY_NUMBER_RE.test(companyNumber))
      ) ||
      typeof token !== 'string' ||
      token.length > TOKEN_MAX_LENGTH
    ) {
      throw new Error('Invalid input');
    }
    return { slug, slugIds: slugIds as string[], companyNumber, key, token };
  })
  .handler(async ({ data }): Promise<ExtrasResponse> => {
    setRpcCacheControl('private, no-store');
    if (!tokenMatches(data.token, data.key)) return { status: 'denied' };
    const [found, websites] = await Promise.all([
      db.execute(companyPageRowsSql(data.slug)),
      data.companyNumber === null
        ? []
        : db
            .select({ url: companyWebsites.url })
            .from(companyWebsites)
            .where(
              and(
                eq(companyWebsites.companyNumber, data.companyNumber),
                publishableWebsiteGate(),
              ),
            )
            .limit(1),
    ]);
    const rows = found.rows as unknown as CompanyPageRow[];
    return {
      status: 'ok',
      extras: pageExtras(rows, data, websites[0]?.url ?? null),
    };
  });

const loadExtras = createExtrasLoader(
  async (key) => (await issueExtrasToken({ data: { key } })).token,
  ({ slug, slugIds, companyNumber }, key, token) =>
    getCompanyExtras({ data: { slug, slugIds, companyNumber, key, token } }),
);

/** React Query options for a page's extras: idle until `key` is known, then loaded once per page and kept while the query stays cached. A failed load retries once, and again on reconnect or revisit, but not on every tab focus. */
export const companyExtrasQueryOptions = (
  page: ExtrasPage,
  key: string | null,
) =>
  queryOptions({
    queryKey: ['company-extras', page.slug, page.companyNumber, page.slugIds],
    queryFn: key === null ? skipToken : () => loadExtras(page, key),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
    refetchOnWindowFocus: false,
  });
