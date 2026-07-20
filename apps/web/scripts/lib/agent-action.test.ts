import { describe, expect, test } from 'bun:test';

import { formatLinksForPrompt, parseAgentAction } from './agent-action';

describe('parseAgentAction', () => {
  test('parses a bare JSON object', () => {
    const action = parseAgentAction('{ "action": "done", "csvUrl": "x", "reasoning": "r" }');
    expect(action.action).toBe('done');
    expect(action.csvUrl).toBe('x');
  });

  test('parses JSON inside a ```json fence', () => {
    const action = parseAgentAction('```json\n{ "action": "click", "url": "/a", "reasoning": "r" }\n```');
    expect(action.action).toBe('click');
    expect(action.url).toBe('/a');
  });

  test('finds JSON outside a fence when the fence holds no object', () => {
    const text = 'See ```/some/link/path``` for context.\n{ "action": "click", "url": "/b", "reasoning": "r" }';
    expect(parseAgentAction(text).url).toBe('/b');
  });

  test('takes the first object when two are present', () => {
    const text = '{ "action": "click", "url": "/first", "reasoning": "r" } or { "action": "done", "csvUrl": "/second", "reasoning": "r" }';
    const action = parseAgentAction(text);
    expect(action.action).toBe('click');
    expect(action.url).toBe('/first');
  });

  test('skips balanced non-JSON brace groups in prose', () => {
    const text = 'set {foo bar} then reply: { "action": "done", "csvUrl": "/c", "reasoning": "r" }';
    expect(parseAgentAction(text).csvUrl).toBe('/c');
  });

  test('handles braces and escapes inside JSON strings', () => {
    const action = parseAgentAction('{ "action": "done", "csvUrl": "/d", "reasoning": "has { brace and \\" quote" }');
    expect(action.reasoning).toContain('{ brace');
  });

  test('throws with the provider label when no JSON exists', () => {
    expect(() => parseAgentAction('no json here', 'Claude')).toThrow(
      /Claude did not return valid JSON/,
    );
  });
});

describe('formatLinksForPrompt', () => {
  const links = [
    { text: 'Sponsor register', href: '/sponsor-register' },
    { text: 'Unrelated news', href: '/news' },
    { text: 'Download CSV', href: '/files/register.csv' },
  ];

  test('anthropic gets the full pretty-printed list unchanged', () => {
    expect(formatLinksForPrompt(links, 'anthropic')).toBe(
      JSON.stringify(links, null, 2),
    );
  });

  test('gemma filters to relevant links and puts .csv hrefs first', () => {
    const parsed = JSON.parse(formatLinksForPrompt(links, 'gemma'));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].href).toBe('/files/register.csv');
    expect(parsed.some((l: { href: string }) => l.href === '/news')).toBe(false);
  });

  test('gemma falls back to all links when nothing matches the filter', () => {
    const none = [{ text: 'plain', href: '/plain' }];
    expect(JSON.parse(formatLinksForPrompt(none, 'gemma'))).toHaveLength(1);
  });

  test('gemma truncates link text to 100 chars and caps at 120 entries', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      text: `sponsor ${'x'.repeat(200)}`,
      href: `/sponsor-${i}`,
    }));
    const parsed = JSON.parse(formatLinksForPrompt(many, 'gemma'));
    expect(parsed).toHaveLength(120);
    expect(parsed[0].text.length).toBe(100);
  });
});
