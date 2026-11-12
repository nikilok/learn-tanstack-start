import {
  createTownRoster,
  describeJevError,
  JevError,
  planAsk,
  type RankingResult,
  rankSpan,
  TOWN_ROSTER_SQL,
  type TownRoster,
} from '@nikilok/thoth-engine';
import {
  canonicalSearchParams,
  filtersToSearchParams,
  parseSearchFilters,
} from '@ss/search-filters';
import { createServerFn } from '@tanstack/react-start';
import { waitUntil } from '@vercel/functions';
import { sql } from 'drizzle-orm';

import { db } from '../db.server';
import { mayAsk } from '../lib/ask/access.server';
import {
  type AskMoreResponse,
  type AskPlanResponse,
  createAskLoader,
} from '../lib/ask/ask-loader';
import { MAX_QUESTION_CHARS } from '../lib/ask/eligibility';
import { applyPlan } from '../lib/ask/overlay';
import { isSector } from '../lib/ask/sector';
import { isTrancheOffset, nextTrancheOffset } from '../lib/ask/tranches';
import { ownerOrBrowser } from '../lib/device/browser-check.server';
import { deviceKey, TOKEN_MAX_LENGTH } from '../lib/device/rpc-input';
import { isSuspended } from '../lib/device/suspended.server';
import { issueToken, tokenMatches } from '../lib/device/token.server';
import { buildFilterConditions, sectorCondition } from '../lib/search/sql';
import { describeError } from '../lib/server-fn-errors';
import { expireOwnerHint } from '../owner.server';
import { setRpcCacheControl } from './cache-headers';

let roster: (() => Promise<TownRoster>) | null = null;

/** A failure as the log may carry it: never a reply's body, which may echo the text it was sent. */
function failureLine(what: string, error: unknown): string {
  return `${what}: ${error instanceof JevError ? describeJevError(error) : describeError(error)}`;
}

/** The town roster, loaded once per instance on the first ask. A function, not a module-level value, so the client bundle keeps nothing of it. */
function towns(): Promise<TownRoster> {
  roster ??= createTownRoster(async () =>
    (await db.execute(sql.raw(TOWN_ROSTER_SQL))).rows.map((row) => ({
      town: String(row.town),
      n: Number(row.n),
    })),
  );
  return roster();
}

/**
 * Server fn issuing a token for a device key, as the company extras do, when
 * the request carries the credential that may ask (lib/ask/access.server).
 * `null` otherwise, before anything else is read, and the box never offers
 * to ask. POST and never cached.
 */
const issueAskToken = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ key: deviceKey(input) }))
  .handler(async ({ data: { key } }) => {
    setRpcCacheControl('private, no-store');
    if (!(await mayAsk())) {
      // A document whose hint outlived its credential stops offering.
      expireOwnerHint();
      return { token: null };
    }
    if (await isSuspended(key)) return { token: null };
    if (!(await ownerOrBrowser('ask'))) return { token: null };
    const token = issueToken(key);
    if (token === null) console.error('[ask] ENGAGE_TOKEN_SECRET not set');
    // The roster's first load is the slow part of a cold instance's first
    // ask; the mint comes seconds earlier, so it warms it off the critical
    // path, and past the response, so a frozen instance cannot strand it.
    waitUntil(towns().catch(() => {}));
    return { token };
  });

/** The sector a question named as the shortlist's preference: the listing's own sector test, ranking the companies the register places there first and cutting none (the engine's `prefer`). */
function sectorPreference(sector: string | null) {
  if (sector === null) return undefined;
  return (
    sectorCondition(
      parseSearchFilters({ sicSection: sector }).filters.sicSection ?? [],
    ) ?? undefined
  );
}

/**
 * Server fn planning one typed search for a device key carrying a live
 * token. A request without the credential that may ask is `denied` before
 * anything else is read; so is a refused token, a suspended key, or, unless
 * it is the owner's own, a request not from a browser a person is using, and
 * none of those is an error. Jev
 * failing, or no key to reach it with, is `unavailable`: the box falls back
 * to the name search it already ran. When the text says what the
 * organisations do, pathway B ranks the companies whose accounts say it,
 * under the plan's filters laid over the hand-set `base`, the sector the
 * text named ranking the shortlist rather than cutting it (lib/ask/sector)
 * unless nothing was there to rank. POST and never
 * cached. The text is logged beside what it became, as the box's name
 * searches are (privacy: search queries, not linked to identity), so what
 * people ask can be read; the device key never joins it. The ranking is the
 * first slice of the span's shortlist, naming the next for `rankMore`
 * (lib/ask/tranches).
 */
const planSearch = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const key = deviceKey(input);
    const { text, token, base } = input as Record<string, unknown>;
    // The code-unit bound first: a code point is at most two units, so the
    // spread that counts them never runs over a body nobody could have typed.
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 2 * MAX_QUESTION_CHARS ||
      [...text].length > MAX_QUESTION_CHARS ||
      typeof token !== 'string' ||
      token.length > TOKEN_MAX_LENGTH
    ) {
      throw new Error('Invalid input');
    }
    // The hand-set filters, re-validated through the registry like any URL.
    return { key, text, token, base: canonicalSearchParams(base) };
  })
  .handler(async ({ data }): Promise<AskPlanResponse> => {
    setRpcCacheControl('private, no-store');
    if (!(await mayAsk())) return { status: 'denied' };
    if (!tokenMatches(data.token, data.key)) return { status: 'denied' };
    // Loads beside the remaining checks rather than after them; a failure
    // surfaces where it is awaited.
    const rosterReady = towns();
    rosterReady.catch(() => {});
    if (await isSuspended(data.key)) return { status: 'denied' };
    if (!(await ownerOrBrowser('ask'))) return { status: 'denied' };
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
      console.error('[ask] TYPESAFE_API_KEY not set');
      return { status: 'unavailable' };
    }
    try {
      const planned = await planAsk(data.text, {
        apiKey,
        maxChars: MAX_QUESTION_CHARS,
        // A load the warm-up started may have died with a thaw: one more try.
        towns: await rosterReady.catch(() => towns()),
      });
      const filters = filtersToSearchParams(planned.filters);
      // With a span, the sector the text named ranks the shortlist and cuts
      // nothing: the register's code is a prior on a line of work, the
      // account the authority. Without one it is a filter like any other.
      const sector = planned.plan.span ? (filters.sicSection ?? null) : null;
      if (sector !== null) delete filters.sicSection;
      // Judged under the filters the listing will apply: the plan's over the
      // base. A rerank that fails loses the ranking, not the plan: the filters
      // still answer, and only a plan with nothing else to show is unavailable.
      let ranking: RankingResult | null = null;
      let rankingFailed = false;
      if (planned.plan.span) {
        try {
          ranking = await rankSpan(
            planned.plan.span,
            buildFilterConditions(
              parseSearchFilters(applyPlan(data.base, filters, sector)).filters,
            ),
            apiKey,
            { execute: (statement) => db.execute(statement) },
            { prefer: sectorPreference(sector) },
          );
        } catch (error) {
          rankingFailed = true;
          console.error(failureLine('[ask] rerank failed', error));
        }
      }
      console.log(
        `[ask] keys=${Object.keys(planned.filters).join(',') || 'none'} name=${planned.plan.namesCompany.toFixed(2)} beyond=${planned.plan.beyondFilters.toFixed(2)} ms=${planned.ms} tokens=${planned.reading.inputTokens}` +
          (ranking
            ? ` span=yes sector=${sector ?? 'none'} shortlisted=${ranking.shortlist.length} ranked=${ranking.ranked.length} matched=${ranking.matched} rerank_ms=${ranking.ms} rerank_tokens=${ranking.inputTokens} requests=${ranking.requests}`
            : rankingFailed
              ? ' span=failed'
              : ' span=no') +
          // Last, JSON-quoted: one line however the text runs, and the
          // fixed fields before it stay where a reader expects them.
          ` q=${JSON.stringify(data.text)} about=${JSON.stringify(planned.plan.span)}`,
      );
      // Nothing to rank leaves the sector the filter it was.
      if (sector !== null && !ranking?.shortlist.length)
        filters.sicSection = sector;
      // A ranking nobody made is no ranking: the filters alone answer, and
      // with none of those either, the question matched nothing we have read.
      const filtered = Object.keys(filters).length > 0;
      const ranked = ranking && ranking.ranked.length ? ranking.ranked : null;
      if (rankingFailed && !filtered) return { status: 'unavailable' };
      return {
        status: 'ok',
        filters,
        reason:
          ranking && !ranked && !filtered ? 'unmatched' : planned.plan.reason,
        ranking:
          ranked && ranking && planned.plan.span
            ? {
                span: planned.plan.span,
                sector,
                tranches: [ranked],
                next: nextTrancheOffset(0, ranking.shortlist.length),
              }
            : null,
      };
    } catch (error) {
      console.error(failureLine('[ask] failed', error));
      return { status: 'unavailable' };
    }
  });

/**
 * Server fn judging the next slice of a question's shortlist, for a listing
 * that has shown the slices so far (lib/ask/tranches): the same span under
 * the listing's filters, SHORTLIST_MAX companies from `offset` into the
 * shortlist's order, the sector the question named ranking it as it did the
 * first, judged as the first slice was, naming the slice after.
 * Admitted as planSearch admits an ask, `unavailable` on the same failures.
 * POST and never cached; the span is never logged, only what the slice came
 * to.
 */
const rankMore = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const key = deviceKey(input);
    const { span, token, params, offset, sector } = input as Record<
      string,
      unknown
    >;
    const named = sector ?? null;
    if (
      typeof span !== 'string' ||
      !span.trim() ||
      span.length > 2 * MAX_QUESTION_CHARS ||
      [...span].length > MAX_QUESTION_CHARS ||
      typeof token !== 'string' ||
      token.length > TOKEN_MAX_LENGTH ||
      !isTrancheOffset(offset) ||
      (named !== null && !isSector(named))
    ) {
      throw new Error('Invalid input');
    }
    // The listing's filters, re-validated through the registry like any URL.
    return {
      key,
      span,
      token,
      params: canonicalSearchParams(params),
      offset,
      sector: named,
    };
  })
  .handler(async ({ data }): Promise<AskMoreResponse> => {
    setRpcCacheControl('private, no-store');
    if (!(await mayAsk())) return { status: 'denied' };
    if (!tokenMatches(data.token, data.key)) return { status: 'denied' };
    if (await isSuspended(data.key)) return { status: 'denied' };
    if (!(await ownerOrBrowser('ask'))) return { status: 'denied' };
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
      console.error('[ask] TYPESAFE_API_KEY not set');
      return { status: 'unavailable' };
    }
    try {
      const ranking = await rankSpan(
        data.span,
        buildFilterConditions(parseSearchFilters(data.params).filters),
        apiKey,
        { execute: (statement) => db.execute(statement) },
        { offset: data.offset, prefer: sectorPreference(data.sector) },
      );
      console.log(
        `[ask] more offset=${data.offset} sector=${data.sector ?? 'none'} shortlisted=${ranking.shortlist.length} ranked=${ranking.ranked.length} matched=${ranking.matched} rerank_ms=${ranking.ms} rerank_tokens=${ranking.inputTokens} requests=${ranking.requests}`,
      );
      return {
        status: 'ok',
        ranked: ranking.ranked,
        next: nextTrancheOffset(data.offset, ranking.shortlist.length),
      };
    } catch (error) {
      console.error(failureLine('[ask] more failed', error));
      return { status: 'unavailable' };
    }
  });

const loader = createAskLoader(
  async (key) => (await issueAskToken({ data: { key } })).token,
  (text, key, token, base) => planSearch({ data: { text, key, token, base } }),
  (span, key, token, params, offset, sector) =>
    rankMore({ data: { span, key, token, params, offset, sector } }),
);

/** Whether this document may ask: mints its token the first time the offer would show, so the offer never shows where it cannot be taken. */
export const prepareAsk = loader.prepare;

/** Asks for a device key with the document's token, minted on the first ask and replaced once if refused. */
export const askSearch = loader.ask;

/** Judges the next slice of an asked question's shortlist with the same token (lib/ask/tranches). */
export const askMore = loader.more;
