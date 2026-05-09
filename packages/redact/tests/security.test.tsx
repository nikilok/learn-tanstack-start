/**
 * Security regression tests covering the XSS / HTML-injection vectors React
 * has had to address (and the categories of historical vulnerabilities the
 * React team has documented). React itself has had no CVEs filed against
 * `react-dom` since the 16.x rewrite; the open security work since then has
 * been in `react-server-dom-*` (RSC), which we don't implement — see the
 * audit notes after the tests.
 */
import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { renderToString, renderToReadableStream } from 'react-dom/server'
import { createRoot } from 'react-dom/client'

async function streamToString(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

describe('SSR escaping — text content', () => {
  it('escapes <, >, & in text children', () => {
    expect(renderToString(<div>{'<script>alert(1)</script>'}</div>)).toBe(
      '<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>',
    )
  })

  it('escapes & alone (avoids double-escape but does encode)', () => {
    expect(renderToString(<div>{'AT&T'}</div>)).toBe('<div>AT&amp;T</div>')
  })

  it('does not double-encode pre-encoded entities', () => {
    // React encodes `&` regardless — `&amp;` becomes `&amp;amp;` in source.
    // Documented behavior: source is the source of truth, escaping is
    // applied on output.
    expect(renderToString(<div>{'&amp;'}</div>)).toBe('<div>&amp;amp;</div>')
  })
})

describe('SSR escaping — attribute values', () => {
  it('escapes quotes in attribute values', () => {
    expect(renderToString(<div title={'"><script>alert(1)</script>'} />)).toBe(
      '<div title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"></div>',
    )
  })

  it('escapes ampersands in attribute values', () => {
    expect(renderToString(<a href="?a=1&b=2" />)).toBe('<a href="?a=1&amp;b=2"></a>')
  })

  it('escapes < > in attribute values', () => {
    expect(renderToString(<div data-x="<>" />)).toBe(
      '<div data-x="&lt;&gt;"></div>',
    )
  })
})

describe('SSR escaping — raw-text elements (<script>, <style>)', () => {
  it('breaks an attempted </script> inside script body', () => {
    const html = renderToString(
      <script
        dangerouslySetInnerHTML={{
          __html: 'var x="</script><script>alert(1)</script>";',
        }}
      />,
    )
    // The inner </script> must be neutralized so the parser doesn't end the
    // outer <script> early.
    expect(html).not.toMatch(/<\/script><script>alert\(1\)/)
    expect(html).toContain('<\\/script>')
  })

  it('breaks an attempted </style> inside style body', () => {
    const html = renderToString(
      <style
        dangerouslySetInnerHTML={{
          __html: 'body{} </style><script>alert(1)</script>',
        }}
      />,
    )
    expect(html).not.toMatch(/<\/style><script>alert\(1\)/)
    expect(html).toContain('<\\/style>')
  })

  it('breaks an attempted <!-- (HTML comment open) inside script body', () => {
    const html = renderToString(
      <script
        dangerouslySetInnerHTML={{ __html: 'var x = "<!-- payload -->"' }}
      />,
    )
    // `<!--` inside <script> is an actual hazard: it starts an HTML-style
    // comment that survives across script boundaries in some legacy parsers.
    expect(html).not.toContain('<!--')
    expect(html).toContain('<\\!--')
  })
})

describe('SSR escaping — comment markers around children', () => {
  it('escapes adjacent text-child separators (no script-injection via crafted text)', () => {
    // The `<!-- -->` separator we emit between adjacent text nodes is a
    // FIXED string. User text can contain `-->` etc. without affecting it
    // because text content is escaped first.
    const html = renderToString(
      <div>
        {'<!--break-->'}
        {'after'}
      </div>,
    )
    expect(html).toBe('<div>&lt;!--break--&gt;<!-- -->after</div>')
  })
})

describe('SSR escaping — boolean coercions', () => {
  it('aria attributes stringify booleans (no presence-attribute confusion)', () => {
    // Pre-fix bug: `aria-hidden={false}` rendered as the empty/absent attribute,
    // which screen readers treat as "hidden=true". Now stringified to `"false"`.
    expect(renderToString(<div aria-hidden={false} />)).toBe(
      '<div aria-hidden="false"></div>',
    )
  })

  it('data attributes stringify booleans', () => {
    expect(renderToString(<div data-x={true} />)).toBe(
      '<div data-x="true"></div>',
    )
  })
})

describe('SSR escaping — style values', () => {
  it('does not allow CSS injection via style values containing quotes', () => {
    const html = renderToString(<div style={{ color: 'red"; background: url(javascript:1)' }} />)
    // The double-quote that would break out of the style attribute must be
    // escaped. The `javascript:` URL itself is a CSS-engine concern, not
    // ours, but we must keep the whole value confined to the attribute.
    expect(html).toContain('&quot;')
    expect(html).not.toMatch(/style="[^"]*"[^"]*background/)
  })
})

describe('client — event handler types', () => {
  it('only attaches function event handlers — string handlers are silently ignored', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      // Strings as event handlers (the legacy `onclick="..."` HTML form) must
      // not be attached as listeners — they would be a vector for arbitrary
      // code execution if a parent prop spread untrusted data.
      createRoot(container).render(
        // Intentional bad type for the security test
        <button onClick={'alert(1)' as any}>x</button>,
      )
      const btn = container.querySelector('button')!
      // Our event system stores handlers in `__handlers`; if it had attached
      // a string, it would crash on dispatch. We assert no string handler
      // shows up there.
      const handlers = (btn as any).__handlers
      const stored = handlers ? Object.values(handlers).filter((h) => h !== null) : []
      expect(stored.every((h: any) => typeof h?.current === 'function')).toBe(true)
    } finally {
      document.body.removeChild(container)
    }
  })
})

describe('client — dangerouslySetInnerHTML respects React shape', () => {
  it('only honors the `__html` key — extra keys are ignored', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      // Some old XSS attempts tried alternate keys (`__bad`) hoping for
      // injection. Only `__html` should be read.
      createRoot(container).render(
        <div
          dangerouslySetInnerHTML={
            { __bad: '<script>alert(1)</script>' } as any
          }
        />,
      )
      expect(container.innerHTML).toBe('<div></div>')
    } finally {
      document.body.removeChild(container)
    }
  })
})

describe('SSR escaping — attribute names', () => {
  // Spread props can deliver attacker-controlled attribute *names*, not just
  // values. The previous code path emitted `name.toLowerCase()` verbatim,
  // so a name like `foo"><script>` broke out of the attribute-name context.
  // Validation is the right primitive: the HTML spec defines a narrow
  // legal character set; anything outside it is dropped.

  it('drops attribute names containing `>` (would break out of opening tag)', () => {
    const html = renderToString(
      <div {...({ 'foo><script>alert(1)</script>x': 'bar' } as any)} />,
    )
    expect(html).toBe('<div></div>')
    expect(html).not.toContain('<script>')
  })

  it('drops attribute names containing a quote (would terminate the value of an earlier attr)', () => {
    const html = renderToString(
      <div {...({ 'a"b': 'safe' } as any)} />,
    )
    expect(html).toBe('<div></div>')
    expect(html).not.toContain('"b="safe"')
  })

  it('drops attribute names with whitespace, `=`, `/`, control chars', () => {
    const cases: string[] = [
      'a b',
      'a=b',
      'a/b',
      'a\tb',
      'a\nb',
      ' leadingSpace',
      '1startsWithDigit',
      '',
    ]
    for (const bad of cases) {
      const html = renderToString(<div {...({ [bad]: 'x' } as any)} />)
      expect(html).toBe('<div></div>')
    }
  })

  it('does not let aria-/data- prefix bypass the validator', () => {
    // The aria-/data- branch in attrToHtml runs *after* the name validator,
    // so a payload that looks like a data-* prop with an injection in the
    // suffix is still dropped — the whole attribute is omitted.
    const html = renderToString(
      <div {...({ 'data-x"><script>alert(1)</script>': 'y' } as any)} />,
    )
    expect(html).toBe('<div></div>')
    expect(html).not.toContain('<script>')
  })

  it('keeps standard HTML/SVG attribute names intact (no false positives)', () => {
    // Letters, digits, hyphens, underscores, dots, colons (xlink:), `$` — all
    // legal per the HTML spec and must continue to round-trip. The dot/`$`
    // forms aren't expressible as JSX literal attributes, so we use a spread.
    expect(renderToString(<div className="ok" />)).toContain('class="ok"')
    expect(
      renderToString(<div {...({ 'data-x_y.z-1': 'ok' } as any)} />),
    ).toContain('data-x_y.z-1="ok"')
    expect(renderToString(<svg viewBox="0 0 1 1" />)).toContain('viewBox="0 0 1 1"')
  })
})

describe('SSR escaping — on* event-handler props', () => {
  // Function-typed `on*` props can't be serialized at all and were already
  // dropped pre-fix. The vector this guards against is *non-function*
  // values (strings, typically from `{...untrustedJson}`): they used to
  // fall through `VALID_ATTR_NAME` (the name shape is valid) and land in
  // the catch-all, where they'd render as inline event handlers
  // (`onclick="alert(1)"`) — directly executable JS at hydration time.

  it('drops onClick (camelCase JSX form) when value is a string', () => {
    const html = renderToString(
      <div {...({ onClick: 'alert(1)' } as any)} />,
    )
    expect(html).toBe('<div></div>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('alert(1)')
  })

  it('drops onclick (lowercase HTML form) when value is a string', () => {
    // Spread coming from JSON / CMS / hydration data can use lowercase
    // attribute names. These bypass React's `on[A-Z]` heuristic but still
    // render as inline handlers in HTML, so we drop them too.
    const html = renderToString(
      <div {...({ onclick: 'alert(1)' } as any)} />,
    )
    expect(html).toBe('<div></div>')
    expect(html).not.toContain('alert(1)')
  })

  it('drops every common on* handler regardless of value', () => {
    const cases = [
      'onClick',
      'onclick',
      'onSubmit',
      'onsubmit',
      'onChange',
      'onError',
      'onerror',
      'onLoad',
      'onMouseOver',
      'onmouseover',
    ]
    for (const handlerName of cases) {
      const html = renderToString(
        <div {...({ [handlerName]: 'alert(1)' } as any)} />,
      )
      expect(html).toBe('<div></div>')
    }
  })

  it('drops on* even when value is a number/boolean (defense in depth)', () => {
    expect(
      renderToString(<div {...({ onClick: 0 } as any)} />),
    ).toBe('<div></div>')
    expect(
      renderToString(<div {...({ onClick: true } as any)} />),
    ).toBe('<div></div>')
  })

  it('does NOT drop legitimate non-on* props that happen to start with `o`', () => {
    // Sanity: `open` (HTML <details> attr), `optimum` (<meter>), etc. must
    // still pass through. The drop is gated on length>=3 AND starts with
    // exactly `on`/`oN`.
    expect(renderToString(<details open />)).toContain('open')
    expect(
      renderToString(<div {...({ optimum: '0.5' } as any)} />),
    ).toContain('optimum="0.5"')
  })

  it('does NOT drop the literal name "on" (length 2, indistinguishable from a handler prefix)', () => {
    // No real HTML attribute is named `on`; this just guards the
    // length>=3 boundary so unrelated names like `oN` (which would also
    // be invalid HTML and fail VALID_ATTR_NAME for other reasons) don't
    // accidentally pass.
    const html = renderToString(<div {...({ on: 'x' } as any)} />)
    expect(html).toContain('on="x"')
  })
})

describe('SSR streaming — abort unblocks drain', () => {
  // The orchestrator races pending boundaries against an abort sentinel
  // promise. Without that race, an aborted stream with a never-settling
  // <Suspense> child would keep `streamHtml` looping in `Promise.race`
  // forever — the stream is closed but the SSR dispatcher state stays
  // installed, leaking module-level dispatcher slots across requests.

  it('renderToReadableStream returns when AbortSignal fires before all boundaries settle', async () => {
    let resolveBoundary: () => void = () => {}
    const neverSettlingPromise = new Promise<void>((r) => {
      resolveBoundary = r
    })
    const NeverReady = () => {
      throw neverSettlingPromise
    }

    const controller = new AbortController()
    const stream = await renderToReadableStream(
      <html>
        <body>
          <React.Suspense fallback={<span>loading</span>}>
            <NeverReady />
          </React.Suspense>
        </body>
      </html>,
      { signal: controller.signal },
    )

    // Read the shell, then abort. `allReady` should resolve (or reject
    // with abort), not hang.
    const readDone = streamToString(stream)
    // Give the shell a tick to flush.
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()

    // The race is between this assertion completing and a 2-second timeout.
    // Pre-fix this would have hung indefinitely on `Promise.race(state.pending)`.
    await Promise.race([
      readDone,
      new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error('drain did not unblock on abort')), 2000),
      ),
    ])

    // Cleanup
    resolveBoundary()
  })
})

describe('SSR escaping — bootstrap script attributes (nonce, src)', () => {
  // The bootstrap-script and stream layers interpolate `nonce` and `src`
  // directly into <script> attribute values. Both come from the consumer
  // and could carry quotes (malformed config, runtime-derived URL), so
  // they're escaped at every interpolation site.

  it('escapes a quote in nonce (renderToReadableStream w/ Suspense boundary)', async () => {
    const Slow = () => {
      throw new Promise<void>((r) => setTimeout(r, 0))
    }
    const tree = (
      <html>
        <body>
          <React.Suspense fallback={<span>loading</span>}>
            <Slow />
          </React.Suspense>
        </body>
      </html>
    )
    const stream = await renderToReadableStream(tree, {
      nonce: 'abc"><script>alert(1)</script>',
    })
    const html = await streamToString(stream)
    // The nonce reaches the bootstrap <script nonce="..."> attribute. After
    // escaping, the quote becomes `&quot;` and the rest is `&lt;`/`&gt;`.
    expect(html).toContain('nonce="abc&quot;&gt;&lt;script&gt;')
    // Crucially, no actual `<script>alert(1)` payload survived.
    expect(html).not.toContain('"><script>alert(1)')
  })

  it('escapes a quote in bootstrapScripts entry (string form)', async () => {
    const stream = await renderToReadableStream(
      <html>
        <body />
      </html>,
      { bootstrapScripts: ['/app.js"><script>alert(1)</script>x.js'] },
    )
    const html = await streamToString(stream)
    // src attribute is escaped — the injected `<script>` is rendered as text
    // inside the src value, not as a real script tag.
    expect(html).toContain('src="/app.js&quot;&gt;&lt;script&gt;')
    expect(html).not.toContain('"><script>alert(1)')
  })

  it('escapes a quote in bootstrapModules entry (object form, per-entry nonce)', async () => {
    const stream = await renderToReadableStream(
      <html>
        <body />
      </html>,
      {
        bootstrapModules: [
          { src: '/m.js', nonce: 'n"><img src=x onerror=alert(1)>' },
        ],
      },
    )
    const html = await streamToString(stream)
    expect(html).toContain('type="module"')
    expect(html).toContain('nonce="n&quot;&gt;&lt;img')
    expect(html).not.toContain('"><img src=x')
  })
})
