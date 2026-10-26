import { describe, expect, test } from 'bun:test';

import { requestVerdict } from './web-render.ts';

describe('requestVerdict', () => {
  test("a page's document, scripts and data calls load", () => {
    expect(requestVerdict('https://qmx.co.uk/', 'document')).toBe('continue');
    expect(requestVerdict('https://qmx.co.uk/app.js', 'script')).toBe(
      'continue',
    );
    expect(requestVerdict('http://api.qmx.co.uk/team', 'fetch')).toBe(
      'continue',
    );
  });

  test('images, media, fonts and stylesheets never load', () => {
    for (const type of ['image', 'media', 'font', 'stylesheet']) {
      expect(requestVerdict('https://qmx.co.uk/asset', type)).toBe('abort');
    }
  });

  test('in-page data stays in the browser; any other scheme is refused', () => {
    expect(requestVerdict('data:text/plain,hi', 'fetch')).toBe('continue');
    expect(requestVerdict('blob:https://qmx.co.uk/1f2e', 'fetch')).toBe(
      'continue',
    );
    expect(requestVerdict('file:///etc/hosts', 'document')).toBe('abort');
    expect(requestVerdict('ftp://qmx.co.uk/', 'document')).toBe('abort');
  });
});
