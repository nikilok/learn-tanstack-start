import { clearCache, layout, prepare } from '@chenglou/pretext';
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
  const [, setVersion] = useState(0);

  // Re-prepare with correct font metrics once fonts finish loading.
  // Initial prepare uses whatever font is available (matching font-display: swap).
  useEffect(() => {
    document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        if (metricsRef.current.length > 0) {
          clearCache();
          metricsRef.current = [];
          setVersion((v) => v + 1);
        }
      });
    });
  }, []);

  // Prepare immediately — don't wait for fonts
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

  const estimateSize = (index: number, contentWidth: number): number => {
    let height = fixedHeight;
    const handles = metricsRef.current[index];
    for (let i = 0; i < handles.length; i++) {
      height += layout(handles[i], contentWidth, fields[i].lineHeight).height;
    }
    return height;
  };

  return estimateSize;
}
