// The shared environment reads. Two properties matter more than the parsing: this module imports
// nothing, and nothing in it throws — that is what lets setup.tsx reach `isDryRun` before the
// error handling exists, and what stopped the read-at-import poisoning the rest of the process.

import { afterEach, describe, expect, test } from 'bun:test';

import { envCeiling, envText, isApply, isDryRun, useColour } from './env';

const KEY = 'FW_ENV_TEST_VALUE';
const saved = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env))
    if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('envText', () => {
  test('returns a set value, trimmed', () => {
    process.env[KEY] = '  hello  ';
    expect(envText(KEY)).toBe('hello');
  });

  test('an absent value is undefined', () => {
    delete process.env[KEY];
    expect(envText(KEY)).toBeUndefined();
  });

  // Callers treat undefined as "not configured", so a whitespace-only value must not read as one.
  test('a blank or whitespace-only value is undefined, not an empty string', () => {
    process.env[KEY] = '';
    expect(envText(KEY)).toBeUndefined();
    process.env[KEY] = '   ';
    expect(envText(KEY)).toBeUndefined();
  });
});

describe('envCeiling', () => {
  test('reads a positive integer', () => {
    process.env[KEY] = '120';
    expect(envCeiling(KEY)).toBe(120);
  });

  // A ceiling that is absent, zero, negative or fractional is not a ceiling. Returning it would
  // build a rule around a number nobody chose.
  test('anything that is not a positive integer is undefined', () => {
    for (const v of ['0', '-5', '1.5', 'abc', '']) {
      process.env[KEY] = v;
      expect(envCeiling(KEY)).toBeUndefined();
    }
    delete process.env[KEY];
    expect(envCeiling(KEY)).toBeUndefined();
  });
});

describe('isDryRun', () => {
  test('DRY_RUN=1 is a dry run', () => {
    process.env.DRY_RUN = '1';
    expect(isDryRun()).toBe(true);
  });

  test('any other value is not', () => {
    process.env.DRY_RUN = '0';
    expect(isDryRun()).toBe(false);
    process.env.DRY_RUN = 'true';
    expect(isDryRun()).toBe(false);
  });

  // Lazy, not a module-scope const. This is what lets a test set the value and what stopped a
  // read-at-import from fixing the answer for the whole process.
  test('it is re-read on every call', () => {
    process.env.DRY_RUN = '1';
    expect(isDryRun()).toBe(true);
    process.env.DRY_RUN = '0';
    expect(isDryRun()).toBe(false);
  });
});

describe('isApply', () => {
  test('--apply is read from argv', () => {
    const argv = process.argv;
    try {
      process.argv = [...argv, '--apply'];
      expect(isApply()).toBe(true);
    } finally {
      process.argv = argv;
    }
  });

  // argv is set explicitly rather than trusted: read as the runner happens to have invoked us,
  // this passes whether or not isApply looks at argv at all.
  test('without the flag it is not an apply', () => {
    const argv = process.argv;
    try {
      process.argv = ['bun', 'firewall', '--dry-run'];
      expect(isApply()).toBe(false);
    } finally {
      process.argv = argv;
    }
  });
});

describe('useColour', () => {
  // isTTY is false under the test runner, so without forcing it this asserts nothing: the
  // function would return false even if NO_COLOR were ignored entirely.
  const withTty = (fn: () => void, isTTY = true) => {
    const real = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: isTTY,
      configurable: true,
    });
    try {
      fn();
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: real,
        configurable: true,
      });
    }
  };

  test('a TTY with no NO_COLOR gets colour', () => {
    withTty(() => {
      delete process.env.NO_COLOR;
      expect(useColour()).toBe(true);
    });
  });

  test('NO_COLOR turns it off even on a TTY', () => {
    withTty(() => {
      process.env.NO_COLOR = '1';
      expect(useColour()).toBe(false);
    });
  });

  test('a pipe gets no colour whatever NO_COLOR says', () => {
    // BOTH ways round, or the title claims more than the test checks: with NO_COLOR unset this
    // passes on the pipe alone and would still pass if the two conditions were swapped.
    // Forced rather than relying on the runner's ambient isTTY, or this asserts nothing either.
    withTty(() => {
      delete process.env.NO_COLOR;
      expect(useColour()).toBe(false);
      process.env.NO_COLOR = '1';
      expect(useColour()).toBe(false);
    }, false);
  });
});
