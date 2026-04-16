import { layout, prepare } from '@chenglou/pretext';
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

interface TextField<T> {
  getText: (item: T) => string;
  font: string;
  lineHeight: number;
}

interface UseCardMetricsOptions<T> {
  fields: TextField<T>[];
  fixedHeight: number;
  containerRef: RefObject<HTMLDivElement | null>;
}

export function useCardMetrics<T>(
  items: T[],
  options: UseCardMetricsOptions<T>,
) {
  const { fields, fixedHeight, containerRef } = options;
  const metricsRef = useRef<ReturnType<typeof prepare>[][]>([]);
  const [fontsReady, setFontsReady] = useState(false);
  const [contentWidth, setContentWidth] = useState(0);

  // Wait for fonts to be downloaded AND rendered before allowing prepare() —
  // canvas needs one frame after font load to use it for measurement.
  useEffect(() => {
    document.fonts.ready.then(() => {
      requestAnimationFrame(() => setFontsReady(true));
    });
  }, []);

  // Measure container content-box width before paint, then track via ResizeObserver.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const paddingX =
      parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    setContentWidth(Math.floor(el.clientWidth - paddingX));
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentBoxSize?.[0]?.inlineSize;
      if (width) setContentWidth(Math.floor(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // Only prepare once fonts are loaded — single pass with correct metrics
  if (fontsReady) {
    if (items.length < metricsRef.current.length) {
      metricsRef.current = []; // data reset (e.g. new search)
    }
    if (items.length > metricsRef.current.length) {
      metricsRef.current = [
        ...metricsRef.current,
        ...items
          .slice(metricsRef.current.length)
          .map((item) =>
            fields.map((field) => prepare(field.getText(item), field.font)),
          ),
      ];
    }
  }

  const ready = fontsReady && contentWidth > 0;

  const estimateSize = (index: number): number => {
    const handles = metricsRef.current[index];
    if (!handles || !contentWidth) {
      return fixedHeight + fields.reduce((sum, f) => sum + f.lineHeight, 0);
    }
    let height = fixedHeight;
    for (let i = 0; i < handles.length; i++) {
      height += layout(handles[i], contentWidth, fields[i].lineHeight).height;
    }
    return height;
  };

  return { estimateSize, ready, contentWidth };
}
