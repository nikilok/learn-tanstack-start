/**
 * The six landmarks, as data rather than markup: Big Ben, the London Eye, St Paul's, Tower
 * Bridge, the Shard and the Gherkin, each a list of marks standing on the ground line.
 *
 * They are expressed this way so the footer's SVG and the desktop app's canvas draw the
 * SAME line work — the mini game is meant to read as a natural extension of the footer,
 * and the only way that survives a change to either is one source of truth. A consumer
 * maps `Ink` to its own palette and `fill` to its own paint; nothing here knows about CSS.
 */
import { r } from './units.ts';

/** Which real-world material a mark is painted in. Light mode colours by these; dark
 * mode ignores them and inks everything in one faint outline. */
export type Ink =
  | 'limestone'
  | 'roofSlate'
  | 'clockBlue'
  | 'gold'
  | 'steel'
  | 'capsuleGlass'
  | 'portland'
  | 'lead'
  | 'bridgeBlue'
  | 'shardGlass'
  | 'gherkinGlass';

/**
 * `tint` fills a stroked shape translucently, `wash` is a fill-only silhouette behind line
 * work, `face` is the opaque clock dial. Light mode only — dark mode draws outlines alone.
 */
export type Fill = 'tint' | 'wash' | 'face';

export interface Mark {
  d: string;
  /** Overrides the landmark's own ink. */
  ink?: Ink;
  fill?: Fill;
  /** Stroke width, where it differs from the skyline's default of 2. */
  width?: number;
  /** Horizontal offset, for repeated parts (Tower Bridge's second tower). */
  dx?: number;
  /** Path data this mark is clipped to (the Gherkin's lattice). */
  clip?: string;
}

export interface Landmark {
  id: LandmarkId;
  label: string;
  /** Bounding box in skyline units, from the mark's top down to the ground line. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The ink every mark uses unless it names its own. */
  ink: Ink;
  marks: Mark[];
}

export type LandmarkId =
  | 'bigBen'
  | 'eye'
  | 'stPauls'
  | 'towerBridge'
  | 'shard'
  | 'gherkin';

/** A circle as path data, so every mark is one shape of one kind. */
function circle(cx: number, cy: number, rad: number): string {
  return `M${r(cx - rad)},${r(cy)} a${rad},${rad} 0 1 0 ${rad * 2},0 a${rad},${rad} 0 1 0 ${-rad * 2},0 Z`;
}

// London Eye geometry — a wheel floating on an A-frame to the ground line.
const EYE_CX = 335;
const EYE_CY = 408;
const EYE_R = 112;
const EYE_SPOKES = 24;

/** Builds the Eye's spokes (hub → rim) and the capsules hanging off it. */
function buildEye() {
  const spokes: string[] = [];
  const capsules: Array<{ cx: number; cy: number }> = [];
  for (let i = 0; i < EYE_SPOKES; i++) {
    const a = (i / EYE_SPOKES) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    spokes.push(
      `M${r(EYE_CX + 16 * cos)},${r(EYE_CY + 16 * sin)} L${r(EYE_CX + 104 * cos)},${r(EYE_CY + 104 * sin)}`,
    );
    capsules.push({ cx: r(EYE_CX + EYE_R * cos), cy: r(EYE_CY + EYE_R * sin) });
  }
  return { spokes, capsules };
}

// The Shard — straight tapering edges with horizontal floor bands.
const SHARD = {
  baseL: 1140,
  baseR: 1226,
  apexL: 1182,
  apexR: 1186,
  baseY: 600,
  apexY: 108,
};

/** Interpolates the Shard's left/right edge x at each floor line height. */
function buildShardFloors() {
  const floors: Array<{ x1: number; x2: number; y: number }> = [];
  for (let y = 562; y >= 150; y -= 30) {
    const t = (SHARD.baseY - y) / (SHARD.baseY - SHARD.apexY);
    floors.push({
      x1: r(SHARD.baseL + (SHARD.apexL - SHARD.baseL) * t),
      x2: r(SHARD.baseR + (SHARD.apexR - SHARD.baseR) * t),
      y,
    });
  }
  return floors;
}

// The Gherkin — a bullet silhouette filled with a clipped diamond lattice.
const GHERKIN_SILHOUETTE =
  'M1312,600 C1300,540 1300,500 1303,455 C1308,380 1322,300 1338,250 ' +
  'C1354,300 1368,380 1373,455 C1376,500 1376,540 1364,600 Z';

/** Generates the two diagonal line families forming the Gherkin's mesh. */
function buildGherkinLattice() {
  const x0 = 1290;
  const x1 = 1386;
  const lines: string[] = [];
  // Slope -1 (/): y = c - x.
  for (let c = 1520; c <= 1986; c += 22) {
    lines.push(`M${x0},${r(c - x0)} L${x1},${r(c - x1)}`);
  }
  // Slope +1 (\): y = x + c.
  for (let c = -1156; c <= -690; c += 22) {
    lines.push(`M${x0},${r(x0 + c)} L${x1},${r(x1 + c)}`);
  }
  return lines;
}

/** Samples a quadratic Bézier so suspension hangers drop from chain to deck. */
function buildHangers(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  deckY: number,
  ts: number[],
) {
  return ts.map((t) => {
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
    const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
    return `M${r(x)},${r(y)} L${r(x)},${deckY}`;
  });
}

const { spokes: eyeSpokes, capsules: eyeCapsules } = buildEye();
const shardFloors = buildShardFloors();
const gherkinLattice = buildGherkinLattice();
const centralHangers = buildHangers(
  [758, 366],
  [860, 475],
  [962, 366],
  560,
  [0.22, 0.36, 0.5, 0.64, 0.78],
);
const leftSideHangers = buildHangers(
  [692, 366],
  [650, 500],
  [610, 560],
  560,
  [0.35, 0.6, 0.82],
);
const rightSideHangers = buildHangers(
  [1028, 366],
  [1070, 500],
  [1110, 560],
  560,
  [0.35, 0.6, 0.82],
);

/** One of Tower Bridge's two towers, drawn at the left position and repeated at +270. */
const BRIDGE_TOWER: Mark[] = [
  { d: 'M692,560 L692,335 L758,335 L758,560', ink: 'portland', fill: 'tint' },
  {
    d: 'M692,380 L758,380 M692,420 L758,420 M692,460 L758,460 M692,500 L758,500 M692,540 L758,540',
    ink: 'portland',
  },
  {
    d: 'M708,345 L708,555 M725,345 L725,555 M742,345 L742,555',
    ink: 'portland',
  },
  { d: 'M684,335 L766,335', ink: 'portland' },
  { d: 'M709,335 L709,302 L741,302 L741,335', ink: 'portland', fill: 'tint' },
  { d: 'M703,302 L725,255 L747,302', ink: 'portland', fill: 'tint' },
  { d: 'M725,255 L725,243', ink: 'portland' },
  {
    d: 'M686,335 L686,318 L696,318 L696,335 M686,318 L691,306 L696,318',
    ink: 'portland',
    fill: 'tint',
  },
  {
    d: 'M754,335 L754,318 L764,318 L764,335 M754,318 L759,306 L764,318',
    ink: 'portland',
    fill: 'tint',
  },
];

export const LANDMARKS: Record<LandmarkId, Landmark> = {
  bigBen: {
    id: 'bigBen',
    label: 'Big Ben',
    x: 114,
    y: 91,
    w: 72,
    h: 509,
    ink: 'limestone',
    marks: [
      { d: 'M124,320 L176,320 L176,600 L124,600 Z', fill: 'wash' },
      { d: circle(150, 96, 5), ink: 'gold', fill: 'tint' },
      { d: 'M150,118 L150,101', ink: 'gold' },
      { d: 'M118,210 L150,118 L182,210', ink: 'roofSlate', fill: 'tint' },
      { d: 'M118,210 L182,210', ink: 'roofSlate' },
      { d: 'M122,210 L122,255 L178,255 L178,210', fill: 'tint' },
      {
        d: 'M134,215 L134,250 M146,215 L146,250 M158,215 L158,250 M170,215 L170,250',
      },
      { d: 'M114,255 L114,265 L186,265 L186,255', fill: 'tint' },
      { d: 'M120,265 L120,320 L180,320 L180,265', fill: 'tint' },
      { d: circle(150, 292, 19), ink: 'clockBlue', fill: 'face' },
      { d: 'M150,292 L150,279 M150,292 L161,292', ink: 'clockBlue' },
      { d: 'M124,320 L124,600 M176,320 L176,600' },
      { d: 'M138,330 L138,600 M150,330 L150,600 M162,330 L162,600' },
      { d: 'M124,420 L176,420 M124,510 L176,510' },
    ],
  },

  eye: {
    id: 'eye',
    label: 'London Eye',
    x: 217,
    y: 290,
    w: 236,
    h: 310,
    ink: 'steel',
    marks: [
      { d: 'M305,600 L335,408 M368,600 L335,408' },
      { d: 'M316,600 L356,600' },
      { d: circle(EYE_CX, EYE_CY, 118) },
      { d: circle(EYE_CX, EYE_CY, 104) },
      { d: circle(EYE_CX, EYE_CY, 16) },
      { d: circle(EYE_CX, EYE_CY, 5) },
      ...eyeSpokes.map((d) => ({ d })),
      ...eyeCapsules.map((c) => ({
        d: circle(c.cx, c.cy, 6),
        ink: 'capsuleGlass' as const,
        fill: 'tint' as const,
      })),
    ],
  },

  stPauls: {
    id: 'stPauls',
    label: "St Paul's Cathedral",
    x: 478,
    y: 279,
    w: 164,
    h: 321,
    ink: 'portland',
    marks: [
      { d: 'M478,470 L642,470 L642,595 L478,595 Z', fill: 'wash' },
      { d: 'M560,279 L560,305 M553,293 L567,293', ink: 'gold' },
      { d: 'M550,305 Q560,296 570,305', ink: 'lead', fill: 'tint' },
      { d: 'M550,330 L550,305 L570,305 L570,330', fill: 'tint' },
      {
        d: 'M525,395 Q525,335 560,330 Q595,335 595,395',
        ink: 'lead',
        fill: 'tint',
      },
      { d: 'M525,440 L525,395 L595,395 L595,440', fill: 'tint' },
      {
        d: 'M537,400 L537,438 M549,400 L549,438 M561,400 L561,438 M573,400 L573,438 M585,400 L585,438',
      },
      { d: 'M488,470 L560,440 L632,470', fill: 'tint' },
      { d: 'M478,470 L478,600 M642,470 L642,600' },
      {
        d: 'M505,470 L505,595 M527,470 L527,595 M549,470 L549,595 M571,470 L571,595 M593,470 L593,595 M615,470 L615,595',
      },
      { d: 'M478,595 L642,595' },
      {
        d: 'M482,470 L482,430 L500,430 L500,470 M482,430 L491,418 L500,430',
        fill: 'tint',
      },
      {
        d: 'M620,470 L620,430 L638,430 L638,470 M620,430 L629,418 L638,430',
        fill: 'tint',
      },
    ],
  },

  towerBridge: {
    id: 'towerBridge',
    label: 'Tower Bridge',
    x: 610,
    y: 243,
    w: 500,
    h: 357,
    ink: 'bridgeBlue',
    marks: [
      // deck and outer approaches
      { d: 'M610,560 L1110,560' },
      { d: 'M610,560 L610,600 M1110,560 L1110,600', ink: 'portland' },
      {
        d: 'M686,560 L686,600 M764,560 L764,600 M956,560 L956,600 M1034,560 L1034,600',
        ink: 'portland',
      },
      { d: 'M768,560 Q860,600 952,560' },

      // towers — the right one is the left one shifted +270
      ...BRIDGE_TOWER,
      ...BRIDGE_TOWER.map((m) => ({ ...m, dx: 270 })),

      // high-level walkways
      { d: 'M758,338 L962,338 L962,366 L758,366 Z', fill: 'wash' },
      { d: 'M758,338 L962,338 M758,366 L962,366' },
      { d: 'M758,338 L758,366 M962,338 L962,366' },
      {
        d: 'M772,338 L772,366 M788,338 L788,366 M804,338 L804,366 M820,338 L820,366 M836,338 L836,366 M884,338 L884,366 M900,338 L900,366 M916,338 L916,366 M932,338 L932,366 M948,338 L948,366',
      },
      { d: 'M845,338 L860,322 L875,338' },

      // suspension chains + hangers
      { d: 'M758,366 Q860,475 962,366' },
      { d: 'M692,366 Q650,500 610,560' },
      { d: 'M1028,366 Q1070,500 1110,560' },
      ...[...centralHangers, ...leftSideHangers, ...rightSideHangers].map(
        (d) => ({ d }),
      ),
    ],
  },

  shard: {
    id: 'shard',
    label: 'The Shard',
    x: 1140,
    y: 82,
    w: 86,
    h: 518,
    ink: 'shardGlass',
    marks: [
      { d: 'M1140,600 L1181,112 L1187,112 L1226,600 Z', fill: 'wash' },
      { d: 'M1140,600 L1181,112 M1226,600 L1187,112' },
      { d: 'M1183,560 L1184,118' },
      { d: 'M1181,112 L1178,88 M1184,112 L1184,82 M1187,112 L1191,92' },
      ...shardFloors.map((f) => ({ d: `M${f.x1},${f.y} L${f.x2},${f.y}` })),
    ],
  },

  gherkin: {
    id: 'gherkin',
    label: 'The Gherkin',
    x: 1300,
    y: 228,
    w: 76,
    h: 372,
    ink: 'gherkinGlass',
    marks: [
      { d: circle(1338, 232, 4) },
      { d: 'M1338,250 L1338,236' },
      { d: GHERKIN_SILHOUETTE, fill: 'tint' },
      ...gherkinLattice.map((d) => ({
        d,
        width: 1.4,
        clip: GHERKIN_SILHOUETTE,
      })),
      {
        d: 'M1290,360 L1386,360 M1290,440 L1386,440 M1290,520 L1386,520',
        clip: GHERKIN_SILHOUETTE,
      },
    ],
  },
};

/** Left to right along the ground line, which is the order the footer draws them in. */
export const LANDMARK_ORDER: LandmarkId[] = [
  'bigBen',
  'eye',
  'stPauls',
  'towerBridge',
  'shard',
  'gherkin',
];
