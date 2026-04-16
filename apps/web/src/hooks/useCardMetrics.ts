import { layout, prepare } from '@chenglou/pretext';
import { useEffect, useRef, useState } from 'react';

interface TextField<T> {
  getText: (item: T) => string;
  font: string;
  lineHeight: number;
}

interface UseCardMetricsOptions<T> {
  fields: TextField<T>[];
  fixedHeight: number;
}

export function useCardMetrics<T>(
  items: T[],
  options: UseCardMetricsOptions<T>,
) {
  const { fields, fixedHeight } = options;
  const metricsRef = useRef<ReturnType<typeof prepare>[][]>([]);
  const [fontsReady, setFontsReady] = useState(false);

  // Wait for fonts to be downloaded AND rendered before allowing prepare() —
  // canvas needs one frame after font load to use it for measurement.
  useEffect(() => {
    document.fonts.ready.then(() => {
      requestAnimationFrame(() => setFontsReady(true));
    });
  }, []);

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

  const estimateSize = (index: number, contentWidth: number): number => {
    const handles = metricsRef.current[index];
    if (!handles || !contentWidth) {
      // Before width is measured — assume single-line text fields
      return fixedHeight + fields.reduce((sum, f) => sum + f.lineHeight, 0);
    }
    let height = fixedHeight;
    for (let i = 0; i < handles.length; i++) {
      height += layout(handles[i], contentWidth, fields[i].lineHeight).height;
    }
    return height;
  };

  return { estimateSize, ready: fontsReady };
}
