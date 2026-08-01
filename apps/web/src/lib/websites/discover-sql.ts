/**
 * Database wiring for search discovery. All SQL lives here so the orchestrator
 * stays testable without a database, as with the sweep's own sql.ts.
 */

import type { DiscoveryOutcome } from './discover';
import type { DiscoveryRow } from './discover-sweep';

/**
 * Passes a banked-but-unsettled row gets before it is left alone.
 *
 * Three is enough to ride out a transient outage across three nightly runs
 * without letting a permanently unreachable set of candidates monopolise the
 * front of the queue.
 */
export const MAX_DISCOVERY_ATTEMPTS = 3;

type Sql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

/**
 * Companies still to search: no website row at all, OR one this job banked
 * candidates for and never got to settle.
 *
 * That second clause is load-bearing. Row EXISTENCE used to be the resume
 * marker, and because candidates are banked before any page is fetched, a
 * company whose probe threw — one socket hang-up — was left at `pending` with
 * no URL and excluded from every future slice. Its credit was spent and its
 * answer never written, permanently. Completeness, not existence, is the
 * marker: an undecided row this job owns comes back round.
 *
 * Scoped to `source = 'search'` so it can never adopt a row another discoverer
 * left undecided; those belong to whoever created them.
 *
 * Bounded by failure_count. Readmitting undecided rows fixed a permanent
 * stall, but with no cap it created a slower one: the order is by company
 * number, so a row that can never settle — every candidate host dead, results
 * banked — sorts to the front of every future slice and is retried forever,
 * ahead of companies never searched at all. Enough of them and the run does
 * nothing but re-probe the same dead hosts behind a green tick. After
 * MAX_DISCOVERY_ATTEMPTS the row stops being selected; its candidates stay on
 * it, so a future decision to revisit them costs no credit.
 *
 * Still no cursor and no state file. Ordered by company number rather than
 * randomly so consecutive runs walk the set predictably.
 */
export function makeSelectUndiscovered(sql: Sql) {
  return async (maxRows: number): Promise<DiscoveryRow[]> => {
    const rows = await sql`
      SELECT DISTINCT ON (m.company_number)
        m.company_number,
        coalesce(p.company_name, '') AS company_name,
        coalesce(nullif(p.locality, ''), p.address_line_2, '') AS town,
        p.postal_code,
        -- Carried so a retry can reuse what the failed pass already paid for.
        w.candidates
      FROM hmrc_company_mapping m
      JOIN companies_house_profiles p ON p.company_number = m.company_number
      LEFT JOIN company_websites w ON w.company_number = m.company_number
      WHERE m.company_number IS NOT NULL
        AND (
          w.company_number IS NULL
          OR (
            w.status = 'pending' AND w.source = 'search' AND w.url IS NULL
            AND coalesce(w.failure_count, 0) < ${MAX_DISCOVERY_ATTEMPTS}
          )
        )
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
      bankedCandidates: Array.isArray(r.candidates)
        ? (r.candidates as string[])
        : null,
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
        -- Never overwrite a real answer with a fresh set of guesses, and never
        -- touch a row another discoverer owns. The source check is not
        -- redundant with the url check: a registry row left undecided would
        -- otherwise have its candidates set here while keeping source='cqc',
        -- and makeWriteOutcome's own source guard would then refuse to settle
        -- it — banked, charged, and unresolvable.
        WHERE company_websites.url IS NULL
          AND company_websites.source = 'search'
    `;
  };
}

/**
 * Record that a pass took a row and could not settle it.
 *
 * The counter is what stops an unsettleable row being retried forever, and it
 * is deliberately separate from writing an outcome: an outcome is a decision,
 * this is only a note that a decision could not be reached.
 */
export function makeMarkAttempt(sql: Sql) {
  return async (companyNumber: string): Promise<void> => {
    await sql`
      UPDATE company_websites
        SET failure_count = coalesce(failure_count, 0) + 1
      WHERE company_number = ${companyNumber}
        AND url IS NULL
        AND source = 'search'
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

/**
 * How much of the target population is left, for the run summary.
 *
 * The target predicate mirrors makeSelectUndiscovered exactly, including the
 * readmitted-undecided clause and the attempt cap. Defined as "has no row at
 * all" it disagreed with the thing it describes in both directions: a banked
 * row still due a retry counted as done, and the operator watching the number
 * fall to zero would have concluded the population was covered while the job
 * still had work queued.
 */
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
          WHERE w.company_number IS NULL
             OR (
               w.status = 'pending' AND w.source = 'search' AND w.url IS NULL
               AND coalesce(w.failure_count, 0) < ${MAX_DISCOVERY_ATTEMPTS}
             ))::int AS target,
        (SELECT count(*) FROM company_websites
          WHERE source = 'search' AND url IS NOT NULL)::int
          AS discovered
    `;
    const r = rows[0];
    return { target: Number(r.target), discovered: Number(r.discovered) };
  };
}
