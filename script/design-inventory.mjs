/**
 * What the app actually looks like, counted.
 *
 * A design system derived from principles describes an app nobody built. This
 * reads every component stylesheet, pulls out the rules that draw a control,
 * a surface or a row, and groups them by what they actually set — so the
 * question "what IS a button here" is answered by the shipped code rather
 * than by whoever writes the primitive.
 *
 * Where one treatment dominates, that is the system and the primitive should
 * be rewritten to match it. Where several are evenly used, that is a real
 * choice for a person to settle, and it is flagged rather than guessed.
 *
 *   node script/design-inventory.mjs            the summary
 *   node script/design-inventory.mjs <category> everything in one category
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPONENTS = path.join(root, 'packages/ui/src/components')

/** Every rule in a stylesheet, as selector plus the declarations it sets. */
const rulesOf = (css, file) => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  const rule = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = rule.exec(clean)) !== null) {
    const selector = match[1].split(/[;}]/).pop().trim()
    if (!selector || selector.startsWith('@') || selector.startsWith('from') || selector.startsWith('to')) {
      continue
    }
    const decl = {}
    for (const hit of match[2].matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) {
      decl[hit[1]] = hit[2].trim().replace(/\s+/g, ' ')
    }
    if (Object.keys(decl).length > 0) out.push({ file, selector, decl })
  }
  return out
}

const all = []
for (const name of fs.readdirSync(COMPONENTS).filter((n) => n.endsWith('.module.css'))) {
  all.push(...rulesOf(fs.readFileSync(path.join(COMPONENTS, name), 'utf8'), name))
}

/**
 * What kind of thing a rule draws.
 *
 * Named after what a reader would call it, not after the class — class names
 * are the drift being measured, so they cannot be the classifier. The shape
 * of the declaration block is the evidence.
 */
const classify = ({ selector, decl }) => {
  const has = (key) => key in decl
  const name = selector.toLowerCase()

  if (has('position') && /fixed|absolute/.test(decl.position) && has('inset') && has('z-index')) {
    return 'overlay'
  }
  if (/dialog|modal|sheet|panel$/.test(name) && has('box-shadow') && has('border-radius')) return 'surface'
  if (/menu|popover|dropdown/.test(name) && (has('box-shadow') || has('border-radius'))) return 'surface'
  // A control is something a pointer acts on that has been given a shape.
  if (decl.cursor === 'pointer' && (has('border-radius') || has('height') || has('padding'))) {
    return /chip|pill|tag|badge/.test(name) ? 'chip' : 'control'
  }
  if (/^\.?(input|textarea|field|search)/.test(name) || (has('border') && has('background') && /input/.test(name))) {
    return 'input'
  }
  if (/badge|pill|tag|count|exit/.test(name) && has('border-radius') && has('font-size')) return 'chip'
  if (/^\.row|item$|entry$/.test(name) && (has('display') || has('padding'))) return 'row'
  return null
}

const buckets = new Map()
for (const rule of all) {
  const kind = classify(rule)
  if (!kind) continue
  if (!buckets.has(kind)) buckets.set(kind, [])
  buckets.get(kind).push(rule)
}

/** Count the distinct values of one property inside a bucket. */
const tally = (rules, property) => {
  const counts = new Map()
  for (const rule of rules) {
    const value = rule.decl[property]
    if (!value) continue
    if (!counts.has(value)) counts.set(value, [])
    counts.get(value).push(rule.file.replace('.module.css', ''))
  }
  return [...counts.entries()].sort((a, b) => b[1].length - a[1].length)
}

const show = (title, rows, limit = 8) => {
  console.log(`  ${title}`)
  if (rows.length === 0) {
    console.log('    (none)')
    return
  }
  for (const [value, where] of rows.slice(0, limit)) {
    const places = [...new Set(where)]
    const shown = places.slice(0, 4).join(', ')
    console.log(
      `    ${String(where.length).padStart(3)}x  ${value.padEnd(34)} ${shown}${places.length > 4 ? `, +${places.length - 4}` : ''}`,
    )
  }
  if (rows.length > limit) console.log(`         … ${rows.length - limit} more values`)
  console.log('')
}

const only = process.argv[2]
const PROPERTIES = {
  control: ['height', 'border-radius', 'padding', 'font-size', 'font-weight', 'background', 'border'],
  chip: ['height', 'border-radius', 'padding', 'font-size', 'background'],
  input: ['height', 'border-radius', 'padding', 'border', 'background'],
  surface: ['border-radius', 'box-shadow', 'background', 'padding'],
  overlay: ['background', 'z-index', 'align-items', 'padding'],
  row: ['min-height', 'height', 'padding', 'gap', 'border-radius'],
}

console.log('What the app actually looks like\n')
for (const [kind, properties] of Object.entries(PROPERTIES)) {
  const rules = buckets.get(kind) ?? []
  if (only && only !== kind) continue
  console.log(`${kind.toUpperCase()} — ${rules.length} rules across ${new Set(rules.map((r) => r.file)).size} files`)
  console.log('')
  for (const property of properties) show(property, tally(rules, property), only ? 20 : 5)
}

if (!only) {
  console.log('Run with a category name for the full list:', Object.keys(PROPERTIES).join(', '))
}
