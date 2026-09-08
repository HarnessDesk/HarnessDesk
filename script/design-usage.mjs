/**
 * The usage table, read as data by both of its consumers.
 *
 * `design/usage.ts` answers the question the token and primitive layers do
 * not: which of these do I reach for here, and why. It is TypeScript because
 * that is where the app can see it — `Slot` is a real type, so a screen that
 * invents a slot name fails to compile. But two build scripts need to read the
 * same table, and neither of them runs TypeScript.
 *
 * So it is evaluated rather than pattern-matched. The first version of this
 * pulled the fields out with a regular expression, which was fine until the
 * prose acquired an apostrophe: to a regex, `'the page\'s own ground'` ends at
 * the backslash. Half a sentence would reach the generated documentation and
 * nothing would fail, because `--check` only asks whether the committed file
 * matches what the generator produces, and a generator that truncates produces
 * a matching truncated file. Letting a JavaScript engine read the literals
 * cannot make that mistake.
 *
 * What gets stripped is only what makes the file TypeScript rather than
 * JavaScript: the `export type` declarations, and the annotation between a
 * name and its `=`. Both are found by matching brackets rather than by
 * guessing at line ends, because the `SLOTS` annotation is an object type
 * spanning six lines. Neither region may contain a string — which is true of
 * a type annotation, and is the reason this is allowed to be simple.
 *
 * The check that enforces the table lives here too, rather than in the audit
 * with the other checks. A rule and the reading of it drift the moment they
 * are apart: the audit already carried its own copy of the allow-lists once,
 * and the version before this one was one file away from carrying its own
 * idea of what a slot is. The audit now asks this module a question and
 * prints the answer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(root, 'packages/ui/src/design/usage.ts')

/**
 * The index of the bracket closing the one at `open`.
 *
 * Used twice below: to skip a type annotation, and to take the region a JSX
 * prop's braces enclose. Nothing here understands strings, so both callers
 * have to know their region contains none at the level they are matching — a
 * type annotation never does, and the attribute walk steps over quotes before
 * it asks.
 */
export const closes = (source, open) => {
  const pairs = { '{': '}', '[': ']', '(': ')' }
  const wanted = []
  for (let k = open; k < source.length; k += 1) {
    const here = source[k]

    // Quoted text is not structure. `title="Smile :)"` closed the enclosing
    // brace on the `)` inside the string, truncating the prop before its
    // `variant=` — which the gate then reported as an unqualified button in a
    // header, a false positive on a line that was correct.
    if (here === '"' || here === "'" || here === '`') {
      let close = source.indexOf(here, k + 1)
      while (close > 0 && source[close - 1] === '\\') close = source.indexOf(here, close + 1)
      if (close < 0) return source.length - 1
      k = close
      continue
    }

    // A stack, not a counter. Counting alone let `{` be closed by `]`: the
    // pairs map was built and its values never read, so every closer
    // decremented one shared depth.
    const closer = pairs[here]
    if (closer) {
      wanted.push(closer)
      continue
    }
    if (here === '}' || here === ']' || here === ')') {
      if (wanted[wanted.length - 1] !== here) return source.length - 1
      wanted.pop()
      if (wanted.length === 0) return k
    }
  }
  return source.length - 1
}

/** The `=` that begins a declaration's value, skipping over its annotation. */
const assignment = (source, from) => {
  for (let k = from; k < source.length; k += 1) {
    const char = source[k]
    if (char === '{' || char === '[' || char === '(') k = closes(source, k)
    else if (char === '=') return k
  }
  return -1
}

/** The same file with its type annotations removed, and nothing else changed. */
export const stripTypes = (source) => {
  let out = ''
  let index = 0
  for (;;) {
    const at = source.indexOf('export ', index)
    if (at < 0) return out + source.slice(index)
    out += source.slice(index, at)
    const rest = source.slice(at)

    const declared = /^export type \w+\s*=\s*/.exec(rest)
    if (declared) {
      const value = at + declared[0].length
      const line = source.indexOf('\n', value)
      index = source[value] === '{' ? closes(source, value) + 1 : line < 0 ? source.length : line
      continue
    }

    const named = /^export const (\w+)/.exec(rest)
    if (named) {
      out += `const ${named[1]} `
      index = assignment(source, at + named[0].length)
      continue
    }

    out += 'export '
    index = at + 'export '.length
  }
}

const read = () => {
  const js = stripTypes(fs.readFileSync(FILE, 'utf8'))
  return vm.runInNewContext(`${js}\n;({ BUTTONS, ELEMENTS, SLOTS })`)
}

export const { BUTTONS, ELEMENTS, SLOTS } = read()

/** `slot` → what it accepts. */
const SLOT_RULES = new Map(
  SLOTS.map((rule) => [rule.slot, { allow: new Set(rule.allow), size: rule.size, oneInk: rule.oneInk === true }]),
)

/** The variants that paint the ink, under either spelling. */
const INK = new Set(['default', 'primary'])

/**
 * One JSX element's own attributes, as written: name → value including its
 * delimiters.
 *
 * "Its own" is the whole difficulty, and both mistakes this replaces came from
 * skipping it. Matching `<Btn\b([^>]*)>` stops at the first `>` in the tag,
 * which is the one inside `onClick={() => …}` — so a variant written after a
 * handler was not found and the button was counted as unqualified. And
 * searching forward for a prop name reads it off whichever element happens to
 * carry it next when this one has none.
 *
 * Depth-0 is the entire rule: an element's attributes are the ones outside its
 * nested expressions and quoted strings, and its closing `>` is outside them
 * too.
 */
export const attributes = (source, from) => {
  const out = new Map()
  let index = from
  while (index < source.length) {
    const char = source[index]
    if (char === '>') return out

    // A spread is one opaque group, and stepping into it reads the `>` of a
    // comparison as the end of the tag: `<Btn {...(n > 0 ? a : b)}
    // variant="outline">` lost its variant entirely and was counted as
    // unqualified.
    if (char === '{') {
      index = closes(source, index) + 1
      continue
    }

    // The valued form first, and tolerant of spaces around the `=`. Matching
    // the bare form first read `variant = "outline"` as a valueless `variant`
    // and threw the value away.
    const attr = /^([A-Za-z_$][\w$]*)\s*=\s*(["'{])/.exec(source.slice(index))
    if (attr) {
      const open = index + attr[0].length - 1
      const close = attr[2] === '{' ? closes(source, open) : source.indexOf(attr[2], open + 1)
      const stop = close < 0 ? source.length - 1 : close
      out.set(attr[1], source.slice(open, stop + 1))
      index = stop + 1
      continue
    }

    const bare = /^([A-Za-z_$][\w$]*)(?=[\s/>])/.exec(source.slice(index))
    if (bare) {
      // A valueless prop is `small`, and missing it is not a near miss: the
      // whole question a slot asks about size is written this way. Its value
      // is the empty string rather than `true`, because every reader here
      // does string work on it — `written.startsWith(…)` on a boolean threw,
      // and the audit died rather than reporting anything at all.
      out.set(bare[1], '')
      index += bare[0].length
      continue
    }

    if (char === '"' || char === "'") {
      const close = source.indexOf(char, index + 1)
      index = close < 0 ? source.length : close + 1
      continue
    }
    index += 1
  }
  return out
}

/** The index of `char` at bracket depth zero, outside any quoted text. */
const topLevel = (source, char) => {
  let depth = 0
  for (let k = 0; k < source.length; k += 1) {
    const here = source[k]
    if (here === '"' || here === "'" || here === '`') {
      const close = source.indexOf(here, k + 1)
      k = close < 0 ? source.length : close
      continue
    }
    if (here === '{' || here === '[' || here === '(') depth += 1
    else if (here === '}' || here === ']' || here === ')') depth -= 1
    else if (here === char && depth === 0) return k
  }
  return -1
}

/**
 * Every variant an expression can paint, or `null` for "cannot tell".
 *
 * The distinction is the whole of it. A conditional paints one of its
 * branches, so every branch has to be legal — but only if every branch can be
 * *read*. Taking the quoted words after the `?` reads a fully literal ternary
 * correctly and a mixed one catastrophically: `variant={ok ? 'outline' :
 * other}` yielded `['outline']`, so the slot reported clean while `other` was
 * free to resolve to `ghost`. Both positions were blind, which made it a
 * bypass rather than a gap — and a silent one, since a slot with nothing to
 * report and a slot that could not be read printed the same nothing.
 *
 * So an unreadable branch poisons the whole expression and the button is not
 * judged at all. Nesting is read rather than flattened: `a ? 'x' : b ? 'y' :
 * 'z'` is `a ? 'x' : (b ? 'y' : 'z')`, so the split is on the FIRST top-level
 * colon and the remainder is read again.
 */
const readVariants = (raw) => {
  // A formatter parenthesises freely — `{(c ? 'a' : 'b')}` and `{c ? ('a') :
  // ('b')}` are both ordinary output — and a wrapper hid the `?` at depth 1,
  // so a perfectly readable conditional was reported as unreadable.
  let expr = raw.trim()
  while (expr.startsWith('(') && closes(expr, 0) === expr.length - 1) expr = expr.slice(1, -1).trim()

  const question = topLevel(expr, '?')
  if (question < 0) {
    const literal = /^\s*(['"])([a-z]+)\1\s*$/.exec(expr)
    return literal ? [literal[2]] : null
  }
  const rest = expr.slice(question + 1)
  const colon = topLevel(rest, ':')
  if (colon < 0) return null
  const left = readVariants(rest.slice(0, colon))
  const right = readVariants(rest.slice(colon + 1))
  return left === null || right === null ? null : [...left, ...right]
}

/**
 * The rung a button stands on, or `null` where that cannot be read.
 *
 * Kit writes `small`; the shadcn spelling writes `size="sm"`, and may write it
 * in either quote. An expression is unknown rather than full — calling
 * `size={dense ? 'sm' : 'default'}` full would charge a section head for a
 * button that may well be right.
 */
const rungOf = (attrs) => {
  if (attrs.has('small')) return 'sm'
  const asked = attrs.get('size')
  if (asked === undefined) return 'full'
  if (asked.startsWith('{')) return null
  return asked.slice(1, -1) === 'sm' ? 'sm' : 'full'
}

/**
 * Every `<Btn>`/`<Button>` in a region, with the variants it can paint.
 *
 * An unqualified button is not "no opinion": it paints, and the two spellings
 * paint it differently, which is the whole reason for the rule.
 */
export const buttonsIn = (region) =>
  [...region.matchAll(/<(Btn|Button)\b/g)].flatMap((hit) => {
    const tag = hit[1]
    const attrs = attributes(region, hit.index + hit[0].length)
    const size = rungOf(attrs)
    const written = attrs.get('variant')

    if (written === undefined) return [{ tag, variant: tag === 'Btn' ? 'secondary' : 'default', size }]
    if (written === '') return [{ tag, variant: null, size }]
    if (written.startsWith('"') || written.startsWith("'")) return [{ tag, variant: written.slice(1, -1), size }]
    const variants = readVariants(written.slice(1, -1))
    // `null` is a variant this cannot read, and it is reported rather than
    // dropped: a slot that cannot be checked and a slot with nothing to
    // report used to print the same nothing, which is what made the
    // mixed-branch hole silent as well as wrong.
    return variants === null ? [{ tag, variant: null, size }] : variants.map((variant) => ({ tag, variant, size }))
  })

/**
 * Where each slot is written, so the scan can find it.
 *
 * A slot in `usage.ts` is a place in the interface; this is the JSX that puts
 * something there. The two are separate because the rule outlives the
 * component — rename `PageHead` and only this table moves.
 */
const SITES = [
  { slot: 'pageAction', tag: /^PageHead$/, props: ['actions'], where: "a page head's action" },
  { slot: 'sectionAction', tag: /^SectionHead$/, props: ['action'], where: "a section head's action" },
  { slot: 'dialogFooter', tag: /^Dialog$/, props: ['footer'], where: "a dialog's footer" },
]

/** The value of each named prop on one element, in the order written. */
const propValues = (source, from, names) =>
  [...attributes(source, from)].filter(([name]) => names.includes(name)).map(([, value]) => value)

export const slotOffenders = (source, name) => {
  const out = []
  for (const site of SITES) {
    const rule = SLOT_RULES.get(site.slot)
    if (!rule) continue
    for (const hit of source.matchAll(/<([A-Z]\w*)[\s>]/g)) {
      if (!site.tag.test(hit[1])) continue
      for (const region of propValues(source, hit.index + hit[0].length - 1, site.props)) {
        // A slot whose content is hoisted — `actions={headerAction}`,
        // `footer={renderFooter()}` — holds no JSX for this to read, so every
        // rule below passes it in silence. That is a bypass an ordinary
        // refactor opens by accident, so an opaque slot is reported rather
        // than skipped. A slot holding JSX that simply is not a button (a
        // chip, a count) is legible and stays quiet.
        const body = region.slice(1, -1).trim()
        if (body !== '' && !body.includes('<') && !/^(undefined|null)$/.test(body)) {
          out.push(`${name}: ${site.where} is held in \`${body}\`, which this cannot read`)
          continue
        }
        const found = buttonsIn(region)
        for (const { tag, variant, size } of found) {
          if (variant === null) {
            out.push(`${name}: <${tag}> in ${site.where} has a variant this cannot read`)
          } else if (!rule.allow.has(variant)) {
            out.push(`${name}: <${tag} variant="${variant}"> in ${site.where}`)
          }
          // A rung it cannot read is not a rung it can charge for.
          if (variant !== null && size !== null && size !== rule.size) {
            out.push(`${name}: <${tag}> is ${size} in ${site.where}, which is ${rule.size}`)
          }
        }
        // Counted only where the slot is unconditional, and that limit was
        // learned twice. A conditional means the buttons *written* are not the
        // buttons *shown*: first a ternary between two whole branches (the
        // library's apply dialog, reported as a defect on its first run), then
        // one nested inside a fragment, which is the ordinary way to write a
        // conditional label. Each fix invited the next shape. Working out
        // which branch renders is a JSX parser's job, not a regex's, and a
        // gate that fires on correct code is worse than no gate — so where
        // this cannot be sure, it says nothing rather than guessing.
        if (rule.oneInk && !region.includes('?')) {
          const ink = found.filter((one) => INK.has(one.variant)).length
          if (ink > 1) out.push(`${name}: ${ink} ink actions in ${site.where}, which holds one`)
        }
      }
    }
  }
  return out
}

