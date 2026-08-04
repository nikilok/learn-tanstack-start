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
  // Regression: returning [] here left an already-applied bypass live forever. applyRule is
  // upsert-only, so the off-switch has to emit a rule that matches nothing, not no rule.
  test('no UA list revokes the pair rather than omitting it', () => {
    const rules = previewRules(undefined, 20);
    expect(rules.map((r) => r.name)).toEqual([
      PREVIEW_CEILING_RULE,
      PREVIEW_BYPASS_RULE,
    ]);
    for (const r of rules) expect(r.description).toContain('REVOKED');
  });

  test('the revoked bypass cannot match any request', () => {
    const [, bypass] = previewRules('', null);
    // Vercel ANDs within a group, and one path cannot be two values.
    expect(bypass.conditionGroup).toHaveLength(1);
    const paths = bypass.conditionGroup[0].conditions.map((c) => c.value);
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    for (const c of bypass.conditionGroup[0].conditions) {
      expect(c.type).toBe('path');
      expect(c.op).toBe('eq');
    }
    // No user_agent condition at all: a spoofed UA has nothing to match.
    expect(
      bypass.conditionGroup.flatMap((g) => g.conditions).some((c) => c.type === 'user_agent'),
    ).toBe(false);
  });

  test('revoking does not demand a ceiling — the documented off-switch must not throw', () => {
    expect(() => previewRules(undefined, null)).not.toThrow();
    expect(() => previewRules('', null)).not.toThrow();
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
    for (const r of [...previewRules(UA, 20), ...previewRules(undefined, null)])
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
