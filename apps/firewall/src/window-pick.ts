// Choosing the window IP lookups run against: a preset from the timeline list, or a typed range.

import {
  type Window,
  WINDOW_PRESETS,
  resolveWindow,
  rollingWindow,
} from './time-window';

/** The row below the presets, where a custom range is typed. */
export const CUSTOM_ROW = WINDOW_PRESETS.length;

/** Marks a custom range rather than an index into the presets. */
export const CUSTOM = -1;

/** Everything the range field accepts: digits, separators and the spaces between them. */
const RANGE_CHARS = /[^\d\s/.-]/g;
const MAX_RANGE = 32;

/** The preset holding `hours`, or CUSTOM when no preset matches. */
export function presetForHours(hours: number): number {
  return WINDOW_PRESETS.findIndex((p) => p.minutes === hours * 60);
}

/** Where the timeline cursor opens: on whatever is in force, so the list starts where you are. */
export function openCursor(presetIdx: number): number {
  return presetIdx >= 0 ? presetIdx : CUSTOM_ROW;
}

/** Timeline cursor after a move, clamped to the presets plus the custom row. */
export function moveWindowCursor(cursor: number, dir: 1 | -1): number {
  return Math.max(0, Math.min(CUSTOM_ROW, cursor + dir));
}

/** Whether the cursor is on the custom row, which opens the range field instead of applying. */
export function isCustomRow(cursor: number): boolean {
  return cursor >= CUSTOM_ROW;
}

/**
 * What a typed range means.
 *
 * Blank reverts to the rolling default, which IS a preset — marking that custom left the timeline
 * list showing "custom… · in force" above a preset window that was actually in effect.
 */
export function rangeSelection(
  raw: string,
  now: Date,
  defaultHours: number,
): { window: Window; presetIdx: number } | { error: string } {
  const text = raw.trim();
  if (!text)
    return {
      window: rollingWindow(defaultHours, now),
      presetIdx: presetForHours(defaultHours),
    };
  const next = resolveWindow(text, now);
  if ('error' in next) return next;
  return { window: next.window, presetIdx: CUSTOM };
}

/**
 * The range field after a keystroke or a paste.
 *
 * Filtered WITHIN the chunk rather than tested whole: a paste arrives as one event, so requiring
 * the whole string to match would reject every pasted range.
 */
export function typeRange(current: string, chunk: string): string {
  return (current + chunk.replace(RANGE_CHARS, '')).slice(0, MAX_RANGE);
}

/** Whether a chunk ended a line, which submits — a pasted range often carries a trailing newline. */
export function submitsOnPaste(chunk: string): boolean {
  return /[\r\n]/.test(chunk);
}
