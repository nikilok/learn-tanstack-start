# virtual-text-layout

Pre-compute virtual list item heights from text content using canvas — zero DOM measurement on the scroll path.

Built on [@chenglou/pretext](https://github.com/chenglou/pretext). Pairs with [@tanstack/react-virtual](https://tanstack.com/virtual) or any virtualizer that accepts an `estimateSize` function.

Peer dependencies: `react >= 18`, `@chenglou/pretext`

## Why not use pretext directly?

pretext gives you `prepare()` and `layout()` — low-level primitives for canvas text measurement. This hook handles the integration work you'd otherwise write yourself: waiting for fonts to load before measuring, tracking container width via ResizeObserver, incrementally preparing new items as they stream in (infinite scroll), and signalling when everything is ready so your virtualizer doesn't render with stale sizes.

## Usage

```tsx
import { useVirtualTextLayout } from 'virtual-text-layout';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

const { estimateSize, ready } = useVirtualTextLayout(items, {
  fields: [
    { getText: (item) => item.title, font: '600 16px Inter', lineHeight: 24 },
    { getText: (item) => item.subtitle, font: '14px Inter', lineHeight: 20 },
  ],
  fixedHeight: 48, // total px of non-text elements (padding, icons, etc.)
  containerRef: listRef,
});

const virtualizer = useWindowVirtualizer({
  count: ready ? items.length : 0,
  estimateSize: (index) => estimateSize(index),
});
```

`ready` is `true` once fonts are loaded and container width is measured. Gate your virtualizer's `count` on it to prevent rendering with incorrect sizes.

## Configuration

- **fields** — text fields whose height varies with wrapping. Each needs:
  - `getText` — extracts the text string from an item, including any transforms applied before render
  - `font` — canvas font shorthand (e.g. `'600 16px Inter'`), must match your CSS
  - `lineHeight` — line height in px, must match your CSS
- **fixedHeight** — total height of fixed-size card elements (padding, margins, icons, single-line text)
- **containerRef** — ref to a DOM element with the same horizontal padding as the list container

## Performance

Measured scrolling through 250 rows (5 pages):

| Metric | measureElement | virtual-text-layout | Change |
|---|---|---|---|
| Recalculate style | 300ms | 171ms | -43% |
| Layout | 194ms | 125ms | -35% |
| Function call total | 1,383ms | 968ms | -30% |
| Paint | 33ms | 25ms | -26% |

## License

MIT
