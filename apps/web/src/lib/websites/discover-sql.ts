/**
 * Database wiring for search discovery. All SQL lives here so the orchestrator
 * stays testable without a database, as with the sweep's own sql.ts.
 */

import type { DiscoveryOutcome } from './discover';
import type { DiscoveryRow } from './discover-sweep';

type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

/**
 * Mapped sponsors with no website row at all.
 *
 * There is no cursor and no state file: writing a row is what removes a
 * company from this query, so a run that dies halfway simply resumes. The same
 * idiom the sweep uses, and the reason the orchestrator banks candidates
 * before verifying — the row's existence is the record that a credit was spent.
 *
 * Ordered by company number rather than randomly so consecutive runs walk the
 * set predictably and a half-finished slice is easy to reason about.
 */
export function makeSelectUndiscovered(sql: Sql) {
  return async (maxRows: number): Promise<DiscoveryRow[]> => {
    const rows = await sql`
      SELECT DISTINCT ON (m.company_number)
        m.company_number,
        coalesce(p.company_name, '') AS company_name,
        coalesce(nullif(p.locality, ''), p.address_line_2, '') AS town,
        p.postal_code
      FROM hmrc_company_mapping m
      JOIN companies_house_profiles p ON p.company_number = m.company_number
      LEFT JOIN company_websites w ON w.company_number = m.company_number
      WHERE m.company_number IS NOT NULL
        AND w.company_number IS NULL
        -- Nothing to search on, so the credit would be wasted before it is
        -- spent. buildQuery refuses these too; excluding them here keeps them
        -- out of the slice entirely rather than burning rows from it.
        AND coalesce(p.company_name, '') <> ''
      ORDER BY m.company_number
      LIMIT ${maxRows}
    `;
    return rows.map((r) => ({
      companyNumber: r.company_number as string,
      companyName: (r.company_name as string | null) ?? '',
      town: (r.town as string | null) ?? '',
      postcode: (r.postal_code as string | null) ?? null,
    }));
  };
}

/**
 * Record the raw search results against a company, creating the row.
 *
 * Written the moment the results arrive and before anything is fetched: the
 * credit is already spent by then, and the row's existence is what stops the
 * next run paying for the same company. `status` starts at `pending` with no
 * URL, which no render gate can satisfy, so a banked-but-unverified company
 * cannot reach a page.
 */
export function makeBankCandidates(sql: Sql) {
  return async (companyNumber: string, urls: string[]): Promise<void> => {
    await sql`
      INSERT INTO company_websites
        (company_number, url, status, evidence, confidence, source, candidates)
      VALUES (
        ${companyNumber}, NULL, 'pending', 'none', NULL, 'search',
        ${JSON.stringify(urls)}::jsonb
      )
      ON CONFLICT (company_number) DO UPDATE
        SET candidates = excluded.candidates
        -- Never overwrite a real answer with a fresh set of guesses. A row
        -- that already has a URL was decided by a registry or a previous
        -- verification, and this job's job is only to add the raw results.
        WHERE company_websites.url IS NULL
    `;
  };
}

/**
 * Write what the candidates turned out to prove.
 *
 * `checked_at` is deliberately left NULL, exactly as the registry importer
 * leaves it. This job fetched pages to choose between candidates, but the
 * nightly sweep remains the single thing that decides a URL is live and
 * renderable — two jobs claiming that would be two jobs to keep in agreement.
 *
 * The guard mirrors bankCandidates: only a row this job left undecided may be
 * settled by it.
 */
export function makeWriteOutcome(sql: Sql) {
  return async (
    row: DiscoveryRow,
    outcome: DiscoveryOutcome,
    confidence: number,
  ): Promise<boolean> => {
    const updated = await sql`
      UPDATE company_websites SET
        url        = ${outcome.url},
        status     = ${outcome.url ? 'verified' : 'none'},
        evidence   = ${outcome.evidence},
        confidence = ${outcome.url ? confidence.toFixed(3) : null}::numeric
      WHERE company_number = ${row.companyNumber}
        AND url IS NULL
        AND source = 'search'
      RETURNING company_number
    `;
    return updated.length > 0;
  };
}

/** How much of the target population is left, for the run summary. */
export function makeRemaining(sql: Sql) {
  return async (): Promise<{ target: number; discovered: number }> => {
    const rows = await sql`
      WITH mapped AS (
        SELECT DISTINCT company_number AS cn FROM hmrc_company_mapping
        WHERE company_number IS NOT NULL
      )
      SELECT
        (SELECT count(*) FROM mapped
          LEFT JOIN company_websites w ON w.company_number = mapped.cn
          WHERE w.company_number IS NULL)::int AS target,
        (SELECT count(*) FROM company_websites WHERE source = 'search')::int
          AS discovered
    `;
    const r = rows[0];
    return { target: Number(r.target), discovered: Number(r.discovered) };
  };
}
