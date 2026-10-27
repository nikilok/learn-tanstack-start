/**
 * The site picker the fallback job asks: a module outside this repo, which
 * the job's workflow installs and names by path in PICKER_MODULE. Loaded and
 * checked before any row is read, so a missing or broken install stops the
 * run there. The key goes to the module and nowhere else.
 */

import { pathToFileURL } from 'node:url';

import type {
  Picker,
  PickerAnswer,
  PickerCandidate,
  PickerCompany,
} from '../../src/lib/websites/fallback.ts';

const REASONS = new Set<string>([
  'picked',
  'below_threshold',
  'no_candidates',
  'unavailable',
]);

/** Whether a value is an answer the fallback can read: a choice exactly when it says it picked. */
export function isPickerAnswer(value: unknown): value is PickerAnswer {
  if (value === null || typeof value !== 'object') return false;
  const answer = value as Record<string, unknown>;
  return (
    (answer.pick === null || typeof answer.pick === 'string') &&
    typeof answer.reason === 'string' &&
    REASONS.has(answer.reason) &&
    typeof answer.tokens === 'number' &&
    Number.isFinite(answer.tokens) &&
    (answer.reason === 'picked') === (answer.pick !== null)
  );
}

/** The module's export, as the fallback calls it. */
type PickSite = (
  company: PickerCompany,
  candidates: PickerCandidate[],
  options: { apiKey: string },
) => Promise<unknown>;

/** A company with no candidates: answered without a request, so the start-up check spends nothing. */
const PROBE: PickerCompany = {
  number: '00000000',
  name: 'PROBE',
  sponsorNames: [],
  towns: [],
  locality: null,
  postcode: null,
  incorporated: null,
  trades: [],
};

/** Load the picker at `modulePath` with its key, or throw before any row is read. */
export async function loadPicker(
  modulePath: string | undefined,
  apiKey: string | undefined,
  importModule: (url: string) => Promise<unknown> = (url) => import(url),
): Promise<Picker> {
  if (!modulePath) throw new Error('PICKER_MODULE is not set');
  if (!apiKey) throw new Error('PICKER_API_KEY is not set');
  const loaded = (await importModule(pathToFileURL(modulePath).href)) as {
    pickSite?: unknown;
  } | null;
  const pickSite = loaded?.pickSite;
  if (typeof pickSite !== 'function') {
    throw new Error('The picker module exports no pickSite');
  }
  const ask = pickSite as PickSite;
  const probe = await ask(PROBE, [], { apiKey });
  if (!isPickerAnswer(probe) || probe.reason !== 'no_candidates') {
    throw new Error('The picker module answered outside its contract');
  }
  return async (company, candidates) => {
    const answer = await ask(company, candidates, { apiKey });
    if (!isPickerAnswer(answer)) {
      throw new Error('The picker answered outside its contract');
    }
    return answer;
  };
}
