/**
 * The establishment move script's command line, read strictly: an argument it
 * does not know, or a flag missing its value, stops the run rather than
 * starting a different one from the one asked for.
 */

/** Every argument the script reads. */
const KNOWN_ARG = /^--(?:apply|find|(?:list|backup)=.*)$/;

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
};

/** The value of a `--name=value` argument, or undefined when it was not passed or is empty. */
function valueOf(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = args
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  return value === '' ? undefined : value;
}

/** Read the script's arguments; throws on one it does not know, no list, a find that would also write rows, or an apply with nowhere to back up to. */
export function parseEstablishmentMoveArgs(
  args: readonly string[],
): EstablishmentMoveArgs {
  const unknown = args.filter((arg) => !KNOWN_ARG.test(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown arguments: ${unknown.join(' ')}`);
  }
  const list = valueOf(args, 'list');
  if (list === undefined) throw new Error('--list needs a file');
  const backup = valueOf(args, 'backup');
  const apply = args.includes('--apply');
  const find = args.includes('--find');
  if (find && (apply || backup !== undefined)) {
    throw new Error('--find writes the list and nothing else');
  }
  if (apply && backup === undefined) {
    throw new Error('--apply needs --backup, a file that does not exist yet');
  }
  return { list, find, backup, apply };
}
