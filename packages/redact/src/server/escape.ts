const ATTR_MAP: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
  '<': '&lt;',
  '>': '&gt;',
}
const TEXT_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
}

export function escapeAttr(value: string): string {
  return value.replace(/[&"<>]/g, (c) => ATTR_MAP[c]!)
}

export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (c) => TEXT_MAP[c]!)
}

// Raw-text element body escaping: prevent any closing tag for the raw-text
// elements (<script>, <style>) from terminating the element early, plus
// `<!--` (which would start an HTML comment that survives even inside
// raw-text bodies and can be exploited to alter following script content).
// React's serializer follows the same approach.
export function escapeScript(value: string): string {
  return value
    .replace(/<\/(script|style)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
}

export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

export const RAW_TEXT_ELEMENTS = new Set(['script', 'style'])

// Map JSX prop names to HTML attribute names where they differ. The fallback
// in `attrToHtml` is `name.toLowerCase()`, so any attribute that needs a
// hyphen, a colon (xlink:*), or case preservation MUST be listed here.
// Mirrors `SVG_ATTR_RENAME` in dom/dom.ts so client and SSR output agree
// at hydration time.
export const ATTR_ALIASES: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
  httpEquiv: 'http-equiv',
  acceptCharset: 'accept-charset',
  crossOrigin: 'crossorigin',
  noModule: 'nomodule',
  // SVG attributes whose case is preserved by spec (would otherwise be
  // lowercased by the fallback). Keep this group together for grep-ability.
  viewBox: 'viewBox',
  preserveAspectRatio: 'preserveAspectRatio',
  gradientTransform: 'gradientTransform',
  gradientUnits: 'gradientUnits',
  patternContentUnits: 'patternContentUnits',
  patternTransform: 'patternTransform',
  patternUnits: 'patternUnits',
  attributeName: 'attributeName',
  attributeType: 'attributeType',
  calcMode: 'calcMode',
  keySplines: 'keySplines',
  keyTimes: 'keyTimes',
  keyPoints: 'keyPoints',
  repeatCount: 'repeatCount',
  repeatDur: 'repeatDur',
  tableValues: 'tableValues',
  textLength: 'textLength',
  lengthAdjust: 'lengthAdjust',
  pathLength: 'pathLength',
  baseFrequency: 'baseFrequency',
  numOctaves: 'numOctaves',
  stitchTiles: 'stitchTiles',
  startOffset: 'startOffset',
  // SVG presentation attributes — camelCase JSX → kebab-case DOM.
  // stroke
  strokeDasharray: 'stroke-dasharray',
  strokeDashoffset: 'stroke-dashoffset',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeMiterlimit: 'stroke-miterlimit',
  strokeOpacity: 'stroke-opacity',
  strokeWidth: 'stroke-width',
  // fill
  fillOpacity: 'fill-opacity',
  fillRule: 'fill-rule',
  // clip / mask
  clipPath: 'clip-path',
  clipRule: 'clip-rule',
  // color / lighting
  colorInterpolation: 'color-interpolation',
  colorInterpolationFilters: 'color-interpolation-filters',
  colorProfile: 'color-profile',
  colorRendering: 'color-rendering',
  floodColor: 'flood-color',
  floodOpacity: 'flood-opacity',
  lightingColor: 'lighting-color',
  stopColor: 'stop-color',
  stopOpacity: 'stop-opacity',
  // font
  fontFamily: 'font-family',
  fontSize: 'font-size',
  fontSizeAdjust: 'font-size-adjust',
  fontStretch: 'font-stretch',
  fontStyle: 'font-style',
  fontVariant: 'font-variant',
  fontWeight: 'font-weight',
  // text
  textAnchor: 'text-anchor',
  textDecoration: 'text-decoration',
  textRendering: 'text-rendering',
  alignmentBaseline: 'alignment-baseline',
  baselineShift: 'baseline-shift',
  dominantBaseline: 'dominant-baseline',
  letterSpacing: 'letter-spacing',
  wordSpacing: 'word-spacing',
  writingMode: 'writing-mode',
  // markers
  markerEnd: 'marker-end',
  markerMid: 'marker-mid',
  markerStart: 'marker-start',
  // rendering hints
  pointerEvents: 'pointer-events',
  shapeRendering: 'shape-rendering',
  imageRendering: 'image-rendering',
  vectorEffect: 'vector-effect',
  paintOrder: 'paint-order',
  // misc presentation
  enableBackground: 'enable-background',
  glyphOrientationHorizontal: 'glyph-orientation-horizontal',
  glyphOrientationVertical: 'glyph-orientation-vertical',
  unicodeBidi: 'unicode-bidi',
  // xlink:* (deprecated in SVG2 but still parsed by browsers)
  xlinkActuate: 'xlink:actuate',
  xlinkArcrole: 'xlink:arcrole',
  xlinkHref: 'xlink:href',
  xlinkRole: 'xlink:role',
  xlinkShow: 'xlink:show',
  xlinkTitle: 'xlink:title',
  xlinkType: 'xlink:type',
  // xml:* and xmlns:xlink
  xmlBase: 'xml:base',
  xmlLang: 'xml:lang',
  xmlSpace: 'xml:space',
  xmlnsXlink: 'xmlns:xlink',
}

const BOOLEAN_ATTRS = new Set([
  'allowfullscreen',
  'async',
  'autofocus',
  'autoplay',
  'checked',
  'controls',
  'default',
  'defer',
  'disabled',
  'formnovalidate',
  'hidden',
  'inert',
  'ismap',
  'itemscope',
  'loop',
  'multiple',
  'muted',
  'nomodule',
  'novalidate',
  'open',
  'playsinline',
  'readonly',
  'required',
  'reversed',
  'selected',
])

// HTML attribute names: must start with a letter or underscore and contain
// only letters/digits/`_.-:$`. Anything else (whitespace, quotes, `>`, `/`,
// `=`, etc.) is illegal per the HTML spec and would break out of the
// attribute-name context if emitted, opening attribute-injection XSS via
// untrusted spread props (e.g. `<div {...untrustedJson} />`). React drops
// invalid attribute names; we do the same. The character set is
// deliberately narrow so it accepts every standard HTML/SVG attribute,
// custom data-/aria-* names, and xlink:/xml: namespaced forms — but
// nothing that contains attribute-context delimiters.
const VALID_ATTR_NAME = /^[a-zA-Z_][a-zA-Z0-9_.\-:$]*$/

export function attrToHtml(name: string, value: unknown): string {
  if (
    name === 'children' ||
    name === 'key' ||
    name === 'ref' ||
    name === 'dangerouslySetInnerHTML' ||
    name === 'defaultValue' ||
    name === 'defaultChecked' ||
    name === 'suppressHydrationWarning' ||
    name === 'suppressContentEditableWarning'
  ) {
    return ''
  }
  // Drop every on*-shaped prop on the server, regardless of value type or
  // case. Functions can't be serialized; a string value would land in the
  // catch-all and be emitted as `onclick="…"`, an inline event handler that
  // browsers execute as JS — a direct XSS sink when untrusted props are
  // spread onto a host element. Catches both the camelCase JSX form
  // (`onClick`) and the lowercase HTML form (`onclick`); there is no
  // legitimate non-handler HTML attribute starting with `on`.
  if (
    name.length >= 3 &&
    (name[0] === 'o' || name[0] === 'O') &&
    (name[1] === 'n' || name[1] === 'N')
  ) {
    return ''
  }
  if (value == null) return ''
  // Reject attribute names that don't match the HTML spec. Without this
  // gate, a prop named `foo"><script>` would render as literal markup
  // because the `aria-`/`data-` branch and the catch-all both interpolate
  // the name without escaping. Aliased names from ATTR_ALIASES (and the
  // case-folded `name.toLowerCase()` form) are derived from `name` and
  // can't introduce new characters, so validating `name` covers both.
  if (!VALID_ATTR_NAME.test(name)) return ''

  const htmlName = ATTR_ALIASES[name] ?? name.toLowerCase()

  // aria-* and data-* stringify booleans to `"true"`/`"false"` rather than
  // using boolean-attribute presence semantics — matches React and the ARIA
  // spec. Must branch before the general `value === false` / BOOLEAN_ATTRS
  // path, which would drop them.
  if (name.startsWith('aria-') || name.startsWith('data-')) {
    return ` ${htmlName}="${escapeAttr(String(value))}"`
  }

  if (value === false) return ''

  if (value === true || BOOLEAN_ATTRS.has(htmlName)) {
    return value ? ` ${htmlName}=""` : ''
  }

  if (name === 'style' && typeof value === 'object' && value !== null) {
    return ` style="${escapeAttr(styleToString(value as Record<string, unknown>))}"`
  }

  return ` ${htmlName}="${escapeAttr(String(value))}"`
}

const UNITLESS_STYLE = new Set([
  'animationIterationCount',
  'borderImageOutset',
  'borderImageSlice',
  'borderImageWidth',
  'boxFlex',
  'boxFlexGroup',
  'boxOrdinalGroup',
  'columnCount',
  'columns',
  'flex',
  'flexGrow',
  'flexPositive',
  'flexShrink',
  'flexNegative',
  'flexOrder',
  'gridArea',
  'gridRow',
  'gridRowEnd',
  'gridRowSpan',
  'gridRowStart',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnSpan',
  'gridColumnStart',
  'fontWeight',
  'lineClamp',
  'lineHeight',
  'opacity',
  'order',
  'orphans',
  'tabSize',
  'widows',
  'zIndex',
  'zoom',
  'fillOpacity',
  'floodOpacity',
  'stopOpacity',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
])

function styleToString(style: Record<string, unknown>): string {
  let out = ''
  for (const key in style) {
    const v = style[key]
    if (v == null || v === false) continue
    const kebab = key.startsWith('--')
      ? key
      : key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
    const value =
      typeof v === 'number' && !UNITLESS_STYLE.has(key) && v !== 0 ? v + 'px' : v
    out += `${kebab}:${value};`
  }
  return out
}
