import { describe, expect, test } from 'bun:test';

import { upsertEnvLine } from './env-file';

describe('upsertEnvLine', () => {
  test('replaces an existing assignment in place', () => {
    const out = upsertEnvLine('A=1\nFW_BLOCKED_JA4=old\nB=2\n', 'FW_BLOCKED_JA4', 'new');
    expect(out).toBe('A=1\nFW_BLOCKED_JA4=new\nB=2\n');
  });

  test('appends when the key is absent, with one trailing newline', () => {
    expect(upsertEnvLine('A=1\n', 'K', 'v')).toBe('A=1\nK=v\n');
    expect(upsertEnvLine('A=1', 'K', 'v')).toBe('A=1\nK=v\n');
  });

  test('creates the assignment in an empty file', () => {
    expect(upsertEnvLine('', 'K', 'v')).toBe('K=v\n');
  });

  test('leaves comments and unrelated keys untouched', () => {
    const src = '# firewall\nFW_SERVERFN_LIMIT=300\n\n# denies\nFW_BLOCKED_ASN=29066\n';
    const out = upsertEnvLine(src, 'FW_BLOCKED_JA4', 'abc');
    expect(out).toContain('# firewall');
    expect(out).toContain('FW_SERVERFN_LIMIT=300');
    expect(out).toContain('FW_BLOCKED_ASN=29066');
    expect(out).toContain('FW_BLOCKED_JA4=abc');
  });

  test('does not match a key that merely shares a prefix', () => {
    const out = upsertEnvLine('FW_BLOCKED_JA4_EXTRA=x\n', 'FW_BLOCKED_JA4', 'v');
    expect(out).toContain('FW_BLOCKED_JA4_EXTRA=x');
    expect(out).toContain('FW_BLOCKED_JA4=v');
  });

  test('a commented-out line is not treated as the assignment', () => {
    const out = upsertEnvLine('#FW_BLOCKED_JA4=old\n', 'FW_BLOCKED_JA4', 'new');
    expect(out).toContain('#FW_BLOCKED_JA4=old');
    expect(out).toContain('FW_BLOCKED_JA4=new');
  });

  test('the last of a duplicated key wins, matching how loaders resolve it', () => {
    const out = upsertEnvLine('K=a\nK=b\n', 'K', 'c');
    expect(out).toBe('K=a\nK=c\n');
  });

  test('an export-prefixed assignment is replaced, not duplicated', () => {
    expect(upsertEnvLine('export K=a\n', 'K', 'b')).toBe('K=b\n');
  });

  test('setting an empty value is preserved — that is how a denylist is revoked', () => {
    expect(upsertEnvLine('K=a\n', 'K', '')).toBe('K=\n');
  });
});
