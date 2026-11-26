import { describe, expect, test } from 'bun:test';

import { parseEstablishmentMoveArgs } from './establishment-move-args.ts';

describe('parseEstablishmentMoveArgs', () => {
  test('a list alone is a dry run', () => {
    expect(parseEstablishmentMoveArgs(['--list=moves.json'])).toEqual({
      list: 'moves.json',
      find: false,
      backup: undefined,
      apply: false,
    });
  });

  test('finding writes the list', () => {
    expect(parseEstablishmentMoveArgs(['--find', '--list=moves.json'])).toEqual(
      {
        list: 'moves.json',
        find: true,
        backup: undefined,
        apply: false,
      },
    );
  });

  test('applying takes the list and a backup file', () => {
    expect(
      parseEstablishmentMoveArgs([
        '--list=moves.json',
        '--backup=out/backup=1.json',
        '--apply',
      ]),
    ).toEqual({
      list: 'moves.json',
      find: false,
      backup: 'out/backup=1.json',
      apply: true,
    });
  });

  test.each([
    [['--list=moves.json', '--aply'], 'Unknown arguments: --aply'],
    [['--list=moves.json', 'moves.json'], 'Unknown arguments: moves.json'],
    [['--list'], 'Unknown arguments: --list'],
    [[], '--list needs a file'],
    [['--list='], '--list needs a file'],
    [['--find'], '--list needs a file'],
    [['--list=moves.json', '--apply'], '--apply needs --backup'],
    // A flag with no value is malformed in every mode, not read as left out.
    [['--list=moves.json', '--backup=', '--apply'], '--backup needs a file'],
    [['--list=moves.json', '--backup='], '--backup needs a file'],
    [['--find', '--list=moves.json', '--backup='], '--backup needs a file'],
    // The first of two files must never be taken silently for the reviewed one.
    [
      ['--list=old.json', '--list=reviewed.json', '--backup=b.json', '--apply'],
      '--list is given more than once',
    ],
    [
      ['--list=moves.json', '--backup=a.json', '--backup=b.json', '--apply'],
      '--backup is given more than once',
    ],
    [
      ['--find', '--list=a.json', '--list=a.json'],
      '--list is given more than once',
    ],
    [
      ['--find', '--list=moves.json', '--apply', '--backup=b.json'],
      '--find writes the list and nothing else',
    ],
    [
      ['--find', '--list=moves.json', '--backup=b.json'],
      '--find writes the list and nothing else',
    ],
  ])('refuses %j', (args, why) => {
    expect(() => parseEstablishmentMoveArgs(args)).toThrow(why);
  });
});
