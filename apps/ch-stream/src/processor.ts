import { createClient } from '@ss/db/client';
import {
  chStreamState,
  companiesHouseProfiles,
  companiesHouseProfileTrails,
} from '@ss/db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from './config.ts';
import {
  DIFFABLE_COLUMNS,
  type DiffableColumn,
  mapProfileToRow,
} from './mapper.ts';
import type { CHStreamEvent } from './types.ts';

const db = createClient(CONFIG.POSTGRES_URL);

let companyNumbers = new Set<string>();

export async function loadCompanyNumbers(): Promise<number> {
  const rows: { companyNumber: string }[] = await db
    .select({ companyNumber: companiesHouseProfiles.companyNumber })
    .from(companiesHouseProfiles);

  companyNumbers = new Set(rows.map((r) => r.companyNumber));
  return companyNumbers.size;
}

export function hasCompany(companyNumber: string): boolean {
  return companyNumbers.has(companyNumber);
}

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  return String(value);
}

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

  for (const col of DIFFABLE_COLUMNS) {
    const oldVal = stringify(existing[col as keyof typeof existing]);
    const newVal = stringify(newRow[col as DiffableColumn]);
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

  const { companyNumber: _, ...updateFields } = newRow;
  await db
    .update(companiesHouseProfiles)
    .set({ ...updateFields, updatedAt: new Date() })
    .where(eq(companiesHouseProfiles.companyNumber, event.resource_id));

  await db.insert(companiesHouseProfileTrails).values(trails);

  return true;
}

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

export async function getLastTimepoint(): Promise<number | null> {
  const [row] = await db
    .select()
    .from(chStreamState)
    .where(eq(chStreamState.key, 'companies'))
    .limit(1);
  return row?.lastTimepoint ?? null;
}

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
