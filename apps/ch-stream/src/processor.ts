import { createClient } from '@ss/db/client';
import {
  chStreamState,
  companiesHouseProfiles,
  companiesHouseProfileTrails,
} from '@ss/db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from './config.ts';
import { mapProfileToRow } from './mapper.ts';
import type { CHStreamEvent } from './types.ts';

const db = createClient(CONFIG.POSTGRES_URL);

let companyNumbers = new Set<string>();

/**
 * Hydrate the in-memory `companyNumbers` set from the profiles table so stream
 * events can be filtered without a DB round-trip per event. Returns the count
 * of company numbers loaded.
 */
export async function loadCompanyNumbers(): Promise<number> {
  const rows: { companyNumber: string }[] = await db
    .select({ companyNumber: companiesHouseProfiles.companyNumber })
    .from(companiesHouseProfiles);

  companyNumbers = new Set(rows.map((r) => r.companyNumber));
  return companyNumbers.size;
}

/**
 * Fast membership check against the in-memory cache populated by
 * `loadCompanyNumbers`. Used to skip stream events for companies we don't
 * track before hitting the database.
 */
export function hasCompany(companyNumber: string): boolean {
  return companyNumbers.has(companyNumber);
}

/**
 * Coerce a column value to a stable string for diffing old vs new rows.
 * Arrays are sorted before serialisation so reordered-but-equal lists don't
 * register as changes. Returns `null` for `null`/`undefined`.
 */
function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  return String(value);
}

/**
 * Apply a single stream event: skip events for untracked companies or rows
 * without real changes, otherwise update the profile and append per-column
 * trail rows. Returns `true` when the row was updated (or would be, in
 * dry-run mode) and `false` when the event was a no-op.
 */
export async function processEvent(
  event: CHStreamEvent,
  dryRun: boolean,
): Promise<boolean> {
  if (!companyNumbers.has(event.resource_id)) return false;

  if (event.event.type === 'deleted') {
    return processDeletedEvent(event, dryRun);
  }

  const [existing] = await db
    .select()
    .from(companiesHouseProfiles)
    .where(eq(companiesHouseProfiles.companyNumber, event.resource_id))
    .limit(1);

  if (!existing) return false;

  const newRow = mapProfileToRow(event.data);

  const trails: {
    companyNumber: string;
    columnName: string;
    oldValue: string | null;
    newValue: string | null;
  }[] = [];

  for (const col of Object.keys(newRow)) {
    if (col === 'companyNumber' || col === 'companyName') continue;
    const oldVal = stringify(existing[col as keyof typeof existing]);
    const newVal = stringify(newRow[col]);
    if (oldVal !== newVal) {
      trails.push({
        companyNumber: event.resource_id,
        columnName: col,
        oldValue: oldVal,
        newValue: newVal,
      });
    }
  }

  if (trails.length === 0) return false;

  if (dryRun) {
    console.log(
      `[dry-run] Would update ${event.resource_id} (${trails.length} fields):`,
    );
    for (const t of trails) {
      console.log(`  ${t.columnName}: ${t.oldValue} → ${t.newValue}`);
    }
    return true;
  }

  const { companyNumber: _, companyName: __, ...updateFields } = newRow;
  await db
    .update(companiesHouseProfiles)
    .set({ ...updateFields, updatedAt: new Date() })
    .where(eq(companiesHouseProfiles.companyNumber, event.resource_id));

  await db.insert(companiesHouseProfileTrails).values(trails);

  return true;
}

/**
 * Record a `_deleted` trail row for a company removed upstream. The profile
 * row itself is left intact so consumers can still resolve historical data;
 * only the trail reflects the tombstone. Always returns `true`.
 */
async function processDeletedEvent(
  event: CHStreamEvent,
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) {
    console.log(`[dry-run] Would mark ${event.resource_id} as deleted`);
    return true;
  }

  await db.insert(companiesHouseProfileTrails).values({
    companyNumber: event.resource_id,
    columnName: '_deleted',
    oldValue: null,
    newValue: event.event.published_at,
  });

  return true;
}

/**
 * Read the last-committed stream timepoint for the `companies` key. Returns
 * `null` on first run (no state row yet) so the caller can start from the
 * stream's "latest" cursor.
 */
export async function getLastTimepoint(): Promise<number | null> {
  const [row] = await db
    .select()
    .from(chStreamState)
    .where(eq(chStreamState.key, 'companies'))
    .limit(1);
  return row?.lastTimepoint ?? null;
}

/**
 * Upsert the latest processed timepoint for the `companies` key so the
 * stream can resume from this cursor on restart. Called on the configured
 * flush interval rather than per event to keep write volume down.
 */
export async function saveTimepoint(timepoint: number): Promise<void> {
  await db
    .insert(chStreamState)
    .values({
      key: 'companies',
      lastTimepoint: timepoint,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: chStreamState.key,
      set: { lastTimepoint: timepoint, updatedAt: new Date() },
    });
}
