import { describe, expect, test } from 'bun:test';

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
});
