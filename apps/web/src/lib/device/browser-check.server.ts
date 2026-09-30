import { checkBotId } from 'botid/server';

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

/**
 * Whether the current request may have the extras: it came from a browser a person is using,
 * by Vercel's check of the challenge its script attached to the request. Any client the check
 * names as automated is refused while `enforce` holds, verified crawlers included; otherwise it
 * is let through. Every verdict is logged either way.
 *
 * A check that fails — the service unreachable, the project not set up for it — lets the
 * request through, as an unreadable suspended list suspends nobody, and says so in the log. A
 * request that arrives without the challenge is not a failure: the check names it automated.
 * Never throws.
 */
export async function fromBrowser(
  check: BrowserCheck = checkBotId,
  verdict: LocalVerdict | undefined = localVerdict(),
  enforce: boolean = enforcing(),
): Promise<boolean> {
  let result: Awaited<ReturnType<BrowserCheck>>;
  try {
    result = await check(
      verdict ? { developmentOptions: { bypass: verdict } } : undefined,
    );
  } catch (error) {
    console.error(
      '[extras] browser check failed:',
      error instanceof Error ? error.message : error,
    );
    return true;
  }
  const said = !result.isBot
    ? 'person'
    : result.isVerifiedBot
      ? 'verified crawler'
      : 'automated';
  console.info(
    `[extras] browser check: ${said}${result.isBot && !enforce ? ' (not enforced)' : ''}`,
  );
  return !result.isBot || !enforce;
}
