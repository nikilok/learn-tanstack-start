import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSearchPill } from './useSearchPill';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock useSearchShortcut so it doesn't register global keyboard listeners
vi.mock('./useSearchShortcut', () => ({
  useSearchShortcut: vi.fn(),
}));

// Minimal IntersectionObserver mock
class MockIntersectionObserver {
  private callback: IntersectionObserverCallback;
  static instances: MockIntersectionObserver[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  // Helper: fire the observer callback with synthetic entries
  trigger(entries: Partial<IntersectionObserverEntry>[]) {
    this.callback(
      entries.map((e) => ({
        isIntersecting: false,
        intersectionRatio: 0,
        boundingClientRect: {} as DOMRectReadOnly,
        intersectionRect: {} as DOMRectReadOnly,
        rootBounds: null,
        target: document.createElement('div'),
        time: 0,
        ...e,
      })) as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

// Helpers to create stable refs
function makeInputRef() {
  return { current: document.createElement('input') };
}

function makeSentinelRef() {
  return { current: document.createElement('div') };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

  // Reset DOM attribute
  document.documentElement.removeAttribute('data-hide-search-input');

  // Reset sessionStorage
  sessionStorage.clear();

  // Reset scrollY
  Object.defineProperty(window, 'scrollY', {
    value: 0,
    configurable: true,
    writable: true,
  });

  // Use fake timers for setTimeout-based debouncing and rAF
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-hide-search-input');
  sessionStorage.clear();
});

// ---------------------------------------------------------------------------
// Tests — clearHideAttribute (the new helper function)
// ---------------------------------------------------------------------------

describe('clearHideAttribute (via useLayoutEffect when isStuck)', () => {
  it('removes data-hide-search-input from documentElement when isStuck becomes true', () => {
    document.documentElement.setAttribute('data-hide-search-input', '');
    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(true);

    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    renderHook(() => useSearchPill(inputRef, sentinelRef));

    // Trigger the IntersectionObserver to set isStuck = true
    act(() => {
      MockIntersectionObserver.instances[0]?.trigger([{ isIntersecting: false }]);
    });

    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(false);
  });

  it('does NOT remove data-hide-search-input when sentinel is intersecting (isStuck = false)', async () => {
    document.documentElement.setAttribute('data-hide-search-input', '');

    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    renderHook(() => useSearchPill(inputRef, sentinelRef));

    // Trigger intersecting (sentinel visible) — isStuck stays false
    act(() => {
      MockIntersectionObserver.instances[0]?.trigger([{ isIntersecting: true }]);
    });

    // Advance past the 150ms debounce so the isStuck=false state is applied
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // The attribute should still be present because clearHideAttribute only
    // fires when isStuck is true
    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — ready initial state
// ---------------------------------------------------------------------------

describe('ready state', () => {
  it('starts as true (not false) on initial render', () => {
    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    const { result } = renderHook(() => useSearchPill(inputRef, sentinelRef));

    expect(result.current.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — pagehide effect
// ---------------------------------------------------------------------------

describe('pagehide listener', () => {
  it('saves scrollY to sessionStorage when scrollY > 0 on pagehide', () => {
    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    renderHook(() => useSearchPill(inputRef, sentinelRef));

    Object.defineProperty(window, 'scrollY', {
      value: 350,
      configurable: true,
      writable: true,
    });

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(sessionStorage.getItem('hmrc-scroll-y')).toBe('350');
  });

  it('does NOT save to sessionStorage when scrollY is 0 on pagehide', () => {
    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    renderHook(() => useSearchPill(inputRef, sentinelRef));

    Object.defineProperty(window, 'scrollY', {
      value: 0,
      configurable: true,
      writable: true,
    });

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(sessionStorage.getItem('hmrc-scroll-y')).toBeNull();
  });

  it('saves the exact scrollY value as a string', () => {
    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    renderHook(() => useSearchPill(inputRef, sentinelRef));

    Object.defineProperty(window, 'scrollY', {
      value: 1234,
      configurable: true,
      writable: true,
    });

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(sessionStorage.getItem('hmrc-scroll-y')).toBe('1234');
  });

  it('removes the pagehide listener on unmount', () => {
    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    const { unmount } = renderHook(() => useSearchPill(inputRef, sentinelRef));
    unmount();

    Object.defineProperty(window, 'scrollY', {
      value: 999,
      configurable: true,
      writable: true,
    });

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    // After unmount the listener should be removed, so nothing is stored
    expect(sessionStorage.getItem('hmrc-scroll-y')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — safety-net double-rAF effect
// ---------------------------------------------------------------------------

describe('safety-net effect (double rAF cleanup)', () => {
  it('removes attribute after two rAFs when scrollY is 0 and no sessionStorage key', async () => {
    document.documentElement.setAttribute('data-hide-search-input', '');

    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    renderHook(() => useSearchPill(inputRef, sentinelRef));

    // Simulate two animation frames
    act(() => {
      vi.runAllTimers();
    });

    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(false);
  });

  it('does NOT remove attribute after rAFs when scrollY > 0', async () => {
    document.documentElement.setAttribute('data-hide-search-input', '');
    Object.defineProperty(window, 'scrollY', {
      value: 100,
      configurable: true,
      writable: true,
    });

    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    renderHook(() => useSearchPill(inputRef, sentinelRef));

    act(() => {
      vi.runAllTimers();
    });

    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(true);
  });

  it('does NOT remove attribute after rAFs when hmrc-scroll-y is in sessionStorage', async () => {
    document.documentElement.setAttribute('data-hide-search-input', '');
    sessionStorage.setItem('hmrc-scroll-y', '300');

    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    renderHook(() => useSearchPill(inputRef, sentinelRef));

    act(() => {
      vi.runAllTimers();
    });

    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(true);
  });

  it('skips the safety-net effect when attribute is not present', () => {
    // Attribute is absent — the effect returns early
    expect(document.documentElement.hasAttribute('data-hide-search-input')).toBe(false);

    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    renderHook(() => useSearchPill(inputRef, sentinelRef));

    // No rAF should have been scheduled by the safety-net effect
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('cancels pending rAFs when the hook unmounts', () => {
    document.documentElement.setAttribute('data-hide-search-input', '');
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');

    const inputRef = makeInputRef();
    const sentinelRef = makeSentinelRef();

    const { unmount } = renderHook(() => useSearchPill(inputRef, sentinelRef));

    // Unmount before rAFs fire
    unmount();

    expect(cancelSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — return values (unchanged API, but validate ready=true)
// ---------------------------------------------------------------------------

describe('hook return values', () => {
  it('returns the expected shape', () => {
    const { result } = renderHook(() =>
      useSearchPill(makeInputRef(), makeSentinelRef()),
    );

    expect(result.current).toMatchObject({
      isStuck: false,
      ready: true,
      pillClicked: false,
      onPillClick: expect.any(Function),
      onPillDismiss: expect.any(Function),
    });
  });

  it('onPillClick sets pillClicked to true', () => {
    const { result } = renderHook(() =>
      useSearchPill(makeInputRef(), makeSentinelRef()),
    );

    act(() => {
      result.current.onPillClick();
    });

    expect(result.current.pillClicked).toBe(true);
  });

  it('onPillDismiss sets pillClicked to false', () => {
    const { result } = renderHook(() =>
      useSearchPill(makeInputRef(), makeSentinelRef()),
    );

    act(() => {
      result.current.onPillClick();
    });
    act(() => {
      result.current.onPillDismiss();
    });

    expect(result.current.pillClicked).toBe(false);
  });
});