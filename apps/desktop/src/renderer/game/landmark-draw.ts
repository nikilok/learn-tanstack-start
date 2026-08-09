/**
 * Draws the footer's landmarks onto a canvas. The geometry comes from @ss/skyline — the
 * same description the site's own SVG renders — so an obstacle in the game is the same
 * line work as the building standing in the footer, at whatever size it is asked for.
 */
import { LANDMARKS } from '@ss/skyline';
import type { Ink, LandmarkId, Mark } from '@ss/skyline';

/** The footer's light-mode palette: a muted take on each landmark's real material. */
const INK_COLORS: Record<Ink, [number, number, number]> = {
  limestone: [0xb0, 0x8d, 0x55], // Big Ben's honeyed Anston stone
  roofSlate: [0x6e, 0x7d, 0x78], // its grey-green cast-iron spire
  clockBlue: [0x3c, 0x61, 0x83], // the dials' restored Prussian blue
  gold: [0xbd, 0x94, 0x33], // gilded finial + St Paul's cross
  steel: [0x9d, 0xa9, 0xb4], // the Eye's white-painted steel
  capsuleGlass: [0x79, 0xa5, 0xc8], // its glazed capsules
  portland: [0xab, 0x9e, 0x85], // Portland-stone masonry
  lead: [0x86, 0x95, 0xa1], // St Paul's lead-sheathed dome
  bridgeBlue: [0x6b, 0x9d, 0xcb], // Tower Bridge's blue-painted steelwork
  shardGlass: [0x8f, 0xb3, 0xd1], // the Shard's pale glazing
  gherkinGlass: [0x72, 0xa5, 0xab], // the Gherkin's blue-green glass
};

/** The ink every outline is mixed toward, so edges stay crisp over the coloured washes. */
const OUTLINE = [0x1f, 0x2c, 0x3a] as const;

/** Blends two channels the way the stylesheet's color-mix does. */
function mix(a: readonly number[], b: readonly number[], t: number): string {
  const ch = (i: number) => Math.round(a[i]! * t + b[i]! * (1 - t));
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

const LIGHT_STROKE = {} as Record<Ink, string>;
const LIGHT_TINT = {} as Record<Ink, string>;
for (const [name, rgb] of Object.entries(INK_COLORS) as [Ink, number[]][]) {
  LIGHT_STROKE[name] = mix(rgb, OUTLINE, 0.7);
  LIGHT_TINT[name] = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.45)`;
}

export interface LandmarkPaint {
  stroke: (ink: Ink) => string;
  /** Null in dark mode, where the footer draws outlines with no wash behind them. */
  tint: ((ink: Ink) => string) | null;
  /** The clock dial, which stays opaque over Big Ben's wash. */
  face: string;
  /** Screen px, held constant however small the landmark is drawn. */
  lineWidth: number;
}

/**
 * Light mode colours each landmark in its own material and fills the washes behind the
 * line work; dark mode inks the whole skyline in one faint outline, exactly as the footer
 * does — except a shade stronger here, because these are obstacles to be jumped and not a
 * watermark to be half-noticed.
 */
export function landmarkPaint(dark: boolean): LandmarkPaint {
  if (dark) {
    const ink = 'rgba(237,237,237,0.55)';
    return { stroke: () => ink, tint: null, face: '#0a0a0a', lineWidth: 1.15 };
  }
  return {
    stroke: (i) => LIGHT_STROKE[i],
    tint: (i) => LIGHT_TINT[i],
    face: '#ffffff',
    lineWidth: 1.15,
  };
}

// Path2D takes SVG path data as-is, and the same marks are redrawn every frame, so each
// one is compiled once for the life of the screen.
const paths = new Map<string, Path2D>();
function pathFor(d: string): Path2D {
  let p = paths.get(d);
  if (!p) {
    p = new Path2D(d);
    paths.set(d, p);
  }
  return p;
}

/**
 * Draws one landmark standing on `groundY`, `h` px tall and scaled uniformly — its width
 * follows from its own proportions, which is why the caller derives `w` the same way.
 */
export function drawLandmark(
  c: CanvasRenderingContext2D,
  id: LandmarkId,
  x: number,
  groundY: number,
  h: number,
  paint: LandmarkPaint,
): void {
  const l = LANDMARKS[id];
  const s = h / l.h;
  c.save();
  // Land the landmark's bounding box on (x, groundY - h): its own ground line is the
  // bottom of that box, so it stands on the road rather than floating over it.
  c.translate(x, groundY - h);
  c.scale(s, s);
  c.translate(-l.x, -l.y);
  c.lineJoin = 'round';
  c.lineCap = 'round';

  for (const m of l.marks as Mark[]) {
    const ink = m.ink ?? l.ink;
    const path = pathFor(m.d);
    c.save();
    if (m.dx) c.translate(m.dx, 0);
    if (m.clip) c.clip(pathFor(m.clip));

    if (m.fill && paint.tint) {
      c.fillStyle = m.fill === 'face' ? paint.face : paint.tint(ink);
      c.fill(path);
    }
    // A wash is a silhouette behind the line work, never outlined itself.
    if (m.fill !== 'wash') {
      c.strokeStyle = paint.stroke(ink);
      // Undo the landmark's scale so every line lands at the same weight on screen,
      // whatever size the obstacle is; the stylesheet's 2-unit default is the reference.
      c.lineWidth = (((m.width ?? 2) / 2) * paint.lineWidth) / s;
      c.stroke(path);
    }
    c.restore();
  }
  c.restore();
}
