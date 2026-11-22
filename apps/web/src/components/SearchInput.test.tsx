import { describe, expect, test } from 'bun:test';

import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SearchInput from './SearchInput';

/** The box's markup, offering to ask or not. */
const markup = (askEnabled: boolean) =>
  renderToStaticMarkup(
    <SearchInput
      inputRef={createRef<HTMLInputElement>()}
      defaultValue="software companies in Edinburgh"
      onChange={() => {}}
      askEnabled={askEnabled}
    />,
  );

describe('SearchInput', () => {
  test("the box is a form, so a phone keyboard's submit key reaches it as Enter does", () => {
    const html = markup(true);
    expect(html).toStartWith('<form');
    expect(html).toContain('enterKeyHint="search"');
  });

  test('a submit before the script loads keeps the page and the text: the form names no page to load', () => {
    const form = markup(true).match(/^<form[^>]*>/)?.[0] ?? '';
    expect(form).toContain('method="dialog"');
    expect(form).not.toContain('action=');
  });

  test('no button in the box submits it: the arrow, the clear and the search icon each do their own thing', () => {
    for (const askEnabled of [true, false]) {
      const buttons = markup(askEnabled).match(/<button[^>]*>/g) ?? [];
      expect(buttons).toHaveLength(askEnabled ? 3 : 2);
      for (const b of buttons) expect(b).toContain('type="button"');
    }
  });
});
