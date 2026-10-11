import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { CompanyScaffold } from './CompanyScaffold.tsx';

// The frame's visible text: the page's titles and link names, never a value. Logos are images, and
// the no-JavaScript note never shows in a browser running the page.
const visibleText = () =>
  renderToStaticMarkup(<CompanyScaffold />)
    .replace(/<svg.*?<\/svg>/gs, ' ')
    .replace(/<noscript>.*?<\/noscript>/s, '')
    .replace(/<\/(p|li|h2|dt|dd|div)>/g, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

describe('CompanyScaffold', () => {
  test('shows the titles of the page and none of its values', () => {
    expect(visibleText()).toEqual([
      'Industry (SIC Codes)',
      '1',
      'Location',
      'Status',
      'Visa Route',
      'Rating',
      'Incorporated',
      'Company Type',
      'Last Accounts Filed',
      'Registration No.',
      'Sponsor Licence No.',
      'Registered Address',
      'About',
      'Timeline',
      'See more on',
      'Google Bing DuckDuckGo LinkedIn',
    ]);
  });

  test('wears the page-flip wrapper, so a navigation that lands on it still morphs', () => {
    expect(renderToStaticMarkup(<CompanyScaffold />)).toContain(
      'class="page-flip-details"',
    );
  });

  test('links nowhere: its pills are inert until the company they name loads', () => {
    expect(renderToStaticMarkup(<CompanyScaffold />)).not.toContain('href=');
  });

  test('says it is loading, and tells a browser without JavaScript what it needs', () => {
    const html = renderToStaticMarkup(<CompanyScaffold />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/<noscript>.*Turn on JavaScript.*<\/noscript>/s);
  });
});
