import { ADDRESS_COLUMNS } from '@ss/db/constants';
import { companyWebsites } from '@ss/db/schema';
import { type SQL, sql } from 'drizzle-orm';

import { publishableWebsiteGate } from '../websites/publishable';
import {
  industryWords,
  type SearchFilters,
  SIC_SECTIONS,
  typeRatingsFor,
} from './params';

// Fragments target the canonical filter-query aliases, which the /search
// server fn's FROM clause must use:
//   hmrc_skilled_workers h
//   LEFT JOIN hmrc_company_mapping m ON m.organisation_name = h.organisation_name
//   LEFT JOIN companies_house_profiles c ON c.company_number = m.company_number
// With a name term `h` is instead the `hits` CTE (lib/search/prev-name), which
// projects `h.*` precisely so every h.<col> below still resolves — narrowing
// that projection breaks the location filter, not this file.
// CH-sourced conditions (c.*) evaluate NULL for unmapped sponsors, so those
// rows drop out of any CH filter implicitly (see CH_FILTER_KEYS in params.ts).

// CH registry-convenience codes (dormant 99999, residents-property 98000) that
// would drown sections U/T; both stay reachable via explicit sic= codes.
const SECTION_EXCLUDED_CODES = ['98000', '99999'];

/** Comma-joined bound params for an IN list. */
const inList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** Bound-param text[] literal. */
const textArray = (values: readonly string[]): SQL =>
  sql`ARRAY[${inList(values)}]::text[]`;

/**
 * Correlated trail probe shared by both hasMoved branches. Approximates the
 * timeline's move semantics (curate.ts): both sides present and different,
 * and neither side the CH default-address dispute placeholder. Same-value
 * cross-column shuffles can't be composed in SQL and still count — rare.
 */
const addressTrailProbe = (): SQL =>
  // Literal column list (not bound params): it mirrors idx_ch_trail_address_change's
  // partial predicate, which the planner can only prove against constants. Safe to
  // raw — ADDRESS_COLUMNS is a compile-time constant, never user input.
  sql`SELECT 1 FROM companies_house_profile_trails t WHERE t.company_number = c.company_number AND t.column_name IN (${sql.raw(ADDRESS_COLUMNS.map((c) => `'${c}'`).join(', '))}) AND t.old_value IS NOT NULL AND t.new_value IS NOT NULL AND t.old_value <> t.new_value AND t.old_value NOT ILIKE '%companies house default address%' AND t.new_value NOT ILIKE '%companies house default address%'`;

/** One industry word vs a SIC description: word-boundary prefix on a naive stem (homes→home), or strict trigram similarity (strict = whole-word extents; plain word_similarity matches 'care' inside 'carpets'). */
const industryWordPred = (word: string): SQL => {
  // ies→y only on long words ('industries'→'industry'); short ones take the
  // plain s-strip ('ties'→'tie', never 'ty' — a 2-char stem prefix over-matches).
  const stem = (word.length >= 7 ? word.replace(/ies$/i, 'y') : word).replace(
    /^(.{3,})s$/i,
    '$1',
  );
  return sql`(sc.description ~* ${`\\m${stem}`} OR strict_word_similarity(${word}, sc.description) > 0.55)`;
};

/** Aggregate the SIC codes whose description satisfies the given predicate. */
const industryCodes = (preds: SQL): SQL =>
  sql`SELECT coalesce(array_agg(sc.code::text), '{}'::text[]) FROM sic_codes sc WHERE ${preds}`;

/**
 * Correlated probe shared by both hasWebsite branches: does this company have
 * a website the detail page would actually render? The gate itself comes from
 * lib/websites/publishable, so the filter cannot drift from the page.
 *
 * A correlated EXISTS rather than a join: the filter query groups by
 * `h.name_slug, c.company_number`, so a joined table would need a GROUP BY
 * entry and could fan a sponsor out across rows. Costs one PK lookup per
 * candidate against a table of a few thousand rows.
 */
const websiteProbe = (): SQL =>
  sql`SELECT 1 FROM ${companyWebsites} WHERE ${companyWebsites.companyNumber} = c.company_number AND ${publishableWebsiteGate()}`;

/** true = flag set; false = mapped company whose flag is false or unknown (NULL). */
const chFlag = (col: SQL, value: boolean): SQL =>
  value
    ? sql`${col} = true`
    : sql`(c.company_number IS NOT NULL AND ${col} IS NOT TRUE)`;

/**
 * Build one WHERE fragment per active filter. `q`, `sort`, and `order` are
 * not conditions and are handled by the server fn's query shape instead. A
 * workerType/rating combination with no live type_rating value renders FALSE
 * (the caller asked for something that doesn't exist).
 */
export function buildFilterConditions(filters: SearchFilters): SQL[] {
  const conds: SQL[] = [];

  if (filters.route?.length) {
    conds.push(sql`h.route IN (${inList(filters.route)})`);
  }

  if (filters.workerType?.length || filters.rating?.length) {
    const raws = typeRatingsFor(filters.workerType, filters.rating);
    conds.push(
      raws.length ? sql`h.type_rating IN (${inList(raws)})` : sql`false`,
    );
  }

  if (filters.location) {
    // Segment-vs-segment match, whitespace-normalized on the stored side:
    // towns hold comma composites ('Wembley, London') and stray double spaces,
    // and the input may be composite too. Sources mirror the listing card
    // (town_city + COALESCE(locality, address_line_2)). Runs as a post-join
    // filter by design — a cross-relation OR can't be index-served and the
    // tables are small (~141k rows).
    conds.push(
      sql`EXISTS (SELECT 1 FROM unnest(string_to_array(lower(concat_ws(',', h.town_city, COALESCE(c.locality, c.address_line_2))), ',')) AS stored(seg), unnest(string_to_array(lower(${filters.location}), ',')) AS given(seg) WHERE replace(replace(btrim(stored.seg), '  ', ' '), '  ', ' ') = btrim(given.seg) AND btrim(given.seg) <> '')`,
    );
  }

  const sicParts: SQL[] = [];
  if (filters.sic?.length) {
    // 4-digit input is ambiguous: a legacy SIC-2003 value (exact match), a
    // 2007 class (prefix expansion below), or a 5-digit code whose leading
    // zero a JSON number dropped — so the exact set also tries the 0-pad.
    const classCodes = filters.sic.filter((code) => code.length === 4);
    const exact = [...filters.sic, ...classCodes.map((code) => `0${code}`)];
    sicParts.push(sql`c.sic_codes && ${textArray(exact)}`);
    if (classCodes.length) {
      sicParts.push(
        sql`c.sic_codes && (SELECT coalesce(array_agg(sc.code::text), '{}'::text[]) FROM sic_codes sc WHERE left(sc.code, 4) = ANY(${textArray(classCodes)}))`,
      );
    }
  }
  if (filters.sicSection?.length) {
    const divisions = [
      ...new Set(
        filters.sicSection.flatMap(
          (section) => SIC_SECTIONS[section]?.divisions ?? [],
        ),
      ),
    ];
    if (divisions.length) {
      // Sections resolve through the SIC-2007 lookup only; profiles holding
      // legacy 4-digit SIC-2003 codes are reachable via sic=, not sections.
      sicParts.push(
        sql`c.sic_codes && (SELECT coalesce(array_agg(sc.code::text), '{}'::text[]) FROM sic_codes sc WHERE left(sc.code, 2) = ANY(${textArray(divisions)}) AND sc.code NOT IN (${inList(SECTION_EXCLUDED_CODES)}))`,
      );
    }
  }
  if (filters.industry) {
    const words = industryWords(filters.industry);
    if (words.length) {
      // Plain-language industry resolved via SIC descriptions (731 rows, bare
      // functions fine). Prefer descriptions matching ALL words; when SIC
      // officialese defeats that ('care homes' — no description holds both),
      // fall back to ANY word so the filter degrades instead of zeroing out.
      // Re-embedding a fragment renders fresh param slots each time, so `all`
      // can safely appear in both the EXISTS probe and the THEN aggregation.
      const all = sql.join(words.map(industryWordPred), sql` AND `);
      const any = sql.join(words.map(industryWordPred), sql` OR `);
      sicParts.push(
        words.length === 1
          ? sql`c.sic_codes && (${industryCodes(all)})`
          : sql`c.sic_codes && (CASE WHEN EXISTS (SELECT 1 FROM sic_codes sc WHERE ${all}) THEN (${industryCodes(all)}) ELSE (${industryCodes(any)}) END)`,
      );
    }
  }
  if (sicParts.length) {
    conds.push(
      sicParts.length === 1
        ? sicParts[0]
        : sql`(${sql.join(sicParts, sql` OR `)})`,
    );
  }

  if (filters.status?.length) {
    conds.push(sql`c.company_status IN (${inList(filters.status)})`);
  }
  if (filters.companyType?.length) {
    conds.push(sql`c.company_type IN (${inList(filters.companyType)})`);
  }

  if (filters.incorporatedFrom) {
    conds.push(sql`c.date_of_creation >= ${filters.incorporatedFrom}::date`);
  }
  if (filters.incorporatedTo) {
    conds.push(sql`c.date_of_creation <= ${filters.incorporatedTo}::date`);
  }

  if (filters.accountsOverdue !== undefined) {
    conds.push(chFlag(sql`c.accounts_overdue`, filters.accountsOverdue));
  }
  if (filters.hasCharges !== undefined) {
    conds.push(chFlag(sql`c.has_charges`, filters.hasCharges));
  }
  if (filters.hasInsolvencyHistory !== undefined) {
    conds.push(
      chFlag(sql`c.has_insolvency_history`, filters.hasInsolvencyHistory),
    );
  }

  if (filters.hasRenamed !== undefined) {
    conds.push(
      filters.hasRenamed
        ? sql`cardinality(c.previous_company_names) > 0`
        : sql`cardinality(c.previous_company_names) = 0`,
    );
  }

  if (filters.hasMoved !== undefined) {
    // false needs the explicit CH-link guard: NOT EXISTS over a NULL
    // company_number is vacuously true and would include unmapped sponsors.
    conds.push(
      filters.hasMoved
        ? sql`EXISTS (${addressTrailProbe()})`
        : sql`(c.company_number IS NOT NULL AND NOT EXISTS (${addressTrailProbe()}))`,
    );
  }

  // True-only by type (params.ts), so there is no negative branch to write:
  // an EXISTS over a NULL company_number is already false, which correctly
  // excludes sponsors with no Companies House link.
  if (filters.hasWebsite) {
    conds.push(sql`EXISTS (${websiteProbe()})`);
  }

  return conds;
}

/** AND-join all active filter conditions; undefined when no filter is active. */
export function combineFilterConditions(
  filters: SearchFilters,
): SQL | undefined {
  const conds = buildFilterConditions(filters);
  if (!conds.length) return undefined;
  return conds.length === 1 ? conds[0] : sql.join(conds, sql` AND `);
}
