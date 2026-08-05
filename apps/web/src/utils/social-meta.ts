// The og:image declaration for shared links.
//
// EXACTLY ONE og:image. The property is an array and consumers disagree about which entry wins:
// the spec says the first, but six days of production traffic with two declared showed every
// crawler fetching the SECOND. /og.png (1200x630) was fetched 0 times while /og-square.png
// (1200x1200) was fetched 95 — so every shared link rendered a square inside a card declared
// twitter:card=summary_large_image, which expects 1.91:1 and crops it.

const ORIGIN = 'https://sponsorsearch.co.uk';

/** 1200x630 — the ratio WhatsApp, LinkedIn, Slack, Discord and X all render as a large card. */
export const OG_IMAGE = {
  url: `${ORIGIN}/og.png`,
  width: '1200',
  height: '630',
} as const;

/** og:image plus its structured width/height, which attach to the preceding og:image. */
export function ogImageMeta(): { property: string; content: string }[] {
  return [
    { property: 'og:image', content: OG_IMAGE.url },
    { property: 'og:image:width', content: OG_IMAGE.width },
    { property: 'og:image:height', content: OG_IMAGE.height },
  ];
}
