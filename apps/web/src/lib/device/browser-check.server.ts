import { checkBotId } from 'botid/server';

import { BROWSER_CHECK_LEVEL } from './browser-check-config';

/** Asks whether the current request came from an automated client (Vercel BotID). */
export type BrowserCheck = typeof checkBotId;

/** The local-development verdicts BotID can be told to return. */
const LOCAL_VERDICTS = ['HUMAN', 'BAD-BOT', 'GOOD-BOT'] as const;
type LocalVerdict = (typeof LOCAL_VERDICTS)[number];

/**
 * The verdict a local run asks for, from `BROWSER_CHECK_LOCAL_VERDICT`, so both outcomes can be
 * tried without deploying. BotID applies it only in development and ignores it in production;
 * anything unrecognised is no request, and BotID's local default is a human.
 */
export function localVerdict(
  value = process.env.BROWSER_CHECK_LOCAL_VERDICT,
): LocalVerdict | undefined {
  return LOCAL_VERDICTS.find((v) => v === value);
}

/**
 * Whether an automated verdict is refused, or only logged: `BROWSER_CHECK_ENFORCE=1` refuses.
 * Unset, the check runs on every call and says what it found, and nobody is refused — so its
 * verdicts can be read in production before they take the extras from anyone.
 */
export function enforcing(value = process.env.BROWSER_CHECK_ENFORCE): boolean {
  return value === '1';
}

/** What the check said about a request. */
export type BrowserVerdict = 'person' | 'verified crawler' | 'automated';

/**
 * The check's verdict on the current request, asked at the level the client's protected calls
 * name (BotID fails a check whose two sides disagree, and names every visitor automated), or
 * `unchecked` when the check itself failed — the service unreachable, the project not set up for
 * it — which is logged under `tag`. A request that arrives without the challenge is not a
 * failure: the check names it automated. Never throws.
 */
export async function browserVerdict(
  tag: string,
  check: BrowserCheck = checkBotId,
  verdict: LocalVerdict | undefined = localVerdict(),
): Promise<BrowserVerdict | 'unchecked'> {
  let result: Awaited<ReturnType<BrowserCheck>>;
  try {
    result = await check({
      advancedOptions: { checkLevel: BROWSER_CHECK_LEVEL },
      ...(verdict ? { developmentOptions: { bypass: verdict } } : {}),
    });
  } catch (error) {
    console.error(
      `[${tag}] browser check failed:`,
      error instanceof Error ? error.message : error,
    );
    return 'unchecked';
  }
  return !result.isBot
    ? 'person'
    : result.isVerifiedBot
      ? 'verified crawler'
      : 'automated';
}

/**
 * Whether the current request may have what it asks for (the extras, or a company page's data
 * under `tag`): it came from a browser a person is using, by Vercel's check of the challenge its
 * script attached to the request. Any client the check names as automated is refused while
 * `enforce` holds, verified crawlers included; otherwise it is let through. Every verdict is
 * logged either way, under `tag`.
 *
 * A check that fails lets the request through, as an unreadable suspended list suspends nobody,
 * and says so in the log. Never throws.
 */
export async function fromBrowser(
  check: BrowserCheck = checkBotId,
  verdict: LocalVerdict | undefined = localVerdict(),
  enforce: boolean = enforcing(),
  tag = 'extras',
): Promise<boolean> {
  const said = await browserVerdict(tag, check, verdict);
  if (said === 'unchecked') return true;
  const isBot = said !== 'person';
  console.info(
    `[${tag}] browser check: ${said}${isBot && !enforce ? ' (not enforced)' : ''}`,
  );
  return !isBot || !enforce;
}

/** `fromBrowser` for a company page's data call, logged under `page`. */
export function pageFromBrowser(): Promise<boolean> {
  return fromBrowser(checkBotId, localVerdict(), enforcing(), 'page');
}
