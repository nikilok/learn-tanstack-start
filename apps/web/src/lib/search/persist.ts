import {
  filtersToSearchParams,
  parseSearchFilters,
  type SearchUrlParams,
} from './params';

const STORAGE_KEY = 'ss-filters';

/** Persisted filter set re-validated through the registry; null when absent, empty, or corrupt. */
export function loadStoredFilters(): SearchUrlParams | null {
  try {
    // The access itself must sit inside the try: with site data blocked,
    // even touching `localStorage` throws (Chromium SecurityError), and on
    // the server it's an undeclared ReferenceError — a `typeof` guard shields
    // neither.
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const params = filtersToSearchParams(
      parseSearchFilters(JSON.parse(raw)).filters,
    );
    return Object.keys(params).length ? params : null;
  } catch {
    return null;
  }
}

/** Persist an applied filter set; an empty set clears the store. */
export function storeFilters(params: Record<string, unknown>): void {
  try {
    const clean = filtersToSearchParams(parseSearchFilters(params).filters);
    if (Object.keys(clean).length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* storage unavailable (private mode) — filters just don't persist */
  }
}
