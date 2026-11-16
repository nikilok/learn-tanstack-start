import { describe, expect, test } from 'bun:test';

import { parseSweepArgs } from './sweep-args.ts';

describe('parseSweepArgs', () => {
  test('no arguments is the nightly run: every status, the default slice, rendering on', () => {
    expect(parseSweepArgs([])).toEqual({
      dryRun: false,
      verbose: false,
      render: true,
      maxRows: undefined,
      status: undefined,
    });
  });

  test('reads what the workflow and an operator pass', () => {
    expect(parseSweepArgs(['--dry-run', '--max-rows=200'])).toMatchObject({
      dryRun: true,
      maxRows: 200,
    });
    expect(
      parseSweepArgs(['--status=unreachable', '--verbose', '--no-render']),
    ).toMatchObject({ status: 'unreachable', verbose: true, render: false });
    expect(parseSweepArgs(['--status=dead']).status).toBe('dead');
  });

  test('a status flag without its value stops the run: it would sweep every status', () => {
    // `--status unreachable`, as a shell passes it: two arguments, neither one read.
    expect(() => parseSweepArgs(['--status', 'unreachable'])).toThrow(
      'Unknown arguments: --status unreachable',
    );
    expect(() => parseSweepArgs(['--status'])).toThrow('Unknown arguments');
    expect(() => parseSweepArgs(['--status='])).toThrow(
      '--status must be unreachable or dead',
    );
  });

  test('a status the sweep cannot take stops the run', () => {
    for (const status of ['verified', 'none', 'UNREACHABLE', 'dead ']) {
      expect(() => parseSweepArgs([`--status=${status}`])).toThrow(
        '--status must be unreachable or dead',
      );
    }
  });

  test('so does any argument it does not know, a mistyped one included', () => {
    for (const args of [
      ['--staus=dead'],
      ['--max-rows', '200'],
      ['--dryrun'],
      ['dead'],
      ['--status=dead', '--evidence=registry'],
    ]) {
      expect(() => parseSweepArgs(args)).toThrow('Unknown arguments');
    }
  });

  test('a row count that is not a whole number stops the run, an empty one included', () => {
    for (const rows of ['', 'ten', '1e3', '10.5', '-5']) {
      expect(() => parseSweepArgs([`--max-rows=${rows}`])).toThrow(
        'Invalid --max-rows',
      );
    }
    expect(parseSweepArgs(['--max-rows=0']).maxRows).toBe(0);
  });
});
