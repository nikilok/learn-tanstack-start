import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_INIT_SCRIPT } from './search-input-init';

/**
 * Executes the SEARCH_INIT_SCRIPT string in a simulated browser context by
 * evaluating it directly. jsdom provides window, sessionStorage, scrollY and
 * document.documentElement, so we can exercise the real script logic.
 */
function runScript() {
  // biome-ignore lint/security/noGlobalEval: intentional — testing inline script behaviour
  const fn = new Function('window', `${SEARCH_INIT_SCRIPT}`);
  fn(window);
}

describe('SEARCH_INIT_SCRIPT', () => {
  beforeEach(() => {
    // Reset the attribute before each test
    document.documentElement.removeAttribute('data-hide-search-input');
    sessionStorage.clear();
    // Reset scrollY to 0
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
  });

  it('is exported as a non-empty string', () => {
    expect(typeof SEARCH_INIT_SCRIPT).toBe('string');
    expect(SEARCH_INIT_SCRIPT.length).toBeGreaterThan(0);
  });

  it('is a self-invoking function (IIFE) wrapping the logic', () => {
    expect(SEARCH_INIT_SCRIPT.trimStart()).toMatch(/^\(\(\)/);
  });

  it('does NOT set data-hide-search-input when scrollY is 0 and sessionStorage is empty', () => {
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    runScript();
    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(false);
  });

  it('sets data-hide-search-input when scrollY > 0', () => {
    Object.defineProperty(window, 'scrollY', { value: 200, configurable: true, writable: true });
    runScript();
    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(true);
  });

  it('sets data-hide-search-input when hmrc-scroll-y is in sessionStorage', () => {
    sessionStorage.setItem('hmrc-scroll-y', '500');
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    runScript();
    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(true);
  });

  it('sets data-hide-search-input when both scrollY > 0 and sessionStorage key are present', () => {
    sessionStorage.setItem('hmrc-scroll-y', '300');
    Object.defineProperty(window, 'scrollY', { value: 100, configurable: true, writable: true });
    runScript();
    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(true);
  });

  it('sets data-hide-search-input as an empty string (dataset attribute)', () => {
    Object.defineProperty(window, 'scrollY', { value: 1, configurable: true, writable: true });
    runScript();
    // dataset.hideSearchInput maps to data-hide-search-input
    expect(document.documentElement.dataset.hideSearchInput).toBe('');
  });

  it('does not throw when sessionStorage is inaccessible (try/catch guard)', () => {
    // Simulate a scenario where sessionStorage.getItem throws
    const original = window.sessionStorage.getItem.bind(window.sessionStorage);
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => runScript()).not.toThrow();
    vi.restoreAllMocks();
  });

  // Regression: scrollY === 1 (boundary) should trigger the attribute
  it('sets attribute when scrollY equals exactly 1', () => {
    Object.defineProperty(window, 'scrollY', { value: 1, configurable: true, writable: true });
    runScript();
    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(true);
  });
});