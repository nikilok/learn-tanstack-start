import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { CompanyIndustry } from './CompanyIndustry.tsx';

// The codes exist so a reader can lift them into a `sic=` filter search, so
// what matters is that each one renders on its own numbered line NEXT TO its
// own description — asserted on the real markup, not on a string the component
// doesn't use. Block ends become line breaks; every other tag becomes a space
// so adjacent elements stay separate words.
const visibleLines = (entries: { code: string; description: string }[]) =>
  renderToStaticMarkup(<CompanyIndustry entries={entries} />)
    .replace(/<\/(p|li)>/g, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

describe('CompanyIndustry', () => {
  test('numbers each description in series, its code bracketed after it', () => {
    expect(
      visibleLines([
        { code: '35110', description: 'Production of electricity' },
        { code: '43210', description: 'Electrical installation' },
      ]),
    ).toEqual([
      'Industry (SIC Codes)',
      '1 Production of electricity (35110)',
      '2 Electrical installation (43210)',
    ]);
  });

  test('renders nothing when the company has no SIC data', () => {
    expect(renderToStaticMarkup(<CompanyIndustry entries={[]} />)).toBe('');
  });
});
