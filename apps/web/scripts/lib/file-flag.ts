/**
 * A `--name=file` argument, read strictly: given twice or with no value, it
 * stops the run rather than starting one on another file.
 */

/** The value of a `--name=value` argument, or undefined when it was not passed; throws when it is passed twice, or with no value. */
export function fileFlag(
  args: readonly string[],
  name: string,
): string | undefined {
  const prefix = `--${name}=`;
  const given = args.filter((arg) => arg.startsWith(prefix));
  if (given.length > 1) throw new Error(`--${name} is given more than once`);
  if (given.length === 0) return undefined;
  const value = given[0].slice(prefix.length);
  if (value === '') throw new Error(`--${name} needs a file`);
  return value;
}
