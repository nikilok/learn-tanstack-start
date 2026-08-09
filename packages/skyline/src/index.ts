/**
 * The London skyline, as pure geometry. Rendered as an SVG watermark by the site footer
 * and drawn onto a canvas by the desktop app's stand-in screen, from this one description.
 */
export {
  CELESTIAL,
  CLOUDS,
  CLOUD_PUFFY,
  CLOUD_WIDE,
  MOON_PATH,
  MOON_R,
  STARS,
  SUN_R,
  SUN_RAYS,
  buildStar,
} from './celestial.ts';
export type { CloudPlacement } from './celestial.ts';
export { INK_COLOR, INK_STROKES } from './ink.ts';
export type { InkStroke } from './ink.ts';
export { LANDMARKS, LANDMARK_ORDER } from './landmarks.ts';
export type { Fill, Ink, Landmark, LandmarkId, Mark } from './landmarks.ts';
export { GROUND_Y, VIEW_H, VIEW_W, mulberry32, r, ri } from './units.ts';
