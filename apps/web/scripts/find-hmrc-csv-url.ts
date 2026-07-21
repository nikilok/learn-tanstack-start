// AI_PROVIDER=anthropic (default) | gemma. The gemma provider runs Gemma 4 E2B
// fully locally via LiteRT-LM + WebGPU in headless Chromium (@ss/gemma core,
// hosted by lib/gemma-host-playwright.ts).
import Anthropic from '@anthropic-ai/sdk';
import type { GemmaClient } from '@ss/gemma';
import { chromium } from 'playwright';

import {
  type AgentAction,
  formatLinksForPrompt,
  parseAgentAction,
} from './lib/agent-action';
import { createPlaywrightGemmaClient } from './lib/gemma-host-playwright';

const PROVIDER = process.env.AI_PROVIDER ?? 'anthropic';
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
const MAX_STEPS = 5;

if (PROVIDER !== 'anthropic' && PROVIDER !== 'gemma') {
  console.error(
    `Unknown AI_PROVIDER "${PROVIDER}" — use "anthropic" or "gemma"`,
  );
  process.exit(1);
}

const MODEL_LABEL = PROVIDER === 'gemma' ? 'Gemma' : 'Claude';
const GEMMA_SYSTEM =
  'You are a precise web navigation agent. Respond with a single JSON object only — no prose, no code fences.';

let anthropic: Anthropic | null = null;
let gemma: GemmaClient | null = null;

async function extractLinks(page: import('playwright').Page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links
      .map((a) => ({
        text: (a.textContent ?? '').trim().slice(0, 200),
        href: a.getAttribute('href') ?? '',
      }))
      .filter((l) => l.text && l.href);
  });
}

/** Sends a prompt to the Anthropic API and returns the raw response text. */
async function askClaude(prompt: string): Promise<string> {
  anthropic ??= new Anthropic();
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const first = response.content[0];
  return first?.type === 'text' ? first.text : '';
}

/** Routes a prompt to the configured provider and parses its JSON decision. */
async function askModel(prompt: string): Promise<AgentAction> {
  if (PROVIDER === 'gemma') {
    gemma ??= await createPlaywrightGemmaClient();
    const { text, stats } = await gemma.ask(prompt, GEMMA_SYSTEM);
    console.log(`  [gemma] ${stats}`);
    return parseAgentAction(text, MODEL_LABEL);
  }
  return parseAgentAction(await askClaude(prompt), MODEL_LABEL);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Step 1: Search gov.uk directly for the sponsor register
    console.log(
      `Step 1: Searching gov.uk for HMRC sponsor register (provider: ${PROVIDER})...`,
    );
    await page.goto(
      'https://www.gov.uk/search/all?keywords=register+of+licensed+sponsors+workers&order=relevance',
      { waitUntil: 'domcontentloaded' },
    );

    const searchResults = await extractLinks(page);

    console.log(`Found ${searchResults.length} search results`);

    const searchPrompt = `You are helping find the UK gov.uk page that contains a downloadable CSV file of licensed sponsor employers (skilled workers).

Here are the gov.uk search results:
${formatLinksForPrompt(searchResults, PROVIDER)}

Which result is most likely the page listing licensed sponsors where you can download the worker CSV?

Respond with JSON only:
{ "action": "click", "url": "<the href to navigate to>", "reasoning": "<why you chose this>" }`;

    const searchDecision = await askModel(searchPrompt);
    console.log(`${MODEL_LABEL} chose: ${searchDecision.reasoning}`);

    if (!searchDecision.url) {
      throw new Error(`${MODEL_LABEL} did not return a URL to navigate to`);
    }

    // Step 2+: Navigate pages until we find the CSV link
    let nextUrl = new URL(searchDecision.url, 'https://www.gov.uk').href;

    for (let step = 0; step < MAX_STEPS; step++) {
      console.log(`Step ${step + 2}: Navigating to ${nextUrl}...`);
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded' });

      const links = await extractLinks(page);
      const pageTitle = await page.title();

      const navPrompt = `You are on the page: "${pageTitle}"
URL: ${page.url()}

You are looking for a direct download link to a CSV file containing the full list of licensed sponsor employers (skilled workers / temporary workers).

Here are the links on this page:
${formatLinksForPrompt(links, PROVIDER)}

If you can see a link to a CSV file for skilled/temporary workers, respond with:
{ "action": "done", "csvUrl": "<full URL of the CSV>", "reasoning": "<why this is the right file>" }

If you need to navigate to another page first, respond with:
{ "action": "click", "url": "<the href to follow>", "reasoning": "<why you need to go there>" }

Respond with JSON only.`;

      const decision = await askModel(navPrompt);
      console.log(`${MODEL_LABEL}: ${decision.reasoning}`);

      // Small models sometimes put the final URL in `url` despite the schema.
      const doneUrl = decision.csvUrl ?? decision.url;
      if (decision.action === 'done' && doneUrl) {
        const csvUrl = new URL(doneUrl, page.url()).href;
        console.log(`\nFound CSV URL: ${csvUrl}`);
        return csvUrl;
      }

      if (decision.action === 'click' && decision.url) {
        nextUrl = new URL(decision.url, page.url()).href;
        continue;
      }

      break;
    }

    throw new Error(
      'Could not find the CSV URL within the maximum number of steps',
    );
  } finally {
    await browser.close();
    await gemma?.stop();
  }
}

main()
  .then((url) => {
    // Print the raw URL as the last line for easy capture
    console.log(url);
  })
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
