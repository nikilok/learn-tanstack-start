import { describe, expect, test } from 'bun:test';

import { parseRepointArgs } from './repoint-args.ts';

describe('parseRepointArgs', () => {
  test('a list alone is a dry run', () => {
    expect(parseRepointArgs(['--list=repoints.json'])).toEqual({
      list: 'repoints.json',
      backup: undefined,
      apply: false,
    });
  });

  test('applying takes the list and a backup file', () => {
    expect(
      parseRepointArgs([
        '--list=repoints.json',
        '--backup=out/backup=1.json',
        '--apply',
      ]),
    ).toEqual({
      list: 'repoints.json',
      backup: 'out/backup=1.json',
      apply: true,
    });
  });

  test('an argument it does not know stops the run: a mistyped flag must not turn an apply into a dry run, or the reverse', () => {
    for (const args of [
      ['--list=repoints.json', '--aply'],
      ['--list=repoints.json', '--dry-run'],
      // As a shell passes `--list repoints.json`: two arguments, neither one read.
      ['--list', 'repoints.json'],
      ['--list=repoints.json', '--apply=true'],
      ['--list=repoints.json', 'extra.json'],
    ]) {
      expect(() => parseRepointArgs(args)).toThrow('Unknown arguments');
    }
  });

  test('a flag with no value stops the run', () => {
    expect(() => parseRepointArgs([])).toThrow('--list needs a file');
    expect(() => parseRepointArgs(['--list='])).toThrow('--list needs a file');
    expect(() =>
      parseRepointArgs(['--list=repoints.json', '--backup=', '--apply']),
    ).toThrow('--apply needs --backup, a file that does not exist yet');
  });

  test('applying without a backup stops the run', () => {
    expect(() => parseRepointArgs(['--list=repoints.json', '--apply'])).toThrow(
      '--apply needs --backup, a file that does not exist yet',
    );
  });
});
