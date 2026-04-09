/**
 * Renders platform-specific OG images by compositing the logo SVG onto the base image.
 *
 * Usage: bun run render:og
 *
 * Base image: scripts/og-base.png (clean screens, no logos)
 * Output:
 *   public/og.png           — 1200x630  (Facebook, WhatsApp, LinkedIn)
 *   public/og-twitter.png   — 1200x675  (Twitter/X summary_large_image)
 *   public/og-square.png    — 1200x1200 (Instagram, Telegram, fallback)
 *
 * If you change the logo design, update the SVG string below and re-run.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = join(__dirname, 'og-base.png');
const publicDir = join(__dirname, '..', 'public');

const logoSvg = `<svg viewBox="0 0 790 150" xmlns="http://www.w3.org/2000/svg">
  <rect width="735" height="150" fill="white"/>
  <g transform="translate(30, 10)">
    <path d="M75,10 H20 A10,10 0 0 0 10,20 V100 A10,10 0 0 0 20,110 H85" fill="none" stroke="#001C55" stroke-width="6" stroke-linecap="round"/>
    <path d="M100,35 V20 A10,10 0 0 0 90,10 H85" fill="none" stroke="#001C55" stroke-width="6" stroke-linecap="round"/>
    <rect x="95" y="100" width="14" height="30" rx="6" ry="6" fill="#001C55" transform="rotate(-45 95 100)"/>
    <rect x="98" y="80" width="7" height="30" rx="6" ry="6" fill="#001C55" transform="rotate(-45 95 100)"/>
    <circle cx="60" cy="60" r="38" fill="#001C55"/>
    <clipPath id="c"><circle cx="60" cy="60" r="29"/></clipPath>
    <g clip-path="url(#c)">
      <rect x="18" y="18" width="84" height="84" fill="#012169"/>
      <path d="M18,18 L102,102 M102,18 L18,102" stroke="white" stroke-width="12"/>
      <path d="M18,18 L102,102 M102,18 L18,102" stroke="#C8102E" stroke-width="4"/>
      <path d="M60,18 V102 M18,60 H102" stroke="white" stroke-width="20"/>
      <path d="M60,18 V102 M18,60 H102" stroke="#C8102E" stroke-width="12"/>
    </g>
  </g>
  <text x="145" y="95" font-size="82" fill="#001C55" font-family="sans-serif" font-weight="600">Sponsor</text>
  <text x="465" y="95" font-size="82" fill="#C8102E" font-family="sans-serif" font-weight="600">Search</text>
  <text x="740" y="130" font-size="40" text-anchor="end" fill="#001C55" font-family="sans-serif" font-weight="600">.co.uk</text>
</svg>`;

const white = { r: 255, g: 255, b: 255, alpha: 1 };

interface Variant {
  name: string;
  file: string;
  width: number;
  height: number;
  laptop: { left: number; top: number; width: number; height: number };
  mobile: { left: number; top: number; width: number; height: number };
}

const variants: Variant[] = [
  {
    name: 'Facebook/WhatsApp/LinkedIn',
    file: 'og.png',
    width: 1200,
    height: 630,
    laptop: { left: 330, top: 240, width: 420, height: 86 },
    mobile: { left: 890, top: 380, width: 120, height: 25 },
  },
  {
    name: 'Twitter/X',
    file: 'og-twitter.png',
    width: 1200,
    height: 675,
    laptop: { left: 330, top: 260, width: 420, height: 86 },
    mobile: { left: 890, top: 400, width: 120, height: 25 },
  },
  {
    name: 'Square (Instagram/Telegram)',
    file: 'og-square.png',
    width: 1200,
    height: 1200,
    laptop: { left: 350, top: 550, width: 420, height: 86 },
    mobile: { left: 890, top: 660, width: 120, height: 25 },
  },
];

if (!existsSync(basePath)) {
  console.error('Missing base image:', basePath);
  process.exit(1);
}

for (const variant of variants) {
  const laptopLogo = await sharp(Buffer.from(logoSvg))
    .resize(variant.laptop.width, variant.laptop.height, {
      fit: 'contain',
      background: white,
    })
    .png()
    .toBuffer();

  const mobileLogo = await sharp(Buffer.from(logoSvg))
    .resize(variant.mobile.width, variant.mobile.height, {
      fit: 'contain',
      background: white,
    })
    .png()
    .toBuffer();

  const outPath = join(publicDir, variant.file);

  await sharp(basePath)
    .resize(variant.width, variant.height, { fit: 'cover' })
    .composite([
      { input: laptopLogo, left: variant.laptop.left, top: variant.laptop.top },
      { input: mobileLogo, left: variant.mobile.left, top: variant.mobile.top },
    ])
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  const { size } = statSync(outPath);
  console.log(
    `${variant.name.padEnd(30)} → ${variant.file} (${variant.width}x${variant.height}, ${(size / 1024).toFixed(0)} KB)`,
  );
}
