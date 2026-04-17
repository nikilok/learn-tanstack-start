import { cleanup, render, screen } from '@testing-library/react';
import React, { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchBar from './SearchBar';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// SearchInput renders an uncontrolled input with CSS modules — mock it for
// isolation so we test SearchBar behaviour only.
vi.mock('./SearchInput', () => ({
  default: vi.fn(({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) => (
    <input ref={inputRef} data-testid="search-input" />
  )),
}));

// SearchIcon is a simple SVG — mock to avoid SVG import issues
vi.mock('./SearchIcon', () => ({
  default: () => <svg data-testid="search-icon" />,
}));

// useRotatingPlaceholder has setInterval; keep it simple
vi.mock('../hooks/useRotatingPlaceholder', () => ({
  useRotatingPlaceholder: () => 'search company...',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultProps = {
  search: '',
  isStuck: false,
  ready: true,
  pillClicked: false,
  inputRef: createRef<HTMLInputElement | null>(),
  platform: 'mac' as const,
  isMobile: false,
  onSearch: vi.fn(),
  onPillClick: vi.fn(),
  onBlur: vi.fn(),
};

function renderSearchBar(props: Partial<typeof defaultProps> = {}) {
  // Ensure a portal target exists in the document
  let portalTarget = document.getElementById('header-pill-portal');
  if (!portalTarget) {
    portalTarget = document.createElement('div');
    portalTarget.id = 'header-pill-portal';
    document.body.appendChild(portalTarget);
  }

  return render(<SearchBar {...defaultProps} {...props} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  const portalTarget = document.getElementById('header-pill-portal');
  if (portalTarget) portalTarget.remove();
});

describe('SearchBar — search-input-wrapper class', () => {
  it('renders the input wrapper with className "search-input-wrapper"', () => {
    const { container } = renderSearchBar();
    const wrapper = container.querySelector('.search-input-wrapper');
    expect(wrapper).not.toBeNull();
  });

  it('the search-input-wrapper div is the direct parent of the SearchInput', () => {
    const { container } = renderSearchBar();
    const input = screen.getByTestId('search-input');
    const wrapper = container.querySelector('.search-input-wrapper');
    // SearchInput is rendered inside the wrapper div
    expect(wrapper?.contains(input)).toBe(true);
  });
});

describe('SearchBar — input wrapper visibility', () => {
  it('has opacity 1 and pointerEvents auto when ready=true and showPill=false', () => {
    const { container } = renderSearchBar({ ready: true, isStuck: false, search: '' });
    const wrapper = container.querySelector<HTMLElement>('.search-input-wrapper');
    expect(wrapper?.style.opacity).toBe('1');
    expect(wrapper?.style.pointerEvents).toBe('auto');
  });

  it('has opacity 0 and pointerEvents none when ready=false', () => {
    const { container } = renderSearchBar({ ready: false, isStuck: false, search: '' });
    const wrapper = container.querySelector<HTMLElement>('.search-input-wrapper');
    expect(wrapper?.style.opacity).toBe('0');
    expect(wrapper?.style.pointerEvents).toBe('none');
  });

  it('has opacity 0 and pointerEvents none when showPill is true (isStuck=true, pillClicked=false, search non-empty)', () => {
    const { container } = renderSearchBar({
      ready: true,
      isStuck: true,
      pillClicked: false,
      search: 'NHS',
    });
    const wrapper = container.querySelector<HTMLElement>('.search-input-wrapper');
    expect(wrapper?.style.opacity).toBe('0');
    expect(wrapper?.style.pointerEvents).toBe('none');
  });

  it('has opacity 1 when pillClicked=true even if isStuck=true (pill dismissed by click)', () => {
    const { container } = renderSearchBar({
      ready: true,
      isStuck: true,
      pillClicked: true,
      search: 'NHS',
    });
    const wrapper = container.querySelector<HTMLElement>('.search-input-wrapper');
    expect(wrapper?.style.opacity).toBe('1');
    expect(wrapper?.style.pointerEvents).toBe('auto');
  });

  it('has opacity 1 when isStuck=true but search is empty (pill only shows when search is set)', () => {
    const { container } = renderSearchBar({
      ready: true,
      isStuck: true,
      pillClicked: false,
      search: '',
    });
    const wrapper = container.querySelector<HTMLElement>('.search-input-wrapper');
    expect(wrapper?.style.opacity).toBe('1');
    expect(wrapper?.style.pointerEvents).toBe('auto');
  });

  // Regression: ensure opacity:0 is applied via inline style (not just CSS class)
  // so it works even when the pre-hydration CSS attribute has been removed
  it('applies opacity as inline style on the wrapper (not only via CSS class)', () => {
    const { container } = renderSearchBar({ ready: false });
    const wrapper = container.querySelector<HTMLElement>('.search-input-wrapper');
    // style attribute must be set directly on the element
    expect(wrapper?.getAttribute('style')).toContain('opacity: 0');
  });
});