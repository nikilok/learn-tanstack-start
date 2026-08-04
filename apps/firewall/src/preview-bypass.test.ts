// The bypass is only safe as a pair, so most of what is asserted here is the pairing itself.

import { describe, expect, test } from 'bun:test';

import {
  PREVIEW_BYPASS_RULE,
  PREVIEW_CEILING_RULE,
  previewRules,
  previewTokens,
  unboundedPreviewBypass,
} from './preview-bypass';

const UA = 'WhatsApp,facebookexternalhit';

describe('previewTokens', () => {
  test('absent or blank disables the feature rather than erroring', () => {
    expect(previewTokens(undefined)).toEqual([]);
    expect(previewTokens('')).toEqual([]);
    expect(previewTokens('   ')).toEqual([]);
  });

  test('splits and trims', () => {
    expect(previewTokens(' WhatsApp , Twitterbot ')).toEqual([
      'WhatsApp',
      'Twitterbot',
    ]);
  });

  test('accepts the punctuation real preview UAs use', () => {
    expect(previewTokens('Slackbot-LinkExpanding 1.0,SkypeUriPreview')).toEqual([
      'Slackbot-LinkExpanding 1.0',
      'SkypeUriPreview',
    ]);
  });

  test('rejects a stray comma by position, not value', () => {
    expect(() => previewTokens('WhatsApp,,Twitterbot')).toThrow(/entry #2/);
  });

  test('error names the position and never echoes the entry', () => {
    let message = '';
    try {
      previewTokens('WhatsApp,<script>');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('entry #2');
    expect(message).not.toContain('<script>');
  });
});

describe('previewRules', () => {
  test('no UA list means no rules at all', () => {
    expect(previewRules(undefined, 20)).toEqual([]);
  });

  test('a UA list without a ceiling throws rather than shipping a bare bypass', () => {
    expect(() => previewRules(UA, null)).toThrow(/FW_PREVIEW_LIMIT/);
  });

  test('a zero or bogus ceiling is not a ceiling', () => {
    // Regression: the dry-run limit placeholder is 0, and it satisfied the pairing check.
    expect(() => previewRules(UA, 0)).toThrow(/FW_PREVIEW_LIMIT/);
    expect(() => previewRules(UA, -5)).toThrow(/FW_PREVIEW_LIMIT/);
    expect(() => previewRules(UA, 1.5)).toThrow(/FW_PREVIEW_LIMIT/);
    expect(() => previewRules(UA, Number.NaN)).toThrow(/FW_PREVIEW_LIMIT/);
  });

  test('emits the ceiling BEFORE the bypass', () => {
    const [first, second] = previewRules(UA, 20);
    expect(first.name).toBe(PREVIEW_CEILING_RULE);
    expect(second.name).toBe(PREVIEW_BYPASS_RULE);
  });

  test('the ceiling denies per IP at the configured limit', () => {
    const [ceiling] = previewRules(UA, 20);
    const rl = ceiling.action.mitigate.rateLimit;
    expect(rl?.limit).toBe(20);
    expect(rl?.keys).toEqual(['ip']);
    expect(rl?.action).toBe('deny');
  });

  test('every token reaches the ceiling conditions', () => {
    const [ceiling] = previewRules(UA, 20);
    const values = ceiling.conditionGroup.flatMap((g) =>
      g.conditions.map((c) => c.value),
    );
    expect(values).toEqual(['WhatsApp', 'facebookexternalhit']);
  });

  test('the bypass pairs every token with every scope and nothing else', () => {
    const [, bypass] = previewRules(UA, 20);
    const paths = new Set(
      bypass.conditionGroup.flatMap((g) =>
        g.conditions.filter((c) => c.type === 'path').map((c) => c.value),
      ),
    );
    expect([...paths].sort()).toEqual(['/', '/company/', '/og']);
    // 2 tokens x 3 scopes, each group a UA AND a path.
    expect(bypass.conditionGroup).toHaveLength(6);
    for (const g of bypass.conditionGroup) expect(g.conditions).toHaveLength(2);
  });

  test('the bypass never exposes the RPC surface', () => {
    const [, bypass] = previewRules(UA, 20);
    const paths = bypass.conditionGroup.flatMap((g) =>
      g.conditions.filter((c) => c.type === 'path').map((c) => String(c.value)),
    );
    expect(paths.some((p) => p.startsWith('/_serverFn'))).toBe(false);
    // '/' is matched exactly, so it cannot widen into a prefix over the whole site.
    for (const g of bypass.conditionGroup) {
      const path = g.conditions.find((c) => c.type === 'path');
      if (path?.value === '/') expect(path.op).toBe('eq');
    }
  });

  test('both descriptions stay inside the 256-char cap', () => {
    for (const r of previewRules(UA, 20))
      expect(r.description.length).toBeLessThanOrEqual(256);
  });
});

describe('unboundedPreviewBypass', () => {
  const bypass = { name: PREVIEW_BYPASS_RULE, active: true, action: 'bypass' };
  const ceiling = { name: PREVIEW_CEILING_RULE, active: true, action: 'deny' };

  test('quiet when the pair is intact', () => {
    expect(unboundedPreviewBypass([ceiling, bypass])).toBeUndefined();
  });

  test('quiet when the feature is off entirely', () => {
    expect(unboundedPreviewBypass([])).toBeUndefined();
  });

  test('quiet when the bypass itself is deactivated', () => {
    expect(
      unboundedPreviewBypass([{ ...bypass, active: false }]),
    ).toBeUndefined();
  });

  test('warns when the ceiling is deactivated', () => {
    expect(
      unboundedPreviewBypass([{ ...ceiling, active: false }, bypass]),
    ).toMatch(/DEACTIVATED/);
  });

  test('warns when the ceiling is missing', () => {
    expect(unboundedPreviewBypass([bypass])).toMatch(/MISSING/);
  });

  test('warns when the ceiling only logs', () => {
    expect(
      unboundedPreviewBypass([{ ...ceiling, action: 'log' }, bypass]),
    ).toMatch(/log-only/);
  });
});
