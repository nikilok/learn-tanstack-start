import { describe, expect, test } from 'bun:test';

import { createReadiness, WAITING } from './readiness';

const KEY = '93f2ab04c1d88e5f67a90b12c3d4e5f6';

describe('createReadiness', () => {
  test('starts waiting', () => {
    expect(createReadiness().snapshot()).toBe(WAITING);
  });

  test('ready once the key has arrived and the visitor has engaged, in either order', () => {
    const keyFirst = createReadiness();
    keyFirst.key(KEY);
    expect(keyFirst.snapshot().status).toBe('waiting');
    keyFirst.engage();
    expect(keyFirst.snapshot()).toEqual({ status: 'ready', key: KEY });

    const engagedFirst = createReadiness();
    engagedFirst.engage();
    expect(engagedFirst.snapshot().status).toBe('waiting');
    engagedFirst.key(KEY);
    expect(engagedFirst.snapshot()).toEqual({ status: 'ready', key: KEY });
  });

  test('a key alone never readies', () => {
    const readiness = createReadiness();
    readiness.key(KEY);
    expect(readiness.snapshot().status).toBe('waiting');
  });

  test('a malformed key never readies, and the first good key wins', () => {
    const readiness = createReadiness();
    readiness.engage();
    readiness.key('not-a-key');
    expect(readiness.snapshot().status).toBe('waiting');
    readiness.key(KEY);
    readiness.key('f'.repeat(32));
    expect(readiness.snapshot()).toEqual({ status: 'ready', key: KEY });
  });

  test('off is final, and so is ready', () => {
    const off = createReadiness();
    off.off();
    off.key(KEY);
    off.engage();
    expect(off.snapshot().status).toBe('off');

    const ready = createReadiness();
    ready.key(KEY);
    ready.engage();
    ready.off();
    expect(ready.snapshot().status).toBe('ready');
  });

  test('snapshots are stable between changes and each change notifies once', () => {
    const readiness = createReadiness();
    let notified = 0;
    readiness.subscribe(() => notified++);
    const first = readiness.snapshot();
    readiness.key(KEY);
    expect(readiness.snapshot()).toBe(first);
    readiness.engage();
    readiness.engage();
    const ready = readiness.snapshot();
    expect(ready).not.toBe(first);
    expect(readiness.snapshot()).toBe(ready);
    expect(notified).toBe(1);
  });

  test('an unsubscribed listener hears nothing more', () => {
    const readiness = createReadiness();
    let notified = 0;
    const unsubscribe = readiness.subscribe(() => notified++);
    unsubscribe();
    readiness.off();
    expect(notified).toBe(0);
  });
});
