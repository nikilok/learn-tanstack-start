import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

const companyName = process.argv[2];
if (!companyName) {
  console.error('Usage: bun run company:lookup <company-name>');
  process.exit(1);
}

const anthropic = new Anthropic();

console.log(`Looking up: ${companyName}...\n`);

const response = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 1024,
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  messages: [
    {
      role: 'user',
      content: `Search the web for the company "${companyName}" and find their official website. Based on what you find, provide a concise summary of:

1. What the company does
2. Their industry/sector
3. Where they are based
4. A brief description of their main products or services

If you cannot find reliable information, say so clearly.`,
    },
  ],
});

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
