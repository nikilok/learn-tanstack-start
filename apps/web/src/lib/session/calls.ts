// What the edge middleware, the server and the browser agree on about sessions, in one place.

/** The endpoint that issues a session (`server/api/session.post.ts`). */
export const SESSION_PATH = '/api/session';

/** The httpOnly cookie holding a session (`token.ts`). */
export const SESSION_COOKIE = 'ss-session';

/** A session with less than this left is issued again when next asked for. */
export const SESSION_RENEW_SECONDS = 7 * 24 * 60 * 60;

/**
 * A readable cookie beside it holding only the session's expiry (epoch seconds), so a /download
 * preview frame can tell its page holds one. Not a credential.
 */
export const SESSION_HINT_COOKIE = 'ss-session-hint';

/**
 * The query parameter the edge adds when it serves a company document as the app shell. The
 * company route declares it (`validateSearch`), or the router would redirect the URL to one
 * without it.
 */
export const RENDER_PARAM = 'render';
export const CLIENT_RENDER = 'client';

/**
 * The server functions that answer with the register's data, which only a session may call: a
 * company page's (POST, each asking the browser check as well) and the search listings' (GET).
 * Keyed `file#variable`, the file relative to the app root. `call-ids.ts` gives each an id the
 * edge can recognise, and `calls.test.ts` checks each still exists.
 */
export const SESSION_CALLS = [
  'src/api/companyPage.ts#getCompanyPage',
  'src/api/companyExtras.ts#getCompanyExtras',
  'src/api/hmrc.ts#searchHmrc',
  'src/api/filterSearch.ts#searchFiltered',
] as const;

/** Their ids start with this. Every other id is plain hex, so none can. */
export const SESSION_CALL_PREFIX = 's-';

/** The path every session call is made at. */
export const SESSION_CALL_PATH = `/_serverFn/${SESSION_CALL_PREFIX}`;

/** The header a refused session call carries, so the browser knows to renew its session. */
export const SESSION_HEADER = 'x-session';
export const SESSION_REQUIRED = 'required';
