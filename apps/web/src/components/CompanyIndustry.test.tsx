import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { CompanyIndustry } from './CompanyIndustry.tsx';

// The codes exist so a reader can lift them into a `sic=` filter search, so
// what matters is that each one is rendered NEXT TO its own description —
// asserted on the real markup, not on a string the component doesn't use.
const visibleText = (entries: { code: string; description: string }[]) =>
  renderToStaticMarkup(<CompanyIndustry entries={entries} />).replace(
    /<[^>]*>/g,
    '',
  );

describe('CompanyIndustry', () => {
  test('shows every SIC code bracketed after its own description', () => {
    expect(
      visibleText([
        { code: '35110', description: 'Production of electricity' },
        { code: '43210', description: 'Electrical installation' },
      ]),
    ).toBe(
      'Industry (SIC Codes)Production of electricity (35110), Electrical installation (43210)',
    );
  });

  test('renders nothing when the company has no SIC data', () => {
    expect(renderToStaticMarkup(<CompanyIndustry entries={[]} />)).toBe('');
  });
});
