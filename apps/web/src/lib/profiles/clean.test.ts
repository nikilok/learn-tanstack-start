import { describe, expect, test } from 'bun:test';

import {
  CHARS_PER_TOKEN,
  cleanPageText,
  estimateTokens,
  truncateToTokenBudget,
} from './clean';

describe('cleanPageText', () => {
  test('strips chrome, keeps content', () => {
    const html = `
      <nav><a href="/">Home</a> <a href="/about">About</a></nav>
      <main>
        <h1>Acme Care</h1>
        <p>We provide domiciliary care across Sussex.</p>
      </main>
      <aside>Cookie settings</aside>
      <form><input placeholder="Search"><button>Go</button></form>
      <footer>Registered in England. Company No. 01234567</footer>
      <script>track('page')</script>`;
    const text = cleanPageText(html);
    expect(text).toContain('Acme Care');
    expect(text).toContain('We provide domiciliary care across Sussex.');
    // Chrome is corpus noise. The identity checks (extract.ts) read raw HTML,
    // so stripping the footer here loses nothing they need.
    expect(text).not.toContain('Home');
    expect(text).not.toContain('Cookie settings');
    expect(text).not.toContain('01234567');
    expect(text).not.toContain('track');
  });

  test('an unclosed chrome tag does not swallow the document', () => {
    const html = `<header class="site"><div>Menu</div>
      <p>Real content about our services.</p>`;
    // No </header> anywhere: the open tag must be left for the tag strip
    // rather than eating everything after it.
    expect(cleanPageText(html)).toContain('Real content about our services.');
  });

  test('a commented-out chrome tag does not pair with a later real close', () => {
    // The named production bug: a <form> open inside an HTML comment paired
    // with a real </form> later, deleting the prose between — and the orphaned
    // <!-- then swallowed the rest via visibleText's |$ fallback.
    const html = `<!-- <form class="legacy-signup"> disabled until relaunch -->
      <main><p>We provide domiciliary care across Sussex.</p></main>
      <form><input></form>
      <p>Call us on 01234 567890.</p>`;
    const text = cleanPageText(html);
    expect(text).toContain('We provide domiciliary care across Sussex.');
    expect(text).toContain('Call us on 01234 567890.');
  });

  test('a script string holding a chrome open tag does not swallow content', () => {
    const html = `<script>document.write('<header>x')</script>
      <main><p>Genuine services content here.</p></main>
      <header>Site chrome</header>`;
    expect(cleanPageText(html)).toContain('Genuine services content here.');
  });

  test('a page full of unclosed chrome tags cleans promptly (no EOF scan)', () => {
    // Pathological: hundreds of unclosed <nav> opens in a large body would,
    // unbounded, each lazy-scan to end-of-string. The bounded quantifier keeps
    // it linear. Guard on wall-clock so a regression fails loudly.
    const html = `${'<nav>'.repeat(400)}${'lorem ipsum dolor sit amet '.repeat(40_000)}<p>tail content</p>`;
    const started = Date.now();
    const text = cleanPageText(html);
    // Performance tripwire, deliberately generous: an EOF-scan regression is
    // tens of seconds, while a loaded CI runner is not.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(text).toContain('tail content');
  });

  test('inherits entity decoding and inline-tag fusion', () => {
    expect(cleanPageText('<p>Care &amp; <b>Support</b> Ltd</p>')).toBe(
      'Care & Support Ltd',
    );
  });

  test('collapses whitespace within lines and drops empty ones', () => {
    const html = '<p>  A \t  B  </p>\n\n\n<div></div>\n<p>C</p>';
    expect(cleanPageText(html)).toBe('A B\nC');
  });
});

describe('estimateTokens', () => {
  test('rounds up at the chars-per-token ratio', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(CHARS_PER_TOKEN))).toBe(1);
    expect(estimateTokens('a'.repeat(CHARS_PER_TOKEN + 1))).toBe(2);
  });
});

describe('truncateToTokenBudget', () => {
  test('returns short text unchanged', () => {
    expect(truncateToTokenBudget('short', 100)).toBe('short');
  });

  test('a zero or negative budget yields nothing', () => {
    expect(truncateToTokenBudget('anything', 0)).toBe('');
    expect(truncateToTokenBudget('anything', -5)).toBe('');
  });

  test('cuts at a word boundary in the back half', () => {
    expect(truncateToTokenBudget('aaaa bbbb cccc dddd', 4)).toBe(
      'aaaa bbbb cccc',
    );
  });

  test('hard-cuts when no boundary exists', () => {
    const out = truncateToTokenBudget('a'.repeat(100), 5);
    expect(out).toBe('a'.repeat(5 * CHARS_PER_TOKEN));
  });

  test('property: the budget always holds and output is a prefix', () => {
    // Seeded LCG so a failure reproduces; never Math.random in a test.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const alphabet = ['a', 'bb', 'word ', ' ', '\n', 'line\n', '&', 'é'];
    for (let i = 0; i < 250; i++) {
      let text = '';
      const pieces = Math.floor(rand() * 400);
      for (let p = 0; p < pieces; p++) {
        text += alphabet[Math.floor(rand() * alphabet.length)];
      }
      const budget = Math.floor(rand() * 300);
      const out = truncateToTokenBudget(text, budget);
      expect(estimateTokens(out)).toBeLessThanOrEqual(budget);
      expect(text.startsWith(out)).toBe(true);
    }
  });

  test('a fetch-cap-sized page still lands inside the budget', () => {
    // 2MB is web-fetch's byte cap, so this is the largest cleaned text a
    // snapshot can carry into an ask.
    const out = truncateToTokenBudget('lorem ipsum '.repeat(180_000), 5_000);
    expect(estimateTokens(out)).toBeLessThanOrEqual(5_000);
  });
});
