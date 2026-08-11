import { describe, expect, test } from 'bun:test';

import { renderRunSummary } from './summary';

describe('renderRunSummary', () => {
  test('a crawl run leads with origins and pace', () => {
    const md = renderRunSummary(
      'Profile crawl',
      { origins: 3, pages: 23, 'status:ok': 13 },
      96,
    );
    expect(md).toContain('### Profile crawl');
    expect(md).toContain('**3** origins at **32.0s/origin**');
    expect(md).toContain('| pages | 23 |');
    expect(md).toContain('| status:ok | 13 |');
  });

  test('an extract run adds the insufficient rate', () => {
    const md = renderRunSummary(
      'Profile extract',
      {
        origins: 10,
        answers: 20,
        'answer:what_does:ok': 9,
        'answer:what_does:insufficient_content': 1,
        'answer:offerings:ok': 9,
        'answer:offerings:insufficient_content': 1,
      },
      200,
    );
    expect(md).toContain('**20** answers, **10.0%** insufficient');
  });

  test('empty totals still render a valid table', () => {
    const md = renderRunSummary('Profile crawl', {}, 0);
    expect(md).toContain('| Metric | Count |');
    expect(md).not.toContain('origins at');
  });
});
