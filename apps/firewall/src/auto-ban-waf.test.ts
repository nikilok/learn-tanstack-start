// The armed path's effects. Applying to the WAF alone is not a ban that survives: the operator's
// own apply rebuilds the deny rule from .env.local, so a digest missing there is lifted the next
// time anyone presses `a`. These cover the half that makes it stick.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Pushed BEFORE the imports below resolve it. Without it `envPath()` is the REPO's .env.local and
// these tests would rewrite the operator's real denylist.
process.argv.push('--mock');

// Stubbed BEFORE auto-ban-waf resolves it. `notify` spawns osascript on darwin, so the real one
// would fire a desktop notification — or an iMessage — every time this file runs.
// Detached snapshot, per watch-assembly.test.ts: mock.module writes over the live namespace.
const realNotify = { ...(await import('./watch-notify')) };
const notified: string[] = [];
mock.module('./watch-notify', () => ({
  ...realNotify,
  notify: async (body: string) => {
    notified.push(body);
    return null;
  },
}));

const { envPath } = await import('./hooks/useDenylist');
const { installWafBackend } = await import('./client');
const { editLiveJa4Deny } = await import('./auto-ban-waf');
const { JA4_RULE } = await import('./deny-staging');
const { JA4_DENY, valuesOf } = await import('./deny-list');
const { TEST_DENIED_JA4 } = await import('./test-setup');
const { maybeAutoBan } = await import('./auto-ban-waf');
const { AUTO_BAN_UNTIL } = await import('./auto-ban');
const { persistEnvVar, readFwVars } = await import('./env-file');
const { liftExpiredAutoBans } = await import('./auto-ban-waf');
const { parseExpiries, serialiseExpiries } = await import('./auto-ban');

const NEW = 't13dscrp00_aaaaaaaaaaaa_bbbbbbbbbbbb';
const applied: { values: string[] }[] = [];

beforeAll(() => {
  installWafBackend({
    fetchLive: async () =>
      ({
        rules: [],
        idByName: new Map([[JA4_RULE, 'rule-1']]),
        activeByName: new Map([[JA4_RULE, true]]),
        actionByName: new Map([[JA4_RULE, 'deny']]),
        descriptionByName: new Map(),
        valuesByName: new Map(),
      }) as never,
    applyItem: async (item) => {
      applied.push({ values: valuesOf(item.rule, JA4_DENY) });
      return { status: 'overwrote' as const };
    },
  });
});

afterAll(() => {
  mock.module('./watch-notify', () => ({ ...realNotify }));
  const i = process.argv.indexOf('--mock');
  if (i !== -1) process.argv.splice(i, 1);
});

describe('editLiveJa4Deny', () => {
  test('it writes inside the sandbox, never the repo', () => {
    // The guard, not a formality: everything below writes .env.local for real.
    expect(envPath()).toBe(join(process.cwd(), '.env.local'));
    // realpath both: macOS hands out /var/... and resolves it to /private/var/...
    expect(
      realpathSync(dirname(envPath())).startsWith(realpathSync(tmpdir())),
    ).toBe(true);
  });

  test('an add reaches the WAF AND the env list the next apply rebuilds from', async () => {
    const r = await editLiveJa4Deny(NEW, 'add');
    expect(r.ok).toBe(true);
    // The WAF got it...
    expect(applied.at(-1)?.values).toContain(NEW);
    // ...and so did the file, or the next `a` quietly lifts it.
    expect(readFileSync(envPath(), 'utf8')).toContain(NEW);
  });

  test('a remove clears it from BOTH, or the expiry never happens', async () => {
    await editLiveJa4Deny(NEW, 'add');
    const r = await editLiveJa4Deny(NEW, 'remove');
    expect(r.ok).toBe(true);
    expect(applied.at(-1)?.values).not.toContain(NEW);
    const env = readFileSync(envPath(), 'utf8');
    expect(env).not.toContain(NEW);
    // The operator's own denies are untouched by our lift.
    expect(env).toContain(TEST_DENIED_JA4);
  });

  test('a malformed digest is refused on BOTH directions', async () => {
    // `withoutValue` only filters, so an unchecked removal reports a lift that never happened —
    // and the record is then dropped while the deny stays live.
    for (const d of ['not-a-digest', '', 't13d']) {
      expect((await editLiveJa4Deny(d, 'add')).ok).toBe(false);
      expect((await editLiveJa4Deny(d, 'remove')).ok).toBe(false);
    }
  });
});

describe('maybeAutoBan', () => {
  const finding = (digest: string) =>
    ({ digest, autoBanRefusal: null }) as never;
  const clocks = () => readFwVars(envPath())[AUTO_BAN_UNTIL] ?? '';

  const backend = (opts: { active: boolean }) => ({
    fetchLive: async () =>
      ({
        rules: [],
        idByName: new Map([[JA4_RULE, 'rule-1']]),
        activeByName: new Map([[JA4_RULE, opts.active]]),
        actionByName: new Map([[JA4_RULE, 'deny']]),
        descriptionByName: new Map(),
        valuesByName: new Map(),
      }) as never,
    applyItem: async () => ({ status: 'overwrote' as const }),
  });

  test('a failure AFTER the apply keeps the clock', async () => {
    // The rule is deactivated live, so the edit reports failure — but the digest IS written, and
    // is enforced the moment anyone activates the rule. Dropping its expiry here is how an
    // autonomous ban becomes permanent.
    const D = 't13dpart00_cccccccccccc_dddddddddddd';
    process.env.FW_AUTO_BAN = '1';
    installWafBackend(backend({ active: false }));
    await maybeAutoBan(process.cwd(), finding(D), 'ban');
    expect(clocks()).toContain(D);
  });

  test('a failure BEFORE the apply takes the clock back', async () => {
    // Nothing reached the WAF, so a clock left behind would schedule a lift for a ban that never
    // existed — and the record would read as an active autonomous ban to anyone auditing it.
    process.env.FW_AUTO_BAN = '1';
    installWafBackend(backend({ active: true }));
    await maybeAutoBan(process.cwd(), finding('not-a-digest'), 'ban');
    expect(clocks()).not.toContain('not-a-digest');
  });
});

describe('liftExpiredAutoBans', () => {
  test('a re-ban landing mid-sweep keeps its own clock', async () => {
    // The sweep awaits a WAF call per expired record. Another process can ban the same fingerprint
    // in that window, and retiring by digest alone deletes the NEW record along with the old one —
    // leaving that ban live with nothing scheduled to lift it.
    const D = 't13dresc00_eeeeeeeeeeee_ffffffffffff';
    const future = Date.now() + 3_600_000;
    persistEnvVar(
      envPath(),
      AUTO_BAN_UNTIL,
      serialiseExpiries([{ digest: D, until: Date.now() - 60_000 }]),
    );
    installWafBackend({
      fetchLive: async () =>
        ({
          rules: [],
          idByName: new Map([[JA4_RULE, 'rule-1']]),
          activeByName: new Map([[JA4_RULE, true]]),
          actionByName: new Map([[JA4_RULE, 'deny']]),
          descriptionByName: new Map(),
          valuesByName: new Map(),
        }) as never,
      applyItem: async () => {
        // The concurrent re-ban, written while the sweep is mid-flight.
        persistEnvVar(
          envPath(),
          AUTO_BAN_UNTIL,
          serialiseExpiries([{ digest: D, until: future }]),
        );
        return { status: 'overwrote' as const };
      },
    });
    await liftExpiredAutoBans(process.cwd());
    const left = parseExpiries(readFwVars(envPath())[AUTO_BAN_UNTIL]);
    expect(left.map((r) => r.until)).toContain(future);
    persistEnvVar(envPath(), AUTO_BAN_UNTIL, '');
  });
});
