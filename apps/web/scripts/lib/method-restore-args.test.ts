import { describe, expect, test } from 'bun:test';

import { parseMethodRestoreArgs } from './method-restore-args.ts';

describe('parseMethodRestoreArgs', () => {
  test('no argument is a plan', () => {
    expect(parseMethodRestoreArgs([])).toEqual({
      backup: undefined,
      apply: false,
    });
  });

  test('applying takes a backup file', () => {
    expect(
      parseMethodRestoreArgs(['--backup=out/backup=1.json', '--apply']),
    ).toEqual({ backup: 'out/backup=1.json', apply: true });
  });

  test.each([
    [['--aply'], 'Unknown arguments: --aply'],
    [['backup.json'], 'Unknown arguments: backup.json'],
    [['--list=moves.json'], 'Unknown arguments: --list=moves.json'],
    [['--apply'], '--apply needs --backup'],
    [['--backup=', '--apply'], '--backup needs a file'],
    [['--backup='], '--backup needs a file'],
    [
      ['--backup=a.json', '--backup=b.json', '--apply'],
      '--backup is given more than once',
    ],
  ])('refuses %j', (args, why) => {
    expect(() => parseMethodRestoreArgs(args)).toThrow(why);
  });
});
