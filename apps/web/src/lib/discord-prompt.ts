// How often the footer's Discord bubble may prompt on its own. Kept apart from the DOM
// wiring in components/DiscordLink.tsx so the counting is testable without a browser.

/** localStorage key holding how far the reader has got through the prompt. */
export const DISCORD_PROMPT_KEY = 'discord-bubble';

/** Unprompted plays a reader gets before the bubble goes quiet for good. */
export const MAX_DISCORD_PROMPTS = 3;

/** Stored in place of a count once the reader has clicked through, so raising the cap later can't revive a prompt they already answered. */
export const DISCORD_PROMPT_DISMISSED = 'done';

/** Completed prompts the stored value stands for; Infinity once the reader has clicked through. */
export function promptsShown(raw: string | null): number {
  if (raw === DISCORD_PROMPT_DISMISSED) return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Whether the bubble may still prompt on its own. */
export function canPrompt(raw: string | null): boolean {
  return promptsShown(raw) < MAX_DISCORD_PROMPTS;
}

/** The value to store once a prompt has played all the way through — a run the reader scrolled away from is never one of the three. */
export function afterPrompt(raw: string | null): string {
  if (raw === DISCORD_PROMPT_DISMISSED) return DISCORD_PROMPT_DISMISSED;
  return String(Math.min(promptsShown(raw) + 1, MAX_DISCORD_PROMPTS));
}
