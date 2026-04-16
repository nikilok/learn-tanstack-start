import type { RefObject } from 'react';

export type TextField<T> = {
  /** Extract the text string from an item for measurement. */
  getText: (item: T) => string;
  /** Canvas font shorthand, e.g. `'600 16px Inter'`. Must match the rendered CSS. */
  font: string;
  /** Line height in px. Must match the CSS line-height. */
  lineHeight: number;
};

export type UseVirtualTextLayoutOptions<T> = {
  /** Text fields whose height varies with wrapping. */
  fields: TextField<T>[];
  /** Total height in px of fixed-size elements (padding, icons, single-line text, etc.). */
  fixedHeight: number;
  /** Ref to a DOM element with the same horizontal padding as the list container — used for content-box width measurement. */
  containerRef: RefObject<HTMLDivElement | null>;
};

export type UseVirtualTextLayoutResult = {
  /** Returns the estimated height for the item at `index`. Pass directly to `estimateSize` on your virtualizer. */
  estimateSize: (index: number) => number;
  /** `true` once fonts are loaded and container width is measured — safe to render items. */
  ready: boolean;
  /** Measured content-box width of the container in px. */
  contentWidth: number;
};
