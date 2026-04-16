import { layout, prepare } from '@chenglou/pretext';
import { useEffect, useRef, useState } from 'react';
import { dlog } from '../utils';

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
    dlog('[useCardMetrics] effect: fonts.status =', document.fonts.status);
    document.fonts.ready.then(() => {
      dlog(
        '[useCardMetrics] fonts.ready resolved at',
        performance.now().toFixed(1),
      );
      requestAnimationFrame(() => {
        dlog(
          '[useCardMetrics] rAF after fonts.ready at',
          performance.now().toFixed(1),
        );
        dlog(
          '[useCardMetrics] fonts.check 600 16px Geist =',
          document.fonts.check('600 16px Geist'),
        );
        dlog(
          '[useCardMetrics] fonts.check 14px Geist =',
          document.fonts.check('14px Geist'),
        );
        setFontsReady(true);
      });
    });
  }, []);

  // Only prepare once fonts are loaded — canvas measurements need the real font
  if (fontsReady) {
    if (items.length < metricsRef.current.length) {
      metricsRef.current = []; // data reset (e.g. new search)
    }
    if (items.length > metricsRef.current.length) {
      dlog(
        '[useCardMetrics] preparing',
        items.length - metricsRef.current.length,
        'items at',
        performance.now().toFixed(1),
      );
      metricsRef.current = [
        ...metricsRef.current,
        ...items
          .slice(metricsRef.current.length)
          .map((item) =>
            fields.map((field) => prepare(field.getText(item), field.font)),
          ),
      ];
    }
  } else {
    dlog(
      '[useCardMetrics] render: skipping prepare, fontsReady =',
      fontsReady,
      'items =',
      items.length,
    );
  }

  const estimateSize = (index: number, contentWidth: number): number => {
    let height = fixedHeight;
    const handles = metricsRef.current[index];
    for (let i = 0; i < handles.length; i++) {
      height += layout(handles[i], contentWidth, fields[i].lineHeight).height;
    }
    return height;
  };

  return { estimateSize, ready: fontsReady };
}
