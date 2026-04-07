import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
const MAX_STEPS = 5;

const anthropic = new Anthropic();

interface AgentAction {
  action: 'click' | 'done';
  url?: string;
  csvUrl?: string;
  reasoning: string;
}

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

async function askClaude(prompt: string): Promise<AgentAction> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude did not return valid JSON: ${text}`);
  }
  return JSON.parse(jsonMatch[0]);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Step 1: Search gov.uk directly for the sponsor register
  console.log('Step 1: Searching gov.uk for HMRC sponsor register...');
  await page.goto(
    'https://www.gov.uk/search/all?keywords=register+of+licensed+sponsors+workers&order=relevance',
  );
  await page.waitForSelector('.gem-c-document-list__item a');

  const searchResults = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.gem-c-document-list__item a'))
      .slice(0, 10)
      .map((a) => ({
        text: (a.textContent ?? '').trim(),
        href: a.getAttribute('href') ?? '',
      }));
  });

  console.log(`Found ${searchResults.length} search results`);

  const searchPrompt = `You are helping find the UK gov.uk page that contains a downloadable CSV file of licensed sponsor employers (skilled workers).

Here are the gov.uk search results:
${JSON.stringify(searchResults, null, 2)}

Which result is most likely the page listing licensed sponsors where you can download the worker CSV?

Respond with JSON only:
{ "action": "click", "url": "<the href to navigate to>", "reasoning": "<why you chose this>" }`;

  const searchDecision = await askClaude(searchPrompt);
  console.log(`Claude chose: ${searchDecision.reasoning}`);

  if (!searchDecision.url) {
    throw new Error('Claude did not return a URL to navigate to');
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
${JSON.stringify(links, null, 2)}

If you can see a link to a CSV file for skilled/temporary workers, respond with:
{ "action": "done", "csvUrl": "<full URL of the CSV>", "reasoning": "<why this is the right file>" }

If you need to navigate to another page first, respond with:
{ "action": "click", "url": "<the href to follow>", "reasoning": "<why you need to go there>" }

Respond with JSON only.`;

    const decision = await askClaude(navPrompt);
    console.log(`Claude: ${decision.reasoning}`);

    if (decision.action === 'done' && decision.csvUrl) {
      const csvUrl = new URL(decision.csvUrl, page.url()).href;
      console.log(`\nFound CSV URL: ${csvUrl}`);
      await browser.close();
      return csvUrl;
    }

    if (decision.action === 'click' && decision.url) {
      nextUrl = new URL(decision.url, page.url()).href;
      continue;
    }

    break;
  }

  await browser.close();
  throw new Error(
    'Could not find the CSV URL within the maximum number of steps',
  );
}

main()
  .then((url) => {
    // Final output — this is what GitHub Actions would capture
    console.log(`::set-output name=csv-url::${url}`);
  })
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
