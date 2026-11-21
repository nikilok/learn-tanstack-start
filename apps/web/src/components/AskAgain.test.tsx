import { describe, expect, spyOn, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { askAgainWhen } from '../lib/ask/cooldown';
import AskAgain from './AskAgain';

describe('AskAgain', () => {
  test('says when asking opens again, as a status, with its ring kept from assistive technology', () => {
    const until = Date.now() + 60 * 60 * 1000;
    const html = renderToStaticMarkup(<AskAgain until={until} />);
    expect(html).toContain('role="status"');
    expect(html).toContain(`You can ask again after ${askAgainWhen(until)}`);
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(1);
    expect(html).not.toContain('<button');
  });

  test('left on the page past midnight, the line it drew the evening before is still the one a fresh render draws', () => {
    // Asking opens again at noon on Sunday 22 November 2026; the tests run in UTC.
    const until = Date.UTC(2026, 10, 22, 12, 0);
    const clock = spyOn(Date, 'now');
    try {
      clock.mockReturnValue(Date.UTC(2026, 10, 21, 23, 30));
      const drawn = renderToStaticMarkup(<AskAgain until={until} />);
      // The clock time is said as the machine's locale says it; the day is named.
      expect(drawn).toMatch(/You can ask again after 12:00(\sPM)? on Sunday</);
      // The page is not drawn again; half past midnight, a fresh one says the same.
      clock.mockReturnValue(Date.UTC(2026, 10, 22, 0, 30));
      expect(renderToStaticMarkup(<AskAgain until={until} />)).toBe(drawn);
    } finally {
      clock.mockRestore();
    }
  });
});
