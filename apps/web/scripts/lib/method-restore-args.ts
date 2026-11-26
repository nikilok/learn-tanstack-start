/**
 * The method restore script's command line, read strictly: an argument it
 * does not know, or a backup given twice or with no file, stops the run.
 */

import { fileFlag } from './file-flag.ts';

/** Every argument the script reads. */
const KNOWN_ARG = /^--(?:apply|backup=.*)$/;

/** What a run of the script was asked for. */
export type MethodRestoreArgs = {
  /** Where the joins are backed up before any write; needed to apply. */
  backup?: string;
  /** Write; without it the run only plans. */
  apply: boolean;
};

/** Read the script's arguments; throws on one it does not know, a backup given twice or empty, or an apply with nowhere to back up to. */
export function parseMethodRestoreArgs(
  args: readonly string[],
): MethodRestoreArgs {
  const unknown = args.filter((arg) => !KNOWN_ARG.test(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown arguments: ${unknown.join(' ')}`);
  }
  const backup = fileFlag(args, 'backup');
  const apply = args.includes('--apply');
  if (apply && backup === undefined) {
    throw new Error('--apply needs --backup, a file that does not exist yet');
  }
  return { backup, apply };
}
