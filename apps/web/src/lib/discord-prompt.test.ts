import { describe, expect, test } from 'bun:test';

import {
  afterPrompt,
  canPrompt,
  DISCORD_PROMPT_DISMISSED,
  MAX_DISCORD_PROMPTS,
  promptsShown,
} from './discord-prompt.ts';

describe('promptsShown', () => {
  test('reads a fresh reader as nothing seen', () => {
    expect(promptsShown(null)).toBe(0);
    expect(promptsShown('')).toBe(0);
  });

  test('reads a click-through as past any cap', () => {
    expect(promptsShown(DISCORD_PROMPT_DISMISSED)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test('ignores a value that is not a whole count', () => {
    // Storage is shared with anything else on the origin, so a hand-edited or
    // half-written value must read as "start again", never as NaN.
    for (const raw of ['abc', '2.5', '-1', '0', ' ', '1e3?']) {
      expect(promptsShown(raw)).toBe(0);
    }
  });
});

describe('canPrompt', () => {
  test('allows exactly the budgeted number of prompts', () => {
    let raw: string | null = null;
    let shown = 0;
    while (canPrompt(raw)) {
      raw = afterPrompt(raw);
      shown += 1;
      // A budget that never closes would prompt for eternity, which is the bug
      // this module exists to prevent.
      expect(shown).toBeLessThanOrEqual(MAX_DISCORD_PROMPTS);
    }
    expect(shown).toBe(MAX_DISCORD_PROMPTS);
  });

  test('stops the moment the reader clicks through', () => {
    expect(canPrompt(afterPrompt(null))).toBe(true);
    expect(canPrompt(DISCORD_PROMPT_DISMISSED)).toBe(false);
  });
});

describe('afterPrompt', () => {
  test('counts one completed prompt at a time', () => {
    expect(afterPrompt(null)).toBe('1');
    expect(afterPrompt('1')).toBe('2');
    expect(afterPrompt('2')).toBe('3');
  });

  test('never counts past the cap', () => {
    expect(afterPrompt(String(MAX_DISCORD_PROMPTS))).toBe(
      String(MAX_DISCORD_PROMPTS),
    );
    expect(afterPrompt('99')).toBe(String(MAX_DISCORD_PROMPTS));
  });

  test('leaves a click-through dismissed rather than counting it back down', () => {
    // Overwriting the sentinel with a number would put a reader who already
    // clicked back in the queue as soon as the cap moved.
    expect(afterPrompt(DISCORD_PROMPT_DISMISSED)).toBe(
      DISCORD_PROMPT_DISMISSED,
    );
  });
});
