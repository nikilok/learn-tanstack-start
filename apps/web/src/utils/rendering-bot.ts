const RENDERING_BOT_RE = /googlebot|bingbot/i;

/** True when `userAgent` belongs to a rendering crawler (Googlebot, bingbot). Their renders execute the app at crawl rate, so map surfaces skip mounting and the geocode fn skips Nominatim — maps are decoration a crawler doesn't index, and the upstream quotas are sized for people. */
export function isRenderingBot(userAgent: string): boolean {
  return RENDERING_BOT_RE.test(userAgent);
}
