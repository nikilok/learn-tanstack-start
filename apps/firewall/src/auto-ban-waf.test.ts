// The armed path's effects. Applying to the WAF alone is not a ban that survives: the operator's
// own apply rebuilds the deny rule from .env.local, so a digest missing there is lifted the next
// time anyone presses `a`. These cover the half that makes it stick.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
const { installWafBackend, liveWaf } = await import('./client');
const priorAutoBan = process.env.FW_AUTO_BAN;
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
  // The backend BEFORE the argv line, and both before anything else runs. `installWafBackend`
  // refuses outside a mock session, so restoring it after `--mock` is gone would silently fail and
  // leave this file's stub installed for the rest of the process — with `envPath()` back to the
  // REPO's .env.local, which is the operator's real denylist.
  installWafBackend(liveWaf);
  const i = process.argv.indexOf('--mock');
  if (i !== -1) process.argv.splice(i, 1);
  // Restored, not just unset: it is read from the ambient environment, and leaving it armed would
  // hand the next file in this process a gate these tests opened.
  if (priorAutoBan === undefined) delete process.env.FW_AUTO_BAN;
  else process.env.FW_AUTO_BAN = priorAutoBan;
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

describe('successive edits in one process', () => {
  const live = (active = true) =>
    ({
      rules: [],
      idByName: new Map([[JA4_RULE, 'rule-1']]),
      activeByName: new Map([[JA4_RULE, active]]),
      actionByName: new Map([[JA4_RULE, 'deny']]),
      descriptionByName: new Map(),
      valuesByName: new Map(),
    }) as never;
  const listed = () =>
    (readFwVars(envPath()).FW_BLOCKED_JA4 ?? '').split(',').filter(Boolean);

  test('a second ban does not erase the first', async () => {
    // `rules.ts` reads the env once, at import, so the seeded rule is frozen at module load. An
    // edit built from THAT list silently reverts every edit made since the process started —
    // including denies the operator staged and applied by hand in the same session.
    const A = 't13daaaa11_aaaaaaaaaaaa_111111111111';
    const B = 't13dbbbb22_bbbbbbbbbbbb_222222222222';
    const seen: string[][] = [];
    persistEnvVar(envPath(), 'FW_BLOCKED_JA4', TEST_DENIED_JA4);
    installWafBackend({
      fetchLive: async () => live(),
      applyItem: async (item) => {
        seen.push(valuesOf(item.rule, JA4_DENY));
        return { status: 'overwrote' as const };
      },
    });
    await editLiveJa4Deny(A, 'add');
    await editLiveJa4Deny(B, 'add');
    expect(seen[1]).toContain(A);
    expect(seen[1]).toContain(B);
    expect(listed()).toEqual([TEST_DENIED_JA4, A, B]);
  });

  test('a sweep of several expired bans does not resurrect one', async () => {
    // The sweep calls the edit once per expired record. Off a frozen list, the second call
    // re-adds what the first removed — and both expiry records are retired regardless, leaving a
    // live deny with no clock, which is the one outcome this module exists to prevent.
    const A = 't13daaaa33_aaaaaaaaaaaa_333333333333';
    const B = 't13dbbbb44_bbbbbbbbbbbb_444444444444';
    persistEnvVar(
      envPath(),
      'FW_BLOCKED_JA4',
      [TEST_DENIED_JA4, A, B].join(','),
    );
    persistEnvVar(
      envPath(),
      AUTO_BAN_UNTIL,
      serialiseExpiries([
        { digest: A, until: Date.now() - 60_000 },
        { digest: B, until: Date.now() - 60_000 },
      ]),
    );
    installWafBackend({
      fetchLive: async () => live(),
      applyItem: async () => ({ status: 'overwrote' as const }),
    });
    await liftExpiredAutoBans(process.cwd());
    expect(listed()).toEqual([TEST_DENIED_JA4]);
    expect(parseExpiries(readFwVars(envPath())[AUTO_BAN_UNTIL])).toEqual([]);
  });
});

describe('when the env FILE has no deny list', () => {
  test('an absent key is not an empty list', async () => {
    // The list can live in the process env without being in the file — exported in a shell, or an
    // --env-file pointing somewhere else. Reading that as "nothing is denied" writes the rule down
    // to the one digest being banned and silently lifts every existing deny.
    const D = 't13dfall00_999999999999_888888888888';
    writeFileSync(envPath(), '');
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
      applyItem: async () => ({ status: 'overwrote' as const }),
    });
    const r = await editLiveJa4Deny(D, 'add');
    expect(r.ok).toBe(true);
    expect(readFwVars(envPath()).FW_BLOCKED_JA4).toContain(TEST_DENIED_JA4);
  });
});
