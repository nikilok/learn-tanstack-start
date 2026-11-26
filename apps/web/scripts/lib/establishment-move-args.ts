/**
 * The establishment move script's command line, read strictly: an argument it
 * does not know, a flag missing its value, or a file given twice stops the
 * run rather than starting a different one from the one asked for.
 */

import { fileFlag } from './file-flag.ts';

/** Every argument the script reads. */
const KNOWN_ARG = /^--(?:apply|find|keep-methods|(?:list|backup)=.*)$/;

/** What a run of the script was asked for. */
export type EstablishmentMoveArgs = {
  /** The JSON list of moves: read, or written when finding. */
  list: string;
  /** Write the list from the database and Companies House, and nothing else. */
  find: boolean;
  /** Where the rows are backed up before any write; needed to apply. */
  backup?: string;
  /** Write; without it the run only plans. */
  apply: boolean;
  /** Every join keeps the method it had, instead of becoming `manual`. */
  keepMethods: boolean;
};

/** Read the script's arguments; throws on one it does not know, no list, a file flag given twice or empty, a find that would also write rows, or an apply with nowhere to back up to. */
export function parseEstablishmentMoveArgs(
  args: readonly string[],
): EstablishmentMoveArgs {
  const unknown = args.filter((arg) => !KNOWN_ARG.test(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown arguments: ${unknown.join(' ')}`);
  }
  const list = fileFlag(args, 'list');
  if (list === undefined) throw new Error('--list needs a file');
  const backup = fileFlag(args, 'backup');
  const apply = args.includes('--apply');
  const find = args.includes('--find');
  const keepMethods = args.includes('--keep-methods');
  if (find && (apply || backup !== undefined || keepMethods)) {
    throw new Error('--find writes the list and nothing else');
  }
  if (apply && backup === undefined) {
    throw new Error('--apply needs --backup, a file that does not exist yet');
  }
  return { list, find, backup, apply, keepMethods };
}
