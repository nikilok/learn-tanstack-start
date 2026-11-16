/**
 * The revalidation sweep's command line, read strictly: an argument it does
 * not know, or a flag missing its value, stops the run rather than starting a
 * different sweep from the one asked for.
 */

import type { SweepSelection } from '../../src/lib/websites/sql.ts';
import { parseStrictInt } from './script-utils.ts';

/** Every argument the sweep reads. */
const KNOWN_ARG =
  /^--(?:dry-run|verbose|no-render|(?:max-rows|status|address-delay)=.*)$/;

/** What a run of the sweep was asked for. */
export type SweepArgs = {
  dryRun: boolean;
  /** Per-row detail, for a human at a terminal. */
  verbose: boolean;
  /** Whether a homepage a plain fetch shows nothing of is read in a browser. */
  render: boolean;
  /** Rows this run takes; undefined leaves the script its default. */
  maxRows?: number;
  status?: SweepSelection['status'];
  /** Least milliseconds between two requests to one hosting address; undefined leaves the script its default. */
  addressDelayMs?: number;
};

/** The value of a `--name=value` argument, or undefined when it was not passed. */
function valueOf(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** Read the sweep's arguments; throws on one it does not know, a row count or delay that is not a whole number, or a status it cannot take. */
export function parseSweepArgs(args: readonly string[]): SweepArgs {
  const unknown = args.filter((arg) => !KNOWN_ARG.test(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown arguments: ${unknown.join(' ')}`);
  }
  const maxRows = valueOf(args, 'max-rows');
  const status = valueOf(args, 'status');
  const addressDelay = valueOf(args, 'address-delay');
  if (status !== undefined && status !== 'unreachable' && status !== 'dead') {
    throw new Error('--status must be unreachable or dead');
  }
  return {
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    render: !args.includes('--no-render'),
    maxRows:
      maxRows === undefined ? undefined : parseStrictInt(maxRows, '--max-rows'),
    status,
    addressDelayMs:
      addressDelay === undefined
        ? undefined
        : parseStrictInt(addressDelay, '--address-delay'),
  };
}
