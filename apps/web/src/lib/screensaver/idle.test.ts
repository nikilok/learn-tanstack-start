import { describe, expect, test } from 'bun:test';

import {
  ACTIVITY_EVENTS,
  DESKTOP_IDLE_TIMEOUT_MS,
  EXTERNAL_ACTIVITY_EVENT,
  IDLE_TIMEOUT_MS,
  idleTimeoutFor,
  isDeliberateInput,
  isWakeMove,
  remainingIdleMs,
  SWALLOW_ON_WAKE,
  WAKE_MOVE_PX,
} from './idle.ts';

describe('idleTimeoutFor', () => {
  test('gives a browser tab three minutes and the desktop shell one', () => {
    expect(IDLE_TIMEOUT_MS).toBe(3 * 60_000);
    expect(DESKTOP_IDLE_TIMEOUT_MS).toBe(60_000);
    expect(idleTimeoutFor(false)).toBe(IDLE_TIMEOUT_MS);
    expect(idleTimeoutFor(true)).toBe(DESKTOP_IDLE_TIMEOUT_MS);
  });

  test('never lets a tab settle sooner than the shell', () => {
    // Reading a page produces no input, so the web threshold must stay the longer one.
    expect(idleTimeoutFor(false)).toBeGreaterThan(idleTimeoutFor(true));
  });
});

describe('remainingIdleMs', () => {
  // Fractions of the timeout, not absolute times — retuning the constant above must
  // not silently invert an assertion here.
  const HALF = IDLE_TIMEOUT_MS / 2;

  test('counts down from the full timeout', () => {
    expect(remainingIdleMs(1000, 1000)).toBe(IDLE_TIMEOUT_MS);
    expect(remainingIdleMs(1000, 1000 + HALF)).toBe(IDLE_TIMEOUT_MS - HALF);
  });

  test('is 0 at the threshold and never negative past it', () => {
    expect(remainingIdleMs(0, IDLE_TIMEOUT_MS)).toBe(0);
    expect(remainingIdleMs(0, IDLE_TIMEOUT_MS * 10)).toBe(0);
  });

  test('activity since the timer was armed leaves a remainder to re-arm with', () => {
    // Armed at t=0 for the full timeout; the user moved halfway through it.
    const remaining = remainingIdleMs(HALF, IDLE_TIMEOUT_MS);
    expect(remaining).toBe(HALF);
    // Re-armed for that remainder, the next check finds it genuinely idle.
    expect(remainingIdleMs(HALF, IDLE_TIMEOUT_MS + remaining)).toBe(0);
  });
});

describe('isWakeMove', () => {
  const origin = { x: 400, y: 300 };

  test('drift below the threshold does not wake it', () => {
    expect(isWakeMove(origin, { x: 400, y: 300 })).toBe(false);
    expect(isWakeMove(origin, { x: 403, y: 302 })).toBe(false);
  });

  test('a real move does, on either axis or diagonally', () => {
    expect(isWakeMove(origin, { x: 400 + WAKE_MOVE_PX, y: 300 })).toBe(true);
    expect(isWakeMove(origin, { x: 400, y: 300 - WAKE_MOVE_PX })).toBe(true);
    expect(isWakeMove(origin, { x: 405, y: 305 })).toBe(true);
  });
});

describe('ACTIVITY_EVENTS', () => {
  test('carries the shell bridge channel', () => {
    expect(ACTIVITY_EVENTS).toContain(EXTERNAL_ACTIVITY_EVENT);
  });

  test('excludes scroll — programmatic restores would reset the timer on their own', () => {
    expect(ACTIVITY_EVENTS).not.toContain('scroll' as never);
  });

  test('counts returning to a hidden tab as presence', () => {
    // Timers still fire in a background tab, but rAF and transitions do not — without
    // this the user comes back to watch the page dissolve away in front of them.
    expect(ACTIVITY_EVENTS).toContain('visibilitychange' as never);
  });
});

describe('SWALLOW_ON_WAKE', () => {
  test('claims the gestures that would otherwise reach the app underneath', () => {
    // The waking keystroke must not also type into the search box or activate a result.
    expect(SWALLOW_ON_WAKE.has('keydown')).toBe(true);
    expect(SWALLOW_ON_WAKE.has('pointerdown')).toBe(true);
    expect(SWALLOW_ON_WAKE.has('wheel')).toBe(true);
  });

  test('leaves visibilitychange alone — it is not the user aiming at anything', () => {
    expect(SWALLOW_ON_WAKE.has('visibilitychange')).toBe(false);
  });
});

describe('isDeliberateInput', () => {
  test('treats unmarked input as deliberate', () => {
    expect(isDeliberateInput(undefined)).toBe(true);
    expect(isDeliberateInput(null)).toBe(true);
    expect(isDeliberateInput({})).toBe(true);
    expect(isDeliberateInput({ deliberate: true })).toBe(true);
  });

  test('only an explicit false is movement — so chrome drift cannot wake it', () => {
    expect(isDeliberateInput({ deliberate: false })).toBe(false);
  });
});
