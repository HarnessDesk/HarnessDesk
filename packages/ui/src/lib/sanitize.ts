/**
 * HTML sanitisation for agent output.
 *
 * Agent transcripts are not trusted input. The text comes from a model, and tool
 * results come from whatever an MCP server or shell command returned — a web
 * page, a file, a build log. Any of those can contain markup, and a renderer
 * that trusts it hands script execution to whatever the agent happened to read.
 *
 * The policy is an allowlist rather than a blocklist: unknown tags are unwrapped
 * (keeping their text), unknown attributes are dropped, and URL-bearing
 * attributes must match a safe scheme. Losing formatting is acceptable; losing
 * content is not, and executing content is never.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'em', 'del', 's', 'code', 'pre', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img',
])

const ALLOWED_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
  // Shiki emits inline `style` for token colours and `class` for its wrapper.
  span: new Set(['style', 'class']),
  code: new Set(['class']),
  pre: new Set(['class', 'style']),
  th: new Set(['align']),
  td: new Set(['align']),
}

/**
 * Tags whose *contents* are dangerous, not just the element. Unwrapping a
 * `<script>` would paste its source into the document as visible text, so these
 * are removed whole.
 */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript'])

const SAFE_URL = /^(?:https?:|mailto:|file:|#|\/)/i

/** Blocks `expression()`, `url(javascript:…)`, and CSS-driven navigation. */
const UNSAFE_STYLE = /(?:expression|javascript:|@import|behavior\s*:|url\s*\()/i

/**
 * Depth cap. Deeply nested markup — accidental or adversarial — would otherwise
 * recurse until the stack gives out. Anything past this is unwrapped to text.
 */
const MAX_DEPTH = 100

export const sanitizeHtml = (html: string): string => {
  const template = document.createElement('template')
  template.innerHTML = html

  const walk = (node: ParentNode, depth: number): void => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase()

      if (DROP_WITH_CONTENT.has(tag)) {
        child.remove()
        continue
      }

      // Sanitise the subtree *before* deciding whether to unwrap this element.
      // Unwrapping hoists children into a list this loop has already passed, so
      // cleaning them afterwards would never happen — which is exactly how an
      // unknown wrapper could smuggle an event handler through.
      /* Past the depth cap nothing below is walked, so nothing below may stay
         an element. Hoisting its children kept them whole, attributes and
         all, in a list this loop had already passed: an `<img onerror>` at
         depth 101 went through (#38). Its text is all that is kept. */
      if (depth >= MAX_DEPTH) {
        child.replaceWith(document.createTextNode(child.textContent ?? ''))
        continue
      }
      walk(child, depth + 1)

      if (!ALLOWED_TAGS.has(tag)) {
        // Keep the text, drop the element.
        child.replaceWith(...child.childNodes)
        continue
      }

      const allowed = ALLOWED_ATTRIBUTES[tag] ?? new Set<string>()
      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase()
        if (!allowed.has(name)) {
          child.removeAttribute(attribute.name)
          continue
        }
        const value = attribute.value.trim()
        if ((name === 'href' || name === 'src') && !SAFE_URL.test(value)) {
          child.removeAttribute(attribute.name)
          continue
        }
        if (name === 'style' && UNSAFE_STYLE.test(value)) {
          child.removeAttribute(attribute.name)
        }
      }

      if (tag === 'a') {
        // Opening in the same view would navigate away from the app; `noopener`
        // keeps the destination from reaching back through `window.opener`.
        child.setAttribute('target', '_blank')
        child.setAttribute('rel', 'noopener noreferrer')
      }
    }
  }

  walk(template.content, 0)
  return template.innerHTML
}
