/**
 * The ink sweep's skeleton — the stations its two edges are interpolated between. Kept
 * apart from the generators so the sampling helpers stay readable next to the table they
 * read from.
 */

/** [x, top edge y, bottom edge y] stations across the sky. */
export const INK_STATIONS: Array<[number, number, number]> = [
  [66, 148, 148],
  [120, 100, 166],
  [180, 70, 180],
  [240, 46, 188],
  [300, 34, 190],
  [360, 38, 196],
  [420, 52, 202],
  [480, 74, 208],
  [540, 96, 216],
  [600, 108, 232],
  [660, 110, 258],
  [720, 102, 280],
  [780, 106, 286],
  [840, 130, 288],
  [900, 158, 284],
  [940, 160, 282],
  [1000, 136, 280],
  [1060, 106, 276],
  [1120, 74, 268],
  [1180, 48, 252],
  [1240, 28, 240],
  [1300, 18, 228],
  [1360, 14, 214],
  [1420, 20, 196],
  [1450, 34, 180],
];

/** Catmull-Rom interpolation of a station edge (1 = top, 2 = bottom) at x. */
export function edgeYAt(x: number, edge: 1 | 2): number {
  const s = INK_STATIONS;
  const cx = Math.min(s[s.length - 1][0], Math.max(s[0][0], x));
  let i = 0;
  while (i < s.length - 2 && s[i + 1][0] <= cx) i++;
  const t = (cx - s[i][0]) / (s[i + 1][0] - s[i][0]);
  const y0 = s[Math.max(0, i - 1)][edge];
  const y1 = s[i][edge];
  const y2 = s[i + 1][edge];
  const y3 = s[Math.min(s.length - 1, i + 2)][edge];
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * y1 +
      (-y0 + y2) * t +
      (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
      (-y0 + 3 * y1 - 3 * y2 + y3) * t3)
  );
}

/** Local tangent angle of a sweep edge at x (radians, SVG y-down). */
export function edgeAngleAt(x: number, edge: 1 | 2): number {
  return Math.atan2(edgeYAt(x + 20, edge) - edgeYAt(x - 20, edge), 40);
}
