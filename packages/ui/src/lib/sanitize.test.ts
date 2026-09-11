import { describe, expect, test } from 'vitest'

import { sanitizeHtml } from './sanitize'

/**
 * Agent output is untrusted. A model can be told to emit HTML, and tool results
 * carry whatever a shell command or MCP server returned — a web page, a log, a
 * file. These are the cases that must not reach the document intact.
 */

describe('sanitizeHtml', () => {
  test('keeps ordinary formatting', () => {
    const html = sanitizeHtml('<p>Hello <strong>world</strong> and <em>friends</em></p>')
    expect(html).toBe('<p>Hello <strong>world</strong> and <em>friends</em></p>')
  })

  test('removes script elements entirely, source included', () => {
    const html = sanitizeHtml('<p>before</p><script>alert(1)</script><p>after</p>')
    expect(html).not.toContain('script')
    expect(html).not.toContain('alert')
    expect(html).toContain('before')
    expect(html).toContain('after')
  })

  test('removes style, iframe, object, and noscript with their contents', () => {
    for (const tag of ['style', 'iframe', 'object', 'noscript']) {
      const html = sanitizeHtml(`<${tag}>payload</${tag}><p>kept</p>`)
      expect(html, tag).not.toContain('payload')
      expect(html, tag).toContain('kept')
    }
  })

  test('void embeds are removed; their sibling text was never inside them', () => {
    // `<embed>x</embed>` parses as an element followed by the text `x`, so only
    // the element is dangerous and only the element is dropped.
    const html = sanitizeHtml('<embed src="evil.swf">text<p>kept</p>')
    expect(html).not.toContain('embed')
    expect(html).not.toContain('evil.swf')
    expect(html).toContain('kept')
  })

  test('an unknown wrapper cannot smuggle its children past the walk', () => {
    // Regression: unwrapping hoisted children into a list the loop had already
    // passed, so their attributes were never inspected.
    const html = sanitizeHtml('<div><div><p onclick="steal()">deep</p></div></div>')
    expect(html).not.toContain('onclick')
    expect(html).toContain('deep')
  })

  test('pathological nesting does not exhaust the stack', () => {
    const deep = '<div>'.repeat(500) + 'text' + '</div>'.repeat(500)
    expect(() => sanitizeHtml(deep)).not.toThrow()
    expect(sanitizeHtml(deep)).toContain('text')
  })

  test('keeps only the text of what lies past the depth cap, a script or a style included (#179)', () => {
    // Past the cap an element is replaced by its text: a deep script's source shows, inert, and runs nowhere.
    const deep = `${'<div>'.repeat(120)}<script>alert(1)</script><style>body{color:red}</style>${'</div>'.repeat(120)}`
    const html = sanitizeHtml(deep)
    expect(html).not.toMatch(/<script|<style/i)
    expect(html).toContain('alert(1)')
    expect(html).toContain('body{color:red}')
  })

  test('strips every event handler attribute', () => {
    const html = sanitizeHtml(
      '<p onclick="steal()" onmouseover="steal()" onerror="steal()">text</p>',
    )
    expect(html).toBe('<p>text</p>')
  })

  test('drops javascript: and data: URLs but keeps real links', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript')
    expect(sanitizeHtml('<a href="data:text/html,<script>">x</a>')).not.toContain('data:')
    expect(sanitizeHtml('<a href="https://example.com">x</a>')).toContain('https://example.com')
    expect(sanitizeHtml('<a href="#section">x</a>')).toContain('#section')
  })

  test('a javascript: URL hidden behind whitespace or case is still dropped', () => {
    expect(sanitizeHtml('<a href="  JaVaScRiPt:alert(1)">x</a>')).not.toContain('alert')
    expect(sanitizeHtml('<a href="\tjavascript:alert(1)">x</a>')).not.toContain('alert')
  })

  test('img src is filtered the same way as href', () => {
    expect(sanitizeHtml('<img src="javascript:alert(1)">')).not.toContain('javascript')
    expect(sanitizeHtml('<img src="https://example.com/a.png" alt="a">')).toContain('a.png')
  })

  test('links are forced to open outside the app without window.opener', () => {
    const html = sanitizeHtml('<a href="https://example.com">x</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  test('unknown elements are unwrapped so their text survives', () => {
    const html = sanitizeHtml('<marquee>important text</marquee>')
    expect(html).not.toContain('marquee')
    expect(html).toContain('important text')
  })

  test('dangerous inline styles are removed but token colours are kept', () => {
    expect(sanitizeHtml('<span style="color:#ff0000">t</span>')).toContain('color:#ff0000')
    expect(sanitizeHtml('<span style="background:url(javascript:alert(1))">t</span>')).not.toContain(
      'javascript',
    )
    expect(sanitizeHtml('<span style="width:expression(alert(1))">t</span>')).not.toContain(
      'expression',
    )
  })

  test('nesting does not smuggle anything past the walk', () => {
    const html = sanitizeHtml(
      '<div><section><p onclick="x()">deep</p><script>bad()</script></section></div>',
    )
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('bad()')
    expect(html).toContain('deep')
  })

  test('malformed markup does not throw', () => {
    expect(() => sanitizeHtml('<p>unclosed <strong>bold')).not.toThrow()
    expect(() => sanitizeHtml('<<>><')).not.toThrow()
  })

  test('tables and code blocks survive intact', () => {
    const html = sanitizeHtml(
      '<table><thead><tr><th align="left">a</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>',
    )
    expect(html).toContain('<table>')
    expect(html).toContain('align="left"')
    expect(sanitizeHtml('<pre><code class="language-ts">x</code></pre>')).toContain(
      'class="language-ts"',
    )
  })

  test('markup nested past the depth cap keeps its text and none of its elements', () => {
    // #38: past the cap the children were hoisted unsanitised, so an event handler below depth 100 survived.
    const deep = `${'<div>'.repeat(120)}<img src="x" onerror="alert(1)"><a href="javascript:alert(2)">link</a>text${'</div>'.repeat(120)}`
    const out = sanitizeHtml(deep)
    expect(out).not.toContain('<img')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('linktext')
  })
})
