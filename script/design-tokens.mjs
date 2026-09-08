/**
 * Resolve every design token to the value a browser would compute.
 *
 * The token layer is a chain — a component asks for `--hd-destructive`, which
 * is `--hd-danger`, which is `--hdp-static-red-500`, which is finally a
 * colour. Reading any one file tells you nothing about what lands on screen.
 * This walks the whole chain the way the cascade does, so a change can be
 * compared against what the interface looked like before it.
 *
 * Used two ways: `script/check-design-tokens.mjs` holds it against a snapshot
 * so a refactor of the token files cannot move a value by accident, and the
 * design explorer reads it to show what each token actually resolves to.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The files that define tokens, in cascade order — later wins. */
export const TOKEN_SOURCES = [
  'packages/ui/src/styles/base.css',
  'packages/ui/src/styles/design-platform.css',
  'packages/ui/src/design/tokens.css',
  // The code-face tokens are declared at default scope and are the app's own
  // vocabulary, so they belong under the same guard as everything else.
  // editorial.css is deliberately absent: it only ever declares under
  // `body[data-hd-palette=…]`, which is a foundation varying the snapshot
  // rather than the snapshot itself.
  'packages/ui/src/styles/editor.css',
  // The scrollbar skin declares its own layout width on `body`, and a surface
  // that has to line up beside a space-consuming bar reads it — the transcript
  // and the room's chat both reserve that gutter, and their composers add it
  // back. Left out, those reads resolved to nothing here while resolving fine
  // in the browser, so the audit reported drift the app did not have and the
  // interface check compared against `calc(24px + )`.
  'packages/ui/src/styles/scrollbar.css',
  'packages/ui/src/styles/app.css',
]

/**
 * Custom-property declarations, per selector, in source order.
 *
 * Only the rules that carry tokens matter — `body`, `:root`, and the dark
 * theme's `body[data-hd-dark-theme]`. A declaration inside a media query or a
 * component rule is not part of the contract and is skipped: the tokens are
 * meant to be one flat set a component can rely on.
 */
const declarationsOf = (css) => {
  const found = []
  const clean = css
    // A token name inside prose is not a declaration.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Statement at-rules carry no braces, so they would otherwise be swallowed
    // into the selector of the first real rule and hide its declarations.
    .replace(/@(?:import|charset|namespace)[^;]*;/g, '')
  const rule = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = rule.exec(clean)) !== null) {
    // Whatever preceded this rule's brace may include the tail of the previous
    // block; the selector is only what follows the last one.
    const selector = match[1].split(/[;}]/).pop().trim().split(/\s*,\s*/)
    const body = match[2]
    const decl = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g
    let hit
    while ((hit = decl.exec(body)) !== null) {
      found.push({ selector, name: hit[1], value: hit[2].trim().replace(/\s+/g, ' ') })
    }
  }
  return found
}

/**
 * Does this rule apply to the face being resolved?
 *
 * A "face" is a theme and an interface together — light/dark crossed with
 * Desk/Studio — because both are token overrides layered on the same base and
 * neither is meaningful without the other. Studio's dark values, in
 * particular, exist only at the intersection: two of them are colour-mixed
 * against the ground, so they are wrong under either axis alone.
 *
 * Anything that is not one of these four selectors is ignored, which is how a
 * palette overlay (`body[data-hd-palette=…]`) stays out of the snapshot — it
 * varies the snapshot rather than being it.
 */
const applies = (selector, { dark, studio }) =>
  selector.some((one) => {
    const trimmed = one.trim()
    if (trimmed === ':root' || trimmed === 'html' || trimmed === 'body') return true
    if (trimmed === 'body[data-hd-dark-theme]' || trimmed === '[data-hd-dark-theme]') return dark
    if (trimmed === "body[data-hd-interface='studio']") return studio
    if (trimmed === "body[data-hd-interface='studio'][data-hd-dark-theme]") return studio && dark
    return false
  })

/**
 * Follow `var()` to a literal, the way the cascade does.
 *
 * A fallback (`var(--maybe, something)`) is honoured, which matters: several
 * declarations in this app lean on one, and one of them is load-bearing.
 * A reference with no definition and no fallback resolves to nothing — which
 * is a bug worth surfacing rather than papering over, so it comes back as the
 * sentinel `<undefined>`.
 */
const resolve = (value, table, seen = new Set()) => {
  if (!value.includes('var(')) return value
  let out = ''
  let index = 0
  while (index < value.length) {
    const start = value.indexOf('var(', index)
    if (start === -1) {
      out += value.slice(index)
      break
    }
    out += value.slice(index, start)
    // Find this var()'s matching paren; the fallback may itself be a var().
    let depth = 0
    let end = start + 3
    for (; end < value.length; end += 1) {
      if (value[end] === '(') depth += 1
      else if (value[end] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const inner = value.slice(start + 4, end)
    const comma = splitTopLevel(inner)
    const name = comma[0].trim()
    const fallback = comma.slice(1).join(',').trim()
    if (seen.has(name)) {
      out += '<cycle>'
    } else if (table.has(name)) {
      out += resolve(table.get(name), table, new Set([...seen, name]))
    } else if (fallback) {
      out += resolve(fallback, table, seen)
    } else {
      out += '<undefined>'
    }
    index = end + 1
  }
  return out.trim().replace(/\s+/g, ' ')
}

/** Split on commas that are not inside parentheses. */
const splitTopLevel = (text) => {
  const parts = []
  let depth = 0
  let current = ''
  for (const character of text) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  return parts
}

/**
 * Every token and what it resolves to, for one theme.
 *
 * @param {{root?: string, dark?: boolean, studio?: boolean}} options
 * @returns {Map<string, string>} token name -> computed value, sorted by name.
 */
export const resolveTokens = ({ root = process.cwd(), dark = false, studio = false } = {}) => {
  const table = new Map()
  for (const file of TOKEN_SOURCES) {
    const full = path.join(root, file)
    if (!fs.existsSync(full)) continue
    for (const entry of declarationsOf(fs.readFileSync(full, 'utf8'))) {
      if (applies(entry.selector, { dark, studio })) table.set(entry.name, entry.value)
    }
  }
  const resolved = new Map()
  for (const name of [...table.keys()].sort()) {
    resolved.set(name, resolve(table.get(name), table))
  }
  return resolved
}

/**
 * The snapshot form: one `name = value` line per token, for all four faces.
 *
 * Four, not two, since the Interface setting arrived. Half the token layer's
 * visible surface now lives in the Studio block, and a gate that only reads
 * `body` and the dark theme would let a whole interface drift without saying
 * anything — which is the exact failure this file exists to prevent.
 */
export const FACES = [
  ['light', { dark: false, studio: false }],
  ['dark', { dark: true, studio: false }],
  ['light-studio', { dark: false, studio: true }],
  ['dark-studio', { dark: true, studio: true }],
]

export const snapshot = (root = process.cwd()) => {
  const lines = []
  for (const [label, face] of FACES) {
    lines.push(`# ${label}`)
    for (const [name, value] of resolveTokens({ root, ...face })) lines.push(`${name} = ${value}`)
    lines.push('')
  }
  return lines.join('\n')
}
