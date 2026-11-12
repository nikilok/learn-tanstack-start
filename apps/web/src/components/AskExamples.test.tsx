import { describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ASK_EXAMPLES, EXAMPLE_ENTER_MS, letters } from '../lib/ask/examples';
import AskExamples from './AskExamples';

describe('AskExamples', () => {
  test('mounts as one button: "Ask for", the first example letter by letter and whole for assistive technology, nothing erased', () => {
    const html = renderToStaticMarkup(<AskExamples onAsk={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('type="button"');
    expect(html).toContain('>Ask for<');
    // One letter per beat (a space is a beat with no letter), the example whole once, and one example only: no count for one erased.
    expect(html.match(/--i:/g)).toHaveLength(
      letters(ASK_EXAMPLES[0]).filter((letter) => letter !== ' ').length,
    );
    expect(html).toContain(`>${ASK_EXAMPLES[0]}<`);
    expect(html.match(/--n:/g)).toHaveLength(1);
  });

  test('the first example waits for the row to enter before it types', () => {
    const html = renderToStaticMarkup(<AskExamples onAsk={() => {}} />);
    expect(html).toContain(`--wait:${EXAMPLE_ENTER_MS}ms`);
  });
});
