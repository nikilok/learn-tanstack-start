import { layout, prepare } from '@chenglou/pretext';
import { useRef } from 'react';

interface TextField<T> {
  getText: (item: T) => string;
  font: string;
  lineHeight: number;
}

interface UseCardMetricsOptions<T> {
  fields: TextField<T>[];
  fixedHeight: number;
  fallback?: number;
}

export function useCardMetrics<T>(
  items: T[],
  options: UseCardMetricsOptions<T>,
) {
  const { fields, fixedHeight, fallback = 100 } = options;
  const metricsRef = useRef<ReturnType<typeof prepare>[][]>([]);

  // Only prepare newly-loaded items — avoids re-mapping the full list on every render
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

  return (index: number, contentWidth: number): number => {
    const handles = metricsRef.current[index];
    if (!handles || !contentWidth) return fallback;
    let height = fixedHeight;
    for (let i = 0; i < fields.length; i++) {
      height += layout(handles[i], contentWidth, fields[i].lineHeight).height;
    }
    return height;
  };
}
