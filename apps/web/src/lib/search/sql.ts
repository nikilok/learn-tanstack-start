import { type SQL, sql } from 'drizzle-orm';

import { ADDRESS_COLUMNS } from '../timeline/curate';
import { type SearchFilters, SIC_SECTIONS, typeRatingsFor } from './params';

// Fragments target the canonical filter-query aliases, which the /search
// server fn's FROM clause must use:
//   hmrc_skilled_workers h
//   LEFT JOIN hmrc_company_mapping m ON m.organisation_name = h.organisation_name
//   LEFT JOIN companies_house_profiles c ON c.company_number = m.company_number
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
  sql`SELECT 1 FROM companies_house_profile_trails t WHERE t.company_number = c.company_number AND t.column_name IN (${inList(ADDRESS_COLUMNS)}) AND t.old_value IS NOT NULL AND t.new_value IS NOT NULL AND t.old_value <> t.new_value AND t.old_value NOT ILIKE '%companies house default address%' AND t.new_value NOT ILIKE '%companies house default address%'`;

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
    // Segment match over both sources: town_city holds comma composites
    // ('Wembley, London') that plain equality can never reach. Runs as a
    // post-join filter by design — a cross-relation OR can't be index-served
    // and the tables are small (~141k rows).
    conds.push(
      sql`EXISTS (SELECT 1 FROM unnest(string_to_array(lower(concat_ws(',', h.town_city, c.locality)), ',')) AS loc(seg) WHERE btrim(loc.seg) = lower(${filters.location}))`,
    );
  }

  const sicParts: SQL[] = [];
  if (filters.sic?.length) {
    sicParts.push(sql`c.sic_codes && ${textArray(filters.sic)}`);
    // Stored codes are 5-digit SIC-2007 (plus a few legacy SIC-2003 values the
    // exact overlap above catches); expand 4-digit input as a 2007 class prefix.
    const classCodes = filters.sic.filter((code) => code.length === 4);
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
