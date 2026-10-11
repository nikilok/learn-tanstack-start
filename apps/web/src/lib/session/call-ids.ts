import { createHash } from 'node:crypto';

import { SESSION_CALL_PREFIX, SESSION_CALLS } from './calls';

const KEYS: ReadonlySet<string> = new Set(SESSION_CALLS);

// The compiler names a server function's handler after its variable, numbering a clash.
const HANDLER_SUFFIX_RE = /_createServerFn_handler(_\d+)?$/;

/**
 * The id a production build gives a server function (`serverFns.generateFunctionId`): a session
 * call's is `SESSION_CALL_PREFIX` and a hash of where it is defined, and every other function
 * keeps the framework's default (undefined here).
 */
export function sessionCallId(opts: {
  filename: string;
  functionName: string;
}): string | undefined {
  const filename = opts.filename.replaceAll('\\', '/');
  const variable = opts.functionName.replace(HANDLER_SUFFIX_RE, '');
  if (!KEYS.has(`${filename}#${variable}`)) return undefined;
  const hash = createHash('sha256')
    .update(`${filename}--${opts.functionName}`)
    .digest('hex');
  return `${SESSION_CALL_PREFIX}${hash}`;
}
