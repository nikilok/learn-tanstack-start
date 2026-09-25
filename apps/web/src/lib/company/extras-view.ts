import type { CompanyExtras, ExtrasOutline } from './extras';

/** Where a page's extras stand: still to come, never coming, or loaded. */
export type ExtrasState =
  | { status: 'pending' }
  | { status: 'unavailable' }
  | { status: 'ready'; extras: CompanyExtras };

/** What the licence-number field renders. */
export type LicenceNumbersView =
  | { kind: 'hidden' }
  | { kind: 'pending'; count: number }
  | { kind: 'shown'; numbers: string[] };

/** What the website section renders. */
export type WebsiteView =
  | { kind: 'hidden' }
  | { kind: 'pending' }
  | { kind: 'shown'; url: string };

const HIDDEN = { kind: 'hidden' } as const;

/** Folds the device readiness and the query result into one state. A null result or a failed query means the extras are not coming for this document. */
export function extrasState(
  readiness: 'waiting' | 'off' | 'ready',
  data: CompanyExtras | null | undefined,
  failed: boolean,
): ExtrasState {
  if (data) return { status: 'ready', extras: data };
  if (data === null || failed || readiness === 'off') {
    return { status: 'unavailable' };
  }
  return { status: 'pending' };
}

/** Loaded numbers win over the outline, which only decides whether space is held while they load. */
export function licenceNumbersView(
  outline: ExtrasOutline,
  state: ExtrasState,
): LicenceNumbersView {
  if (state.status === 'ready') {
    const { licenceNumbers } = state.extras;
    return licenceNumbers.length > 0
      ? { kind: 'shown', numbers: licenceNumbers }
      : HIDDEN;
  }
  if (state.status === 'pending' && outline.licenceNumberCount > 0) {
    return { kind: 'pending', count: outline.licenceNumberCount };
  }
  return HIDDEN;
}

/** Same rule as licenceNumbersView, for the website section. */
export function websiteView(
  outline: ExtrasOutline,
  state: ExtrasState,
): WebsiteView {
  if (state.status === 'ready') {
    const { website } = state.extras;
    return website ? { kind: 'shown', url: website } : HIDDEN;
  }
  if (state.status === 'pending' && outline.hasWebsite) {
    return { kind: 'pending' };
  }
  return HIDDEN;
}

/** The field label, plural when the page holds several numbers — known from the outline before they load. */
export function licenceNumbersLabel(
  view: Exclude<LicenceNumbersView, { kind: 'hidden' }>,
): string {
  const count = view.kind === 'pending' ? view.count : view.numbers.length;
  return count > 1 ? 'Sponsor Licence Nos.' : 'Sponsor Licence No.';
}
