// A ranking's ids as an RPC argument or a stored plan carries them: validated
// where they arrive, never trusted for their shape.

import { COMPANY_NUMBER_RE } from '../company/ids';

/** The longest ranking a listing is asked for: the engine's shortlist cap, restated here because this runs in the browser too; its test ties the two. */
export const RANKED_MAX = 400;

/** The ids as given when they are a ranking (1 to RANKED_MAX company numbers); null otherwise. */
export function rankedIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > RANKED_MAX)
    return null;
  const ids = value.filter(
    (id): id is string => typeof id === 'string' && COMPANY_NUMBER_RE.test(id),
  );
  return ids.length === value.length ? ids : null;
}
