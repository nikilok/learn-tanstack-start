import { sicCodes } from '@ss/db';
import { inArray } from 'drizzle-orm';

import { db } from '../db.server';

/** Resolve SIC codes to descriptions; unknown codes are simply absent from the result. */
export async function loadSicDescriptions(
  codes: string[],
): Promise<{ code: string; description: string }[]> {
  if (codes.length === 0) return [];
  return db
    .select({ code: sicCodes.code, description: sicCodes.description })
    .from(sicCodes)
    .where(inArray(sicCodes.code, codes));
}
