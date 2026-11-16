/**
 * The cutoff a re-read takes rows before: a date, or a date and time, read as
 * UTC. No I/O.
 */

const CUTOFF = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** The cutoff as the database compares it, `YYYY-MM-DD HH:MM:SS`; throws on anything but a real date or time that has passed. */
export function rereadCutoff(raw: string, now: Date): string {
  const parts = CUTOFF.exec(raw);
  if (!parts) {
    throw new Error(
      `Invalid --reread-before="${raw}": use YYYY-MM-DD or YYYY-MM-DDTHH:MM`,
    );
  }
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = parts;
  const text = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  const at = new Date(`${text.replace(' ', 'T')}Z`);
  // A date that rolls over, such as 31 February, is not the date asked for.
  if (
    Number.isNaN(at.getTime()) ||
    at.toISOString().slice(0, 19) !== text.replace(' ', 'T')
  ) {
    throw new Error(`Invalid --reread-before="${raw}": no such date or time`);
  }
  if (at.getTime() > now.getTime()) {
    throw new Error(`Invalid --reread-before="${raw}": it has not passed yet`);
  }
  return text;
}
