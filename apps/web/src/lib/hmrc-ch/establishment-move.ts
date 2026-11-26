/**
 * Moving sponsors joined to an overseas company onto its UK establishment.
 * Every join on the overseas record moves, stored as `manual`, and the
 * record's website row and answers go with it, as both records are the one
 * company. A company is left where it is when one of its joins was made on
 * less than the sponsor's full name, or its website is shown on a proof read
 * against the overseas record. The database and Companies House are passed in.
 */

import { COMPANY_NUMBER_RE } from '../company/ids';
import type { CHFullProfile } from '../phase5/decide';
import type { WebsiteEvidence } from '../websites/decide';
import { ANSWER_RETENTION_STATUSES } from '../websites/publishable';
import { TERMINAL_EVIDENCE } from '../websites/revalidate';
import { MAX_ERRORS_IN_A_ROW, StageError, staged } from './mapping-correction';

/** One listed move: an overseas company, and the establishment its joins move to. */
export type EstablishmentMove = {
  companyNumber: string;
  establishmentNumber: string;
};

/** An establishment as Companies House lists it under an overseas company. */
export type ListedEstablishment = {
  company_number?: unknown;
  company_status?: unknown;
};

/** What Companies House lists under an overseas company comes to: its one open establishment, none open, or several. */
export type EstablishmentChoice =
  | { kind: 'one'; establishmentNumber: string }
  | { kind: 'none' }
  | { kind: 'several' };

/** A stored row: exactly as stored, for the backup, with the hash its write is guarded on. */
export type StoredRow = { stored: Record<string, unknown>; rowHash: string };

/** A join on the overseas company, as stored. */
export type StoredJoin = StoredRow & {
  organisationName: string;
  matchMethod: string | null;
};

/** An answer held for the overseas company, as stored. */
export type StoredAnswer = StoredRow & { id: number };

/** What the database holds for one listed move. */
export type MoveState = {
  /** Every join on the overseas company. */
  joins: StoredJoin[];
  /** Joins already on the establishment. */
  movedJoins: number;
  /** The overseas company's website row. */
  site: StoredRow | null;
  establishmentHasSite: boolean;
  /** Every answer held for the overseas company. */
  answers: StoredAnswer[];
  establishmentAnswers: number;
};

/** How many overseas companies came to each outcome when their establishments were asked for. */
export type FindCounts = {
  one: number;
  none: number;
  several: number;
  failed: number;
};

/** What a listed move comes to for the rows as stored. */
export type MoveKind =
  | 'move'
  | 'already'
  | 'manual'
  | 'weak_join'
  | 'site_bound'
  | 'site_conflict'
  | 'answers_conflict'
  | 'missing';

/** How many listed moves came to each outcome. */
export type MoveCounts = Record<string, number>;

/** The listed moves as read, what each comes to, and what the planned ones carry. */
export type MovePlan = {
  states: Map<string, MoveState>;
  kinds: Map<string, MoveKind>;
  planned: MoveCounts;
  carried: { joins: number; sites: number; answered: number };
};

/** The guarded write of one move, with what it was planned on. */
export type CommitMoveInput = {
  companyNumber: string;
  establishmentNumber: string;
  joins: { organisationName: string; rowHash: string }[];
  siteHash: string | null;
  answers: { id: number; rowHash: string }[];
  changedBy: string;
};

/** The rows one move wrote. */
export type CommitMoveResult = {
  joins: number;
  sites: number;
  answers: number;
};

/** What the writes of a move need from outside. */
export type MoveWrites = {
  /** The establishments Companies House lists under an overseas company now; a throw when it cannot say. */
  fetchEstablishments: (
    companyNumber: string,
  ) => Promise<readonly ListedEstablishment[]>;
  /** The establishment's profile from Companies House; null when it has none to give. */
  fetchProfile: (companyNumber: string) => Promise<CHFullProfile | null>;
  storeProfile: (profile: CHFullProfile) => Promise<void>;
  /** The whole move as one write; null when anything it was planned on has changed. */
  commit: (input: CommitMoveInput) => Promise<CommitMoveResult | null>;
};

/** What writing one move did. */
type MoveOutcome = 'moved' | 'changed' | 'no_profile' | 'not_establishment';

/** A company with nothing stored for it. */
const NOTHING_STORED: MoveState = {
  joins: [],
  movedJoins: 0,
  site: null,
  establishmentHasSite: false,
  answers: [],
  establishmentAnswers: 0,
};

/** Whether a value has the shape of a company number. */
function isCompanyNumber(value: unknown): value is string {
  return typeof value === 'string' && COMPANY_NUMBER_RE.test(value);
}

/** Read a list of moves; a string says what is wrong with it, by position only. */
export function parseEstablishmentMoves(
  raw: unknown,
): EstablishmentMove[] | string {
  if (!Array.isArray(raw)) return 'the list must be an array';
  const seen = new Set<string>();
  const entries: EstablishmentMove[] = [];
  for (const [index, item] of raw.entries()) {
    const { companyNumber, establishmentNumber } = (item ?? {}) as Record<
      string,
      unknown
    >;
    if (!isCompanyNumber(companyNumber)) {
      return `entry ${index}: companyNumber must be a company number`;
    }
    if (!isCompanyNumber(establishmentNumber)) {
      return `entry ${index}: establishmentNumber must be a company number`;
    }
    // Each move is planned on one snapshot of the rows of both its numbers.
    if (
      companyNumber === establishmentNumber ||
      seen.has(companyNumber) ||
      seen.has(establishmentNumber)
    ) {
      return `entry ${index}: a company number is listed twice`;
    }
    seen.add(companyNumber);
    seen.add(establishmentNumber);
    entries.push({ companyNumber, establishmentNumber });
  }
  return entries;
}

/** What the establishments listed under an overseas company come to. */
export function chooseEstablishment(
  items: readonly ListedEstablishment[],
): EstablishmentChoice {
  const open = items.filter((item) => item.company_status === 'open');
  if (open.length > 1) return { kind: 'several' };
  const establishmentNumber = open[0]?.company_number;
  return isCompanyNumber(establishmentNumber)
    ? { kind: 'one', establishmentNumber }
    : { kind: 'none' };
}

/** Whether a profile is the open UK establishment of the given overseas company, by the register's own link. */
export function isOpenEstablishmentOf(
  profile: CHFullProfile,
  companyNumber: string,
): boolean {
  const branch = profile.branch_company_details as
    | { parent_company_number?: unknown }
    | null
    | undefined;
  return (
    profile.type === 'uk-establishment' &&
    profile.company_status === 'open' &&
    branch?.parent_company_number === companyNumber
  );
}

/** Joins made on the sponsor's name in full; one made on less is read by eye before a move stores it as `manual`. */
const FULL_NAME_METHODS: ReadonlySet<string | null> = new Set([
  'exact',
  'exact_squash',
]);

/** A verified tier the company page never shows, so nothing is lost with it. */
const NEVER_SHOWN_EVIDENCE: WebsiteEvidence = 'registry';

/** Whether a website row is shown, or kept to be shown again, on a proof the sweep reads against the company's own record, which would not follow it to another. */
function isShownOnOwnRecord(site: StoredRow | null): boolean {
  if (!site) return false;
  const { status, evidence } = site.stored;
  return (
    (ANSWER_RETENTION_STATUSES as readonly unknown[]).includes(status) &&
    evidence !== NEVER_SHOWN_EVIDENCE &&
    !TERMINAL_EVIDENCE.has(evidence as WebsiteEvidence)
  );
}

/** What a listed move comes to for the rows as stored now. */
export function moveKind(state: MoveState): MoveKind {
  if (state.joins.length === 0) {
    return state.movedJoins > 0 ? 'already' : 'missing';
  }
  // An owner's join is the owner's to move.
  if (state.joins.some((join) => join.matchMethod === 'manual')) {
    return 'manual';
  }
  if (state.joins.some((join) => !FULL_NAME_METHODS.has(join.matchMethod))) {
    return 'weak_join';
  }
  if (isShownOnOwnRecord(state.site)) return 'site_bound';
  // A row of the establishment's own is never written over.
  if (state.site && state.establishmentHasSite) return 'site_conflict';
  if (state.answers.length > 0 && state.establishmentAnswers > 0) {
    return 'answers_conflict';
  }
  return 'move';
}

/** The moves for the given overseas companies: each one with exactly one open establishment. A company that could not be asked is counted as failed and left out. */
export async function findMoves(
  companies: readonly string[],
  fetchEstablishments: MoveWrites['fetchEstablishments'],
): Promise<{ moves: EstablishmentMove[]; found: FindCounts }> {
  const moves: EstablishmentMove[] = [];
  const found: FindCounts = { one: 0, none: 0, several: 0, failed: 0 };
  for (const companyNumber of companies) {
    let listed: readonly ListedEstablishment[];
    try {
      listed = await fetchEstablishments(companyNumber);
    } catch {
      found.failed += 1;
      continue;
    }
    const choice = chooseEstablishment(listed);
    found[choice.kind] += 1;
    if (choice.kind === 'one') {
      moves.push({
        companyNumber,
        establishmentNumber: choice.establishmentNumber,
      });
    }
  }
  return { moves, found };
}

/** Read the listed companies and say what each move comes to. */
export async function planMoves(
  entries: readonly EstablishmentMove[],
  read: (
    entries: readonly EstablishmentMove[],
  ) => Promise<Map<string, MoveState>>,
): Promise<MovePlan> {
  const states = await read(entries);
  const kinds = new Map<string, MoveKind>();
  const planned: MoveCounts = {
    move: 0,
    already: 0,
    manual: 0,
    weak_join: 0,
    site_bound: 0,
    site_conflict: 0,
    answers_conflict: 0,
    missing: 0,
  };
  const carried = { joins: 0, sites: 0, answered: 0 };
  for (const entry of entries) {
    const state = states.get(entry.companyNumber) ?? NOTHING_STORED;
    const kind = moveKind(state);
    kinds.set(entry.companyNumber, kind);
    planned[kind] += 1;
    if (kind !== 'move') continue;
    carried.joins += state.joins.length;
    carried.sites += state.site ? 1 : 0;
    carried.answered += state.answers.length > 0 ? 1 : 0;
  }
  return { states, kinds, planned, carried };
}

/** Write one move. The register is asked again and the establishment's own profile checked and stored first, so a failed write leaves every row as it was. */
async function writeMove(
  entry: EstablishmentMove,
  state: MoveState,
  changedBy: string,
  writes: MoveWrites,
): Promise<[MoveOutcome, CommitMoveResult | null]> {
  const listed = await staged('companies_house', () =>
    writes.fetchEstablishments(entry.companyNumber),
  );
  const choice = chooseEstablishment(listed);
  // The list may be older than the register: another establishment may have opened since.
  if (
    choice.kind !== 'one' ||
    choice.establishmentNumber !== entry.establishmentNumber
  ) {
    return ['not_establishment', null];
  }
  const profile = await staged('companies_house', () =>
    writes.fetchProfile(entry.establishmentNumber),
  );
  // A profile for any other number is not this establishment's.
  if (profile?.company_number !== entry.establishmentNumber) {
    return ['no_profile', null];
  }
  if (!isOpenEstablishmentOf(profile, entry.companyNumber)) {
    return ['not_establishment', null];
  }
  await staged('profile_store', () => writes.storeProfile(profile));
  const done = await staged('move', () =>
    writes.commit({
      companyNumber: entry.companyNumber,
      establishmentNumber: entry.establishmentNumber,
      joins: state.joins.map(({ organisationName, rowHash }) => ({
        organisationName,
        rowHash,
      })),
      siteHash: state.site?.rowHash ?? null,
      answers: state.answers.map(({ id, rowHash }) => ({ id, rowHash })),
      changedBy,
    }),
  );
  return done ? ['moved', done] : ['changed', null];
}

/** Back the planned moves' rows up, then write each; a failed backup writes nothing, and a planned move not written fails the run. */
export async function applyMoves(
  entries: readonly EstablishmentMove[],
  plan: MovePlan,
  deps: MoveWrites & {
    /** Writes every row as stored, or throws having written nothing. */
    backup: (stored: Record<string, unknown>[]) => Promise<void>;
    changedBy: string;
  },
): Promise<{
  applied: MoveCounts | null;
  written: CommitMoveResult;
  failure: string | null;
}> {
  const written: CommitMoveResult = { joins: 0, sites: 0, answers: 0 };
  const planned = entries.flatMap((entry) => {
    const state = plan.states.get(entry.companyNumber);
    return state && plan.kinds.get(entry.companyNumber) === 'move'
      ? [{ entry, state }]
      : [];
  });
  try {
    await deps.backup(
      planned.map(({ entry, state }) => ({
        ...entry,
        joins: state.joins.map((join) => join.stored),
        site: state.site?.stored ?? null,
        answers: state.answers.map((answer) => answer.stored),
      })),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      applied: null,
      written,
      failure: `nothing was written, as the backup failed: ${reason}`,
    };
  }
  const applied: MoveCounts = {
    moved: 0,
    changed: 0,
    no_profile: 0,
    not_establishment: 0,
    errored: 0,
    not_tried: 0,
    left: entries.length - planned.length,
  };
  let errorsInARow = 0;
  let firstError: string | null = null;
  for (const { entry, state } of planned) {
    if (errorsInARow >= MAX_ERRORS_IN_A_ROW) {
      applied.not_tried += 1;
      continue;
    }
    try {
      const [outcome, result] = await writeMove(
        entry,
        state,
        deps.changedBy,
        deps,
      );
      applied[outcome] += 1;
      written.joins += result?.joins ?? 0;
      written.sites += result?.sites ?? 0;
      written.answers += result?.answers ?? 0;
      errorsInARow = 0;
    } catch (error) {
      applied.errored += 1;
      errorsInARow += 1;
      firstError ??= error instanceof StageError ? error.message : 'error';
    }
  }
  // A move planned and not written must not be taken as done by what runs next.
  const unwritten =
    applied.changed +
    applied.no_profile +
    applied.not_establishment +
    applied.errored +
    applied.not_tried;
  const failure =
    unwritten > 0
      ? `${unwritten} planned moves were not written${firstError ? ` (first error: ${firstError})` : ''}; plan again and apply with a new --backup`
      : null;
  return { applied, written, failure };
}
