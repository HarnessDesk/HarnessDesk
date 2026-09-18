/**
 * Where the interface has stepped outside its own system.
 *
 * A design system that is only written down is a design system that gets
 * copied wrong, because the next screen is built by imitating the nearest
 * file rather than by reading a document. This counts the places where that
 * has already happened, so the drift is a number that can be driven to zero
 * instead of a feeling that things look a bit inconsistent.
 *
 * It reports by default. In strict mode every category must be zero; a saved
 * baseline is schema documentation, never permission to carry design debt.
 *
 *   node script/design-audit.mjs            report
 *   node script/design-audit.mjs --strict   fail on any finding
 *   node script/design-audit.mjs --baseline record zero only after a clean scan
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SECTIONS } from './design-sections.mjs'
import { resolveTokens } from './design-tokens.mjs'
import { attributes, slotOffenders } from './design-usage.mjs'
import { ownsStylesheet, resolveStylesheet, stylesheetImports } from './lib/stylesheet-imports.mjs'
import { withoutComments } from './lib/without-comments.mjs'
import { repositoryFiles } from './lib/repository-files.mjs'
import { overlayViolations } from './ui-architecture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPONENTS = path.join(root, 'packages/ui/src/components')
const BASELINE = path.join(root, 'packages/ui/src/design/audit-baseline.json')

/**
 * Categories that start above zero and are only allowed to fall.
 *
 * The rest of the audit is at zero and stays there, which is right for drift
 * that has already been paid off. It is the wrong shape for debt being worked
 * down: a category that starts at 126 cannot be gated on zero without either
 * failing every build or being left out of the gate entirely, and left out is
 * how 34 raw type sizes and 126 re-declared patterns accumulated unseen.
 *
 * So these carry a recorded ceiling instead. Going up fails. Going *down*
 * also fails, with the fix being `--baseline` — because a ratchet that is not
 * tightened is a ceiling nobody is under.
 *
 * `rawType` started here at 34 and is now zero, so it has left: a category
 * that has reached the floor is an ordinary category, and holding it at a
 * ceiling of nought would say the same thing in a more complicated way.
 */
const BURN_DOWN = new Set(['patternClass'])

/**
 * Everywhere UI is written, not just the screens.
 *
 * The design system's own files are audited too, and held to the same rules —
 * a primitive that writes a raw radius is worse than a screen that does,
 * because every screen inherits it. Excluding them would also make the counts
 * fall every time a component is promoted into `design/`, which would read as
 * a burn-down while nothing had been fixed.
 */
const UI_SRC = path.join(root, 'packages/ui/src')
const tracked = new Set(repositoryFiles(root).map((file) => path.join(root, file)))

/**
 * The foundation is not a screen, and must not be audited as one.
 *
 * `styles/` and `design/foundation/` are where tokens and theme presets are
 * declared — that is their entire job. Canonical components, patterns, the
 * catalog, and showcase are deliberately not excluded: moving a literal into
 * the design directory must never make a finding disappear.
 */
const NOT_UI = new Set([
  path.join(UI_SRC, 'styles'),
  path.join(UI_SRC, 'design', 'foundation'),
])

/**
 * Found, not listed.
 *
 * A hard-coded list of directories silently exempts the next one somebody
 * adds: `slots/` and `app/` were both invisible to this audit until it was
 * noticed by hand, which is the failure mode the audit exists to prevent. A
 * directory is UI if it holds a stylesheet or a component, so that is the
 * question asked — of every directory, every run.
 */
const uiDirs = (dir) => {
  const found = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  if (
    !NOT_UI.has(dir) &&
    entries.some(
      (e) =>
        e.isFile() &&
        tracked.has(path.join(dir, e.name)) &&
        (e.name.endsWith('.module.css') || (e.name.endsWith('.tsx') && !e.name.includes('.test.'))),
    )
  ) {
    found.push(dir)
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      found.push(...uiDirs(path.join(dir, entry.name)))
    }
  }
  return found
}

const DIRS = uiDirs(UI_SRC)

/** One source snapshot per audit, including absent optional imports. */
export const createSourceCache = (readFile = (file) => fs.readFileSync(file, 'utf8')) => {
  const sources = new Map()
  return (file) => {
    if (!sources.has(file)) {
      try { sources.set(file, readFile(file)) }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error
        sources.set(file, null)
      }
    }
    return sources.get(file)
  }
}
const sourceOf = createSourceCache()
const read = (file) => {
  const source = sourceOf(file)
  if (source === null) throw new Error(`Missing source file: ${file}`)
  return source
}
/** Where a finding is, said the way a person would look for it. */
const label = (file) => path.relative(path.join(root, 'packages/ui/src'), file)
const filesIn = (suffix, reject = () => false) =>
  DIRS.filter((dir) => fs.existsSync(dir)).flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(suffix) && !reject(name))
      .map((name) => path.join(dir, name)),
  ).filter((file) => tracked.has(file))
const cssFiles = () => filesIn('.css')
const tsxFiles = () => filesIn('.tsx', (name) => name.includes('.test.'))

/*
 * CSS's own preprocessing (Syntax §3.3): a CR, a form feed, or a CR LF pair is
 * one newline. Every scanner below reads the text after this, so a string
 * ends at any of the three the way it ends at a newline, and a backslash
 * before a CR LF is one line continuation, not a backslash and a stray LF.
 * Without it a CR-terminated string swallowed the declarations after it, and
 * an escaped CR LF ended a string early (#762 review). A NUL is U+FFFD.
 */
const preprocess = (text) => text.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '\ufffd')

/* Where an unquoted `url(` token's address ends, from `open`: past its `)`,
   where a backslash escapes whatever follows it — `url(a\).png)` is one
   address, and its first `)` closes nothing (#762 review). */
const unquotedUrlEnd = (text, open) => {
  let index = open
  while (index < text.length && text[index] !== ')') index += text[index] === '\\' ? 2 : 1
  return Math.min(index + 1, text.length)
}

/*
 * Where a CSS string that opens at `start` ends: past its closing quote, with
 * escapes skipped — or at an unescaped newline, which ends a string by the
 * grammar and keeps one stray quote from swallowing a whole stylesheet.
 */
const stringEnd = (text, start) => {
  const quote = text[start]
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') index += 2
    else if (char === quote) return index + 1
    else if (char === '\n') return index
    else index += 1
  }
  return text.length
}

/*
 * CSS escapes (Syntax §4.3.7), decoded the way the browser decodes them
 * before it reads a name: `r\65 d` is `red`, `c\6f lor` is `color`,
 * `u\72l(` opens a URL. The scanners here used to skip an escape for
 * structure and then classify the spelling it left behind — so every escaped
 * name slipped past, and an escaped `url(` was read as its payload (#762
 * review). A backslash before a newline is not an escape.
 */
const HEX_DIGIT = /[0-9A-Fa-f]/
const validEscape = (text, index) => text[index] === '\\' && index + 1 < text.length && text[index + 1] !== '\n'
const escapeAt = (text, index) => {
  let at = index + 1
  if (!HEX_DIGIT.test(text[at])) return { char: text[at], end: at + 1 }
  let hex = ''
  while (hex.length < 6 && HEX_DIGIT.test(text[at] ?? '')) hex += text[at++]
  if (/[ \t\n]/.test(text[at] ?? '')) at += 1 // one whitespace ends a hex escape
  const code = parseInt(hex, 16)
  const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
  return { char: String.fromCodePoint(valid ? code : 0xfffd), end: at }
}
const nameCode = (char) => char !== undefined && (/[A-Za-z0-9_-]/.test(char) || char.charCodeAt(0) >= 0x80)
const nameStart = (char) => char !== undefined && (/[A-Za-z_]/.test(char) || char.charCodeAt(0) >= 0x80)

/* Whether an identifier starts at `index` (Syntax §4.3.9). */
const identStartsAt = (text, index) => {
  if (text[index] === '-') {
    return nameStart(text[index + 1]) || text[index + 1] === '-' || validEscape(text, index + 1)
  }
  return nameStart(text[index]) || validEscape(text, index)
}

/* Whether a name at `index` starts a token of its own: after a name, a
   number or `#`/`@` it continues that token — `1var(` is a dimension and a
   bracket, `#var(` a hash, not a call. */
const startsToken = (text, index) => index === 0 || !(nameCode(text[index - 1]) || text[index - 1] === '#' || text[index - 1] === '@')

/* The name that starts at `index`, escapes decoded, and where it ends. */
const nameAt = (text, index) => {
  let name = ''
  let at = index
  while (at < text.length) {
    if (validEscape(text, at)) {
      const { char, end } = escapeAt(text, at)
      name += char
      at = end
    } else if (nameCode(text[at])) name += text[at++]
    else break
  }
  return { name, end: at }
}

/* Past the `)` that closes a parenthesis opened just before `index`, counting
   depth outside strings and escapes — or `-1` when nothing closes it before
   the end, which closes it. */
const closeAt = (text, index) => {
  let depth = 1
  let at = index
  while (at < text.length) {
    const char = text[at]
    if (char === '\\') at += 2
    else if (char === '"' || char === "'") at = stringEnd(text, at)
    else {
      if (char === '(') depth += 1
      else if (char === ')' && (depth -= 1) === 0) return at + 1
      at += 1
    }
  }
  return -1
}
const closeOf = (text, index) => {
  const close = closeAt(text, index)
  return close === -1 ? text.length : close
}

/* Past a `url(`…`)` whose `(` is just before `index`: a quoted URL is a
   function around a string, closed by depth; an unquoted one runs to its
   first unescaped `)`, the whole of it an address. */
const urlEnd = (text, index) => {
  let open = index
  while (/[ \t\n]/.test(text[open] ?? '')) open += 1
  return text[open] === '"' || text[open] === "'" ? closeOf(text, index) : unquotedUrlEnd(text, open)
}

/**
 * Strip comments so prose about a value is not counted as the value.
 *
 * Only real comments. This was one pattern over the raw text, so a `/*`
 * inside a string opened a "comment" that ran to the next `*\/` anywhere —
 * `content: "/*"; color: red; content: "*\/"` lost the `color` between them,
 * and a raw colour slipped past the audit (#762 review). So it scans: strings
 * are copied whole, a name is copied whole with its escapes (so `\/*` is a
 * name, not a comment), and an unquoted `url(...)` — however its name is
 * spelled — is copied through its `)`, because the grammar reads everything
 * there as the address. A comment still separates the tokens either side of
 * it, so it leaves a space: `@property/**\/--l` is `@property --l`, and
 * `syn/**\/tax` is two names, not `syntax` (#762 review). That also makes a
 * second pass find nothing new — `1//**\/*` stays `1/ *`, not a comment
 * opener.
 */
const bare = (raw) => {
  const css = preprocess(raw)
  let out = ''
  let index = 0
  while (index < css.length) {
    const char = css[index]
    if (char === '"' || char === "'") {
      const end = stringEnd(css, index)
      out += css.slice(index, end)
      index = end
    } else if (char === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2)
      index = close === -1 ? css.length : close + 2
      out += ' '
    } else if (identStartsAt(css, index)) {
      const { name, end } = nameAt(css, index)
      let next = end
      if (css[end] === '(' && name.toLowerCase() === 'url') {
        let open = end + 1
        while (/[ \t\n]/.test(css[open] ?? '')) open += 1
        next = css[open] === '"' || css[open] === "'" ? open : unquotedUrlEnd(css, open)
      }
      out += css.slice(index, next)
      index = next
    } else {
      const step = char === '\\' ? 2 : 1
      out += css.slice(index, index + step)
      index += step
    }
  }
  return out
}

/* Functions whose arguments are names an author chose — a counter, a counter
   style, a local font, a font feature — so `counter(red)` names a counter and
   `styleset(red)` a feature value; each checked in Chromium (#762 review). */
const NAME_FUNCTIONS = new Set([
  'counter', 'counters', 'local',
  'styleset', 'stylistic', 'swash', 'ornaments', 'annotation', 'character-variant',
])

/*
 * The tokens of a value that can name a colour — hashes, functions and
 * identifiers, each with its escapes decoded — with strings, numbers (units
 * included) and every `url(...)` set aside. A URL's payload is an image or a
 * reference, never a colour of this stylesheet's; its end is found by depth
 * outside strings, so `translate(1)` inside a quoted payload does not close
 * it (#762 review), and its name is read decoded, so `u\72l(red)` is a URL.
 */
const colourTokens = (raw) => {
  const text = preprocess(raw)
  const tokens = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'") {
      index = stringEnd(text, index)
    } else if (char === '#' && (nameCode(text[index + 1]) || validEscape(text, index + 1))) {
      const { name, end } = nameAt(text, index + 1)
      tokens.push({ type: 'hash', value: name })
      index = end
    } else if (
      /[0-9]/.test(char) ||
      ((char === '+' || char === '-' || char === '.') && /[0-9.]/.test(text[index + 1] ?? '') && /[0-9]/.test(text[index + 1] === '.' ? text[index + 2] ?? '' : text[index + 1]))
    ) {
      // a number, and any unit written on it: `10px`, `1.5em`, `1e3`, `50%`
      index += 1
      while (/[0-9.]/.test(text[index] ?? '')) index += 1
      if (/[eE]/.test(text[index] ?? '') && /[0-9]/.test(/[+-]/.test(text[index + 1] ?? '') ? text[index + 2] ?? '' : text[index + 1] ?? '')) {
        index += /[+-]/.test(text[index + 1]) ? 2 : 1
        while (/[0-9]/.test(text[index] ?? '')) index += 1
      }
      if (identStartsAt(text, index)) index = nameAt(text, index).end
      else if (text[index] === '%') index += 1
    } else if (identStartsAt(text, index)) {
      const { name, end } = nameAt(text, index)
      if (text[end] === '(') {
        const fn = name.toLowerCase()
        if (fn === 'url') index = urlEnd(text, end + 1)
        else if (NAME_FUNCTIONS.has(fn)) index = closeOf(text, end + 1)
        else if (fn === 'attr') {
          // `attr(name type?, fallback?)`: the attribute is a name, the fallback a value
          const close = closeOf(text, end + 1)
          const comma = topLevelComma(text.slice(end + 1, close - 1))
          index = comma === -1 ? close : end + 1 + comma + 1
        } else {
          tokens.push({ type: 'function', value: name })
          index = end + 1
        }
      } else {
        tokens.push({ type: 'ident', value: name })
        index = end
      }
    } else {
      index += char === '\\' ? 2 : 1
    }
  }
  return tokens
}

/**
 * Every declaration in a stylesheet, whatever its property.
 *
 * The colour and stacking rules used to match a list of property names, and a
 * list is the spellings someone remembered: `border: 1px solid #fff` walked
 * past a colour rule that named `border-color`, and `z-index: 10 !important`
 * past a stacking rule that wanted the number to be followed by `;`. Both
 * reported zero. So they read declarations instead, and ask of each value what
 * it is rather than of each property what it is called.
 *
 * Read by walking the text, not by a pattern: a `;` or a `}` ends a
 * declaration only outside a string, outside parentheses, and unescaped. A pattern took
 * the first one it met, so `content: "status: #fff; ready"` became the value
 * `"status: #fff` — a raw colour, on valid CSS — and an unquoted
 * `url(data:…;…)` would have split the same way (#762 review). A `{` outside a
 * string ends whatever came before it, which is a selector or an at-rule's
 * prelude — so `a:hover` never parses as a declaration. The last declaration
 * in a block needs no semicolon. Vendor prefixes and custom properties are
 * declarations like any other.
 */
export const declarationsOf = (css) =>
  declarationsIn(css)
    .declarations.filter(({ valid }) => valid)
    .map(({ property, value }) => ({ property, value }))

/* At-rules whose block, at the top of the sheet or inside another like them,
   holds rules rather than declarations. There a `;` ends only an at-rule
   statement; before a rule it is part of the rule's prelude, so `.b {}; .a
   { … }` gives the second rule the prelude `; .a`, which selects nothing, and
   the browser drops it (#762 review). */
const RULE_LISTS = new Set(['media', 'supports', 'container', 'layer', 'starting-style', 'document', 'keyframes', '-webkit-keyframes'])

/* Whether a string that opens at `start` closes: one cut short by a newline is
   a bad string, and the declaration it is in is dropped. The end of the sheet
   closes one. */
const stringCloses = (text, start) => {
  for (let index = start + 1; index < text.length; ) {
    const char = text[index]
    if (char === '\\') index += 2
    else if (char === text[start]) return true
    else if (char === '\n') return false
    else index += 1
  }
  return true
}

/* Whether an unquoted URL, from past `url(` and its whitespace to `end`, is a
   bad one — a quote, a `(`, a space before more of it, a backslash before a
   newline, or a character that does not print — which drops the declaration
   it is in. */
const badUrl = (text, open, end) => {
  const body = text.slice(open, text[end - 1] === ')' ? end - 1 : end)
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '\\' && body[index + 1] === '\n') return true // not an escape
    else if (char === '\\') index += 1
    else if (char === '"' || char === "'" || char === '(' || /[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(char)) return true
    else if (/[ \t\n]/.test(char) && body.slice(index).trim() !== '') return true
  }
  return false
}

/* Whether a value has a `!` outside every bracket, which a custom property's
   value may not (Syntax, `<declaration-value>`): `--l: 5 !foo` is dropped. */
const bangAtTop = (value) => {
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\\') index += 1
    else if (char === '"' || char === "'") index = stringEnd(value, index) - 1
    else if (value.startsWith('<!--', index)) index += 3 // a token of its own, not a `!`
    else if ('([{'.includes(char)) depth += 1
    else if (')]}'.includes(char)) depth = Math.max(0, depth - 1)
    else if (char === '!' && depth === 0) return true
  }
  return false
}

/* The same walk, with the rule each declaration sits in — its prelude (a
   selector, or an at-rule such as `@property --l`) with whitespace folded,
   and the chain of preludes from the top of the sheet down to it, which names
   the elements it applies to and the conditions it applies under — whether
   the browser keeps it, and the at-rule statements (`@namespace`, `@import`)
   the sheet makes.

   It matches brackets the way the tokenizer does: a `)`, `]` or `}` that
   closes nothing is a token of the value and drops the declaration — at the
   top of the sheet, of the next rule's prelude, which drops that rule — and
   inside a bracket nothing is structure: `--x: [}]` does not end the rule.
   `<!--` and `-->` at the top of the sheet are nothing.
   An unquoted `url()` is read to its `)` in one piece, as `bare` reads it, so
   a bad one (`url(a(b)`) ends where the browser's does. A `{}` block is part
   of a custom property's value (`--l: {5}`), and anywhere else opens a rule.
   A dropped declaration is still returned, marked, because the rules here
   read what the browser keeps (#762 review). */
const declarationsIn = (css) => {
  const text = bare(css)
  const declarations = []
  const statements = new Set()
  const root = { chain: '', prelude: '', parent: null, rules: true, layers: true, atRulesOnly: true, registers: null, universal: null }
  const open = [root]
  let buffer = ''
  let bad = false
  const closers = []
  const reset = () => {
    buffer = ''
    bad = false
    closers.length = 0
  }
  const flush = () => {
    const rule = open[open.length - 1]
    const declaration = rule.rules ? null : splitDeclaration(buffer)
    if (declaration) {
      const { property, value } = declaration
      const strict = property.startsWith('--') || property === 'initial-value'
      declarations.push({ ...declaration, valid: !bad && !(strict && bangAtTop(value)), rule })
    }
    reset()
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'") {
      // the same notion of a string as `bare` and `colourTokens` — one definition
      if (!stringCloses(text, index)) bad = true
      const end = stringEnd(text, index)
      buffer += text.slice(index, end)
      index = end
      continue
    }
    if (char === '\\') {
      // an escaped `;`, `}` or paren is a character of the value, not structure
      buffer += text.slice(index, index + 2)
      index += 2
      continue
    }
    if (open.length === 1 && (text.startsWith('<!--', index) || (text.startsWith('-->', index) && startsToken(text, index)))) {
      // `<!--` and `-->` at the top of a sheet are nothing
      index += text[index] === '<' ? 4 : 3
      continue
    }
    if (identStartsAt(text, index)) {
      const { name, end } = nameAt(text, index)
      let next = end
      if (text[end] === '(' && name.toLowerCase() === 'url') {
        let at = end + 1
        while (/[ \t\n]/.test(text[at] ?? '')) at += 1
        if (text[at] !== '"' && text[at] !== "'") {
          next = unquotedUrlEnd(text, at)
          if (badUrl(text, at, next)) bad = true
        }
      }
      buffer += text.slice(index, next)
      index = next
      continue
    }
    index += 1
    const rule = open[open.length - 1]
    if (char === '(' || char === '[' || (char === '{' && (closers.length > 0 || (!rule.rules && splitDeclaration(buffer)?.property.startsWith('--'))))) {
      closers.push(char === '(' ? ')' : char === '[' ? ']' : '}')
      buffer += char
      continue
    }
    if (char === ')' || char === ']' || (char === '}' && closers.length > 0)) {
      if (closers[closers.length - 1] === char) closers.pop()
      else bad = true
      buffer += char
      continue
    }
    if (char === '{') {
      const prelude = buffer.trim().replace(/[ \t\n]+/g, ' ')
      const atRule = atRuleOf(prelude)
      open.push({
        chain: `${rule.chain}\n${prelude}`,
        prelude,
        parent: rule,
        rules: rule.rules && RULE_LISTS.has(atRule),
        // at the top of the sheet or only inside `@layer`, which orders rules
        // without conditioning them — a block names one layer or none
        // (`@layer a, b { … }` is dropped, checked in Chromium)
        layers: rule.layers && atRule === 'layer' && oneLayer(prelude),
        atRulesOnly: rule.atRulesOnly && atRule !== null,
        // an `@property` rule is ignored inside a style rule (checked in Chromium)
        registers: rule.atRulesOnly ? registeredBy(prelude) : null,
        universal: rule.layers ? universalOf(prelude) : null,
      })
      reset()
      continue
    }
    if (char === ';' && closers.length > 0) {
      // inside a bracket a `;` is a token of the value
      buffer += char
      continue
    }
    if (char === ';') {
      if (!rule.rules) flush()
      else if (buffer.trim().startsWith('@')) {
        statements.add(atRuleOf(buffer.trim()))
        reset()
      } else buffer += char
      continue
    }
    if (char === '}' && open.length === 1) {
      // closing nothing at the top of the sheet, it joins the next prelude, and that rule is dropped
      buffer += char
      continue
    }
    if (char === '}') {
      flush()
      open.pop()
      continue
    }
    buffer += char
  }
  flush()
  return { declarations, statements }
}

/* Whether a `@layer` block's prelude names one layer, `ident('.'ident)*`, or
   none: `@layer a, b`, `@layer 1`, `@layer a.` and `@layer "a"` are dropped,
   and whatever is inside with them (checked in Chromium). */
const oneLayer = (prelude) => {
  const rest = prelude.slice(nameAt(prelude, 1).end).trim()
  for (let at = 0; rest !== ''; at += 1) {
    if (!identStartsAt(rest, at)) return false
    at = nameAt(rest, at).end
    if (at === rest.length) return true
    if (rest[at] !== '.') return false
  }
  return true
}

/* The name of the at-rule a prelude opens, decoded and lower-cased, or `null`. */
const atRuleOf = (prelude) =>
  prelude[0] === '@' && identStartsAt(prelude, 1) ? nameAt(prelude, 1).name.toLowerCase() : null

/* The custom property an `@property` prelude registers, decoded — `@PROPERTY
   --\6c` registers `--l` — or `null`. */
const registeredBy = (prelude) => {
  if (atRuleOf(prelude) !== 'property') return null
  const keyword = nameAt(prelude, 1)
  if (prelude[keyword.end] !== ' ') return null
  const at = keyword.end + 1
  if (!identStartsAt(prelude, at)) return null
  const { name, end } = nameAt(prelude, at)
  return name.startsWith('--') && end === prelude.length ? name : null
}

/* Whether an unconditional rule reaches the whole document: every selector in
   its list is `*`, `:root` or `html`, decoded and in any case. One selector
   the browser cannot read drops the whole rule, so a list with anything else
   in it — even `:root, .x` — is not taken to reach it. */
const universalOf = (prelude) => {
  let rest = prelude
  for (;;) {
    const comma = topLevelComma(rest)
    const selector = (comma === -1 ? rest : rest.slice(0, comma)).trim()
    const colon = selector[0] === ':' ? 1 : 0
    const named = identStartsAt(selector, colon) ? nameAt(selector, colon) : null
    const reaches =
      selector === '*' || (named?.end === selector.length && named.name.toLowerCase() === (colon ? 'root' : 'html'))
    if (!reaches) return null
    if (comma === -1) return 'root'
    rest = rest.slice(comma + 1)
  }
}

/* A value without its trailing `!important`, however that is spelled —
   `! IMPORTANT`, `!\69 mportant` — found as the last `!` outside a string,
   followed by nothing but a name that decodes to `important`. */
const withoutImportant = (raw) => {
  let bang = -1
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '\\') index += 1
    else if (char === '"' || char === "'") index = stringEnd(raw, index) - 1
    else if (char === '!') bang = index
  }
  if (bang === -1) return raw.trim()
  let at = bang + 1
  while (/[ \t\n]/.test(raw[at] ?? '')) at += 1
  if (!identStartsAt(raw, at)) return raw.trim()
  const { name, end } = nameAt(raw, at)
  return name.toLowerCase() === 'important' && raw.slice(end).trim() === '' ? raw.slice(0, bang).trim() : raw.trim()
}

/* `property: value`, split at the first colon outside a string or parentheses. */
const splitDeclaration = (raw) => {
  let depth = 0
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '\\') index += 1
    else if (char === '"' || char === "'") index = stringEnd(raw, index) - 1
    else if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ':' && depth === 0) {
      /* The property as the browser reads it: escapes decoded (`c\6f lor` is
         `color`), and — unless it is a custom property, which keeps its case —
         in lower case, because `Z-INDEX` is `z-index`. */
      const written = raw.slice(0, index).trim()
      if (!identStartsAt(written, 0)) return null
      const { name, end } = nameAt(written, 0)
      if (end !== written.length) return null
      const property = name.startsWith('--') ? name : name.toLowerCase()
      const rest = raw.slice(index + 1)
      const value = withoutImportant(rest)
      /* Empty is not a value for a property, but it is one for a custom
         property — set, so a `var()` of it does not fall back (#762 review). */
      if (value === '' && !property.startsWith('--')) return null
      return { property, value, important: value !== rest.trim() }
    }
  }
  return null
}

/* A mask reads alpha and ignores hue: `#000` in a gradient there means "show",
   not black, and no theme could meaningfully restyle it. The one exemption
   from the whole rule, named — a list of exceptions fails loudly when it is
   missing one, which a list of inclusions never does. */
const ALPHA_ONLY = /^(?:-webkit-)?mask(?:-image|-border(?:-source)?)?$/

/* The CSS named colours — the 148 in CSS Color 4, each checked in Chromium
   with `CSS.supports('color', name)`. `red` follows a theme change exactly as
   badly as `#f00`. Not here, deliberately: `transparent`, `currentColor`, the
   CSS-wide keywords and the system colours (`Canvas`, `LinkText`, …) — each of
   those means "no colour" or "whatever is in force", never a hue chosen in
   place. */
export const NAMED_COLOURS = Object.freeze(
  ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
    'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
    'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
    'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '),
)
/* Compared as decoded identifier tokens, in any case: `Red` and `r\65 d` are
   both `red`, while `--hd-red` and `darkred-ish` are other names, and
   `tan(45deg)` is a function — trigonometry, not the colour. */
const NAMED_SET = new Set(NAMED_COLOURS)
const COLOUR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'])

/* Properties whose values are names an author chose — a keyframes rule, a
   grid area or line, a counter, a font family, a container, a named page, a
   view-transition class, a property a transition or `will-change` names (any
   custom identifier is accepted there) — each checked in Chromium. A colour
   word there is an
   identifier, not a colour: `animation: red 1s` is a keyframes rule called
   `red`. Only the named-colour check stands aside for these; a hex or a colour
   function is a colour wherever it is written. Like the mask exemption, a list
   of exceptions: one missing from it shows up as a finding someone reads. */
const AUTHOR_NAMES =
  /^(?:animation(?:-name|-timeline)?|transition(?:-property)?|will-change|font(?:-family)?|grid(?:-area|-template(?:-areas|-columns|-rows)?|-(?:row|column)(?:-start|-end)?)?|counter-(?:reset|increment|set)|list-style(?:-type)?|container(?:-name)?|view-transition-(?:name|class)|page|anchor-name|position-anchor|timeline-scope|(?:scroll|view)-timeline(?:-name)?)$/

/** Whether a value writes a colour out: hex, a colour function or a named colour, outside `url()` and strings. */
export const rawColourIn = (value, { names = true } = {}) =>
  colourTokens(value).some(
    ({ type, value: token }) =>
      (type === 'hash' && /^[0-9a-f]{3,8}$/i.test(token)) ||
      (type === 'function' && COLOUR_FUNCTIONS.has(token.toLowerCase())) ||
      (names && type === 'ident' && NAMED_SET.has(token.toLowerCase())),
  )

/** Declarations that write a colour out, custom properties included. */
export const rawColours = (css) =>
  declarationsOf(css).filter(
    ({ property, value }) =>
      !ALPHA_ONLY.test(property) && rawColourIn(value, { names: !AUTHOR_NAMES.test(property) }),
  )

/* Past the `)` that closes `var(` or a math function: the first comma at depth
   zero inside it, or -1. */
const topLevelComma = (text) => {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') index += 1
    else if (char === '"' || char === "'") index = stringEnd(text, index) - 1
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) return index
  }
  return -1
}

/* A value that is one identifier, as the browser reads it — `in\69 tial` is
   `initial` — lower-cased; `null` for anything else. */
const keywordOf = (value) => {
  const text = value.trim()
  if (!identStartsAt(text, 0)) return null
  const { name, end } = nameAt(text, 0)
  return end === text.length ? name.toLowerCase() : null
}
/* The CSS-wide keywords that take a value from somewhere else — the parent,
   an earlier layer, an earlier origin — rather than giving one. */
const DEFERRING = new Set(['inherit', 'unset', 'revert', 'revert-layer'])

/* A CSS string's content with its escapes decoded, or `null` when the value
   is not exactly one string. */
const stringValue = (value) => {
  const text = value.trim()
  const quote = text[0]
  if ((quote !== '"' && quote !== "'") || text.length < 2 || text[text.length - 1] !== quote) return null
  if (stringEnd(text, 0) !== text.length) return null
  let content = ''
  for (let at = 1; at < text.length - 1; ) {
    if (text[at] !== '\\') content += text[at++]
    else if (text[at + 1] === '\n') at += 2
    else {
      const { char, end } = escapeAt(text, at)
      content += char
      at = end
    }
  }
  return content
}

/* Whether a value calls `var()`, however the name is spelled. */
const callsVar = (value) => {
  for (let at = 0; at < value.length; ) {
    const char = value[at]
    if (char === '"' || char === "'") at = stringEnd(value, at)
    else if (identStartsAt(value, at)) {
      const { name, end } = nameAt(value, at)
      if (value[end] === '(' && startsToken(value, at) && name.toLowerCase() === 'var') return true
      at = end
    } else at += char === '\\' ? 2 : 1
  }
  return false
}

/*
 * `@property` changes what `var()` gives, so the stacking rule reads it
 * (#762 review). A registered property that is not set is its
 * `initial-value`, so a `var()` of it does not fall back; `initial` is that
 * value; and a value that does not fit the registered syntax computes as
 * `unset` — the parent's value, or the initial value when the registration
 * does not inherit. As Chromium reads the rule: a `syntax` it cannot parse
 * (`<Integer>` is not a type, `unset` is not a name), an `inherits` other
 * than `true` or `false`, and anything marked `!important` are dropped one
 * descriptor at a time, and the last of each that stands wins — an
 * `initial-value` the browser drops (`5)`, `5 !foo`) leaves the one before
 * it; the rule then registers nothing without a `syntax` and an `inherits`,
 * without an `initial-value` where the syntax is not `*`, with a `var()` in
 * that value or one that certainly does not fit the syntax (`60px` for
 * `<integer>`, `calc(2 +3)`), or inside a style rule or a block the browser
 * drops. Of the rules that do register, the last wins, and a registered
 * value is what it computes to (`computedIn`): `60.0` is `60`.
 *
 * What the audit cannot settle it keeps both ways. A rule it cannot prove
 * registers — an initial value it cannot check against the syntax, a rule
 * under a condition — leaves the property possibly unregistered as well, and
 * a value it cannot prove fits the syntax may compute as `unset` too.
 */
const SYNTAX_TYPES = new Set([
  'angle', 'color', 'custom-ident', 'image', 'integer', 'length', 'length-percentage', 'number',
  'percentage', 'resolution', 'string', 'time', 'transform-function', 'transform-list', 'url',
])
const syntaxParses = (syntax) =>
  syntax === '*' ||
  syntax.split('|').every((part) => {
    const component = part.trim()
    const type = /^<([a-z-]+)>([+#]?)$/.exec(component)
    if (type) return SYNTAX_TYPES.has(type[1]) && !(type[1] === 'transform-list' && type[2])
    const name = component.replace(/[+#]$/, '')
    return (
      identStartsAt(name, 0) && nameAt(name, 0).end === name.length &&
      !['initial', 'inherit', 'unset', 'revert', 'revert-layer', 'default'].includes(nameAt(name, 0).name.toLowerCase())
    )
  })
/* What a value computes to under a registered syntax: itself for `*`; the
   number for `<number>`, to six significant digits (`60.0`, `6e1` and
   `59.9999999` are `60`; `calc(60.4)` is `60.4`);
   that number rounded for `<integer>` (`calc(60.4)` is `60`); a name written
   exactly for a name — each checked in Chromium. `NO_FIT` when it certainly
   fits none of the components, which happens only when every component is
   one of those; `null` when that cannot be told — another component, a
   dimension in the math, a rung from another stylesheet. */
const NO_FIT = Symbol('no fit')
/* A number as the browser writes a computed one back out, `%.6g`: six
   significant digits, so `59.9999999` substitutes as `60`, and an exponent
   from a million up, so `1234567` substitutes as `1.23457e+6`, which is no
   integer (checked in Chromium). */
const sixDigits = (number) => {
  if (!Number.isFinite(number) || number === 0) return String(number)
  const rounded = Number(number.toPrecision(6))
  const exponent = Math.floor(Math.log10(Math.abs(rounded)))
  return exponent < -4 || exponent >= 6 ? rounded.toExponential() : String(rounded)
}
const NUMBER = /^\s*[+-]?(?:[0-9]*\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?\s*$/
const computedIn = (value, syntax) => {
  if (syntax === '*') return value
  const tokens = mathTokens(value)
  if (tokens?.some((token) => token?.ident === RUNG)) return null
  let unknown = false
  for (const part of syntax.split('|')) {
    const component = part.trim()
    if (component === '<integer>' || component === '<number>') {
      const layer = layerIn(tokens)
      if (layer === UNPROVEN) unknown = true
      else if (layer !== null) return component === '<integer>' ? String(layer) : sixDigits(evaluate(tokens))
      else if (component === '<number>' && NUMBER.test(value)) return sixDigits(Number(value.trim()))
    } else if (!component.startsWith('<') && !/[+#]$/.test(component)) {
      if (value.trim() === component) return component
    } else unknown = true
  }
  return unknown ? null : NO_FIT
}
/* Syntaxes whose values interpolate: where this stylesheet animates the
   property (a `@keyframes` rule sets it) or declares a transition, it can sit
   anywhere between two of the values it is given, so a `z-index` reading one
   that has more than one is counted (#762 review). */
const INTERPOLATING = new Set([
  'integer', 'number', 'length', 'percentage', 'length-percentage', 'angle', 'time', 'resolution', 'color',
  'transform-function', 'transform-list',
])
const interpolates = (syntax) =>
  syntax.split('|').some((part) => INTERPOLATING.has(/^\s*<([a-z-]+)>/.exec(part)?.[1]))

const UNREGISTERED = Object.freeze({ registered: false })

/* name → every registration it may be under in this stylesheet. */
const registrationsOf = (declarations) => {
  const rules = new Map()
  for (const { property, value, important, rule } of declarations) {
    if (!rule.registers) continue
    if (!rules.has(rule)) rules.set(rule, { rule, syntax: undefined, inherits: undefined, initial: undefined })
    if (important) continue
    const entry = rules.get(rule)
    const syntax = stringValue(value)?.trim()
    const inherits = keywordOf(value)
    if (property === 'syntax' && syntax !== undefined && syntaxParses(syntax)) entry.syntax = syntax
    else if (property === 'inherits' && (inherits === 'true' || inherits === 'false')) entry.inherits = inherits === 'true'
    else if (property === 'initial-value') entry.initial = value
  }
  const byName = new Map()
  for (const { rule, syntax, inherits, initial } of rules.values()) {
    const registers =
      syntax !== undefined && inherits !== undefined && (initial === undefined ? syntax === '*' : !callsVar(initial))
    if (!registers) continue
    // an initial value that certainly does not fit registers nothing
    const fitted = initial === undefined ? undefined : computedIn(initial, syntax)
    if (fitted === NO_FIT) continue
    const state = {
      registered: true,
      universal: syntax === '*',
      syntax,
      inherits,
      initial: initial === undefined ? undefined : (fitted ?? initial),
    }
    const certain = rule.parent.layers && (initial === undefined || fitted !== null)
    byName.set(rule.registers, [...(byName.get(rule.registers) ?? []), { state, certain }])
  }
  const states = new Map()
  for (const [name, entries] of byName) {
    // a later rule wins, so nothing before the last certain one can
    const last = entries.findLastIndex(({ certain }) => certain)
    const possible = entries.slice(Math.max(last, 0)).map(({ state }) => state)
    states.set(name, last === -1 ? [...possible, UNREGISTERED] : possible)
  }
  return states
}

/* A reference to a custom property this stylesheet does not settle — set by
   another stylesheet: for a layer, a rung of the ladder — kept in the
   expression as this name, so what is done to it stays visible. A dashed name
   is never a valid operand of its own. */
const RUNG = '--rung'
const GUARANTEED_INVALID = Symbol('guaranteed invalid')
const MAX_CANDIDATES = 256
const MAX_DEPTH = 256

/*
 * Which rules' custom properties certainly reach the element a `z-index`
 * styles — read from the selectors, since the DOM is not here to ask.
 *
 * A rule for the same elements sets them on it: the same selector under the
 * same conditions; a rule it sits in, when every step between only narrows
 * when it applies (`@media`, `@supports`, `@container`, `@layer`,
 * `@starting-style`) or refines the same element (`&:hover`, `&`); or a
 * broader selector under the same conditions (`.a` reaches `.a:hover`,
 * `div.a` and `.x .a`) — outside a style rule or `@scope`, where a selector
 * is relative and `.a` means `.p .a`. A rule it is nested in through descendant or child
 * steps (`& .b`, `.b`, `> .b`) sets them on an ancestor, where an inheriting
 * property reaches it from, and so does one whose elements a pseudo-element
 * belongs to (`.a` for `.a::before`). Anything else — a sibling step, a
 * selector list with one selector it does not cover, `&` inside a
 * pseudo-class — is not taken to reach it.
 */
const SAME_ELEMENT = new Set(['media', 'supports', 'container', 'layer', 'starting-style'])

const selectorsOf = (list) => {
  const selectors = []
  let rest = list
  for (let comma = topLevelComma(rest); comma !== -1; comma = topLevelComma(rest)) {
    selectors.push(rest.slice(0, comma).trim())
    rest = rest.slice(comma + 1)
  }
  selectors.push(rest.trim())
  return selectors
}

/* A complex selector's compounds and the combinators between them, split
   outside brackets and strings: `.x > .a:hover` is `.x`, `>`, `.a:hover`. */
const compoundsOf = (selector) => {
  const compounds = ['']
  const combinators = []
  let depth = 0
  let pending = null
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]
    if (depth === 0 && /[ \t\n>+~]/.test(char)) {
      if (char !== ' ' && char !== '\t' && char !== '\n') pending = char
      else if (pending === null) pending = ' '
      continue
    }
    if (pending !== null && compounds[compounds.length - 1] !== '') {
      combinators.push(pending)
      compounds.push('')
    } else if (pending !== null && pending !== ' ') combinators.push(pending) // a leading `> .b`
    pending = null
    let end = index + 1
    if (char === '\\') end = index + 2
    else if (char === '"' || char === "'") end = stringEnd(selector, index)
    else if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    compounds[compounds.length - 1] += selector.slice(index, end)
    index = end - 1
  }
  return { compounds, combinators }
}

/* The simple selectors of one compound — `div`, `*`, `&`, `.a`, `#b`, `[x]`,
   `:hover`, `:not(.c)` — and whether it ends in a pseudo-element (`::before`,
   or the legacy `:before`), whose box inherits from the element the rest
   selects; `null` for anything else, or anything after the pseudo-element. */
const PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter'])
const compoundOf = (compound) => {
  const simples = []
  let pseudo = false
  let index = 0
  while (index < compound.length) {
    if (pseudo) return null
    const start = index
    const char = compound[index]
    if (char === '*' || char === '&') index += 1
    else if ((char === '.' || char === '#') && (identStartsAt(compound, index + 1) || nameCode(compound[index + 1])))
      index = nameAt(compound, index + 1).end
    else if (char === '[') {
      let depth = 0
      for (; index < compound.length; index += 1) {
        const inside = compound[index]
        if (inside === '\\') index += 1
        else if (inside === '"' || inside === "'") index = stringEnd(compound, index) - 1
        else if (inside === '[') depth += 1
        else if (inside === ']' && (depth -= 1) === 0) break
      }
      index += 1
    } else if (char === ':') {
      const element = compound[index + 1] === ':'
      const at = index + (element ? 2 : 1)
      if (!identStartsAt(compound, at)) return null
      const { name, end } = nameAt(compound, at)
      index = compound[end] === '(' ? closeOf(compound, end + 1) : end
      if (element || PSEUDO_ELEMENTS.has(name.toLowerCase())) {
        pseudo = true
        continue
      }
    } else if (index === 0 && identStartsAt(compound, 0)) index = nameAt(compound, 0).end
    else return null
    simples.push(compound.slice(start, index))
  }
  return simples.length > 0 ? { simples, pseudo } : null
}

/* How a nested style rule's elements relate to its parent rule's: `same`
   element, a `descendant` (a child, or a pseudo-element, which inherits from
   its element), or `null` for anything else. */
const nestedStep = (prelude) => {
  let relation = 'same'
  for (const selector of selectorsOf(prelude)) {
    const { compounds, combinators } = compoundsOf(selector)
    const parsed = compounds.map(compoundOf)
    if (parsed.some((compound) => compound === null)) return null
    const last = parsed.length - 1
    // a pseudo-element only ends a selector; `&` only as a simple selector of its own
    if (parsed.some((compound, index) => compound.pseudo && index !== last)) return null
    if (parsed.some(({ simples }) => simples.some((simple) => simple !== '&' && simple.includes('&')))) return null
    const amp = parsed.findLastIndex(({ simples }) => simples.includes('&'))
    if (amp === -1 && /^[+~]/.test(selector.trim())) return null
    // `&` earlier, or implied before a relative selector: every step down to
    // the subject must be a descendant or child one
    const steps = amp === -1 ? combinators : combinators.slice(amp)
    if (steps.some((combinator) => combinator === '+' || combinator === '~')) return null
    if (amp !== last || parsed[last].pseudo) relation = 'descendant'
  }
  return relation
}

/* Whether the single compound `outer` covers every selector in `list` — each
   one's subject carries all of its simple selectors: `same` when those are
   the elements, `ancestor` when some are pseudo-elements of them, `null`. */
const covers = (outer, list) => {
  const needed = outer.includes(',') ? null : compoundOf(outer.trim())
  if (!needed || needed.pseudo || needed.simples.includes('&')) return null
  let reach = 'same'
  for (const selector of selectorsOf(list)) {
    const { compounds } = compoundsOf(selector)
    const subject = compoundOf(compounds[compounds.length - 1])
    if (subject === null || !needed.simples.every((simple) => subject.simples.includes(simple))) return null
    if (subject.pseudo) reach = 'ancestor'
  }
  return reach
}

/* `same` when a rule's declarations reach the element `rule` styles, set on
   it; `ancestor` when they are set on an element it descends from; `null`. */
const reachOf = (defining, rule) => {
  if (defining.chain === rule.chain) return 'same'
  const styles = defining.parent !== null && !defining.prelude.startsWith('@')
  if (styles && rule.chain.startsWith(`${defining.chain}\n`)) {
    let reach = 'same'
    for (const step of rule.chain.slice(defining.chain.length + 1).split('\n')) {
      const atRule = atRuleOf(step)
      const relation = atRule === null ? nestedStep(step) : SAME_ELEMENT.has(atRule) ? 'same' : null
      if (relation === null) return null
      if (relation === 'descendant') reach = 'ancestor'
    }
    return reach
  }
  // only where a selector means what it says: nested in a style rule or `@scope`, `.a` is relative
  const absolute = rule.parent?.rules
  if (styles && absolute && defining.parent.chain === rule.parent.chain && !rule.prelude.startsWith('@'))
    return covers(defining.prelude, rule.prelude)
  return null
}

const once = (compute) => {
  let done = false
  let value
  return () => {
    if (!done) {
      value = compute()
      done = true
    }
    return value
  }
}

/*
 * Every value a `var()`-bearing value can take, as the browser resolves it
 * (#762 review; each case checked in Chromium).
 *
 * Which rules reach an element is the DOM's business, not this file's, so no
 * guess is made. `at` is the element being resolved: `rule` is the rule a
 * `z-index` sits in, or `null` for an element this stylesheet cannot place —
 * one a value is inherited from. A custom property there is
 *
 * - set on the element, when a rule `reachOf` finds for the same elements
 *   sets it: then it is one of the values the rules here give it, computed on
 *   that element;
 * - otherwise inherited: one of those values computed on another element, or
 *   — unless a rule sets it on an element this one descends from, or an
 *   unconditional `:root`, `html` or `*` rule (at the top of the sheet, or
 *   inside `@layer` only) for the whole document, and the property inherits —
 *   set by another stylesheet (`RUNG`), or not set at all, which is its
 *   initial value: the guaranteed-invalid value for an ordinary property, so
 *   the `var()` falls back.
 *
 * `initial` is the initial value; `inherit`, `unset`, `revert` and
 * `revert-layer` defer to the parent, an earlier layer or an earlier origin —
 * the inherited case — and act the same substituted in from a fallback. A
 * value that cannot compute (a `var()` of nothing with no fallback, a cycle)
 * is invalid at computed-value time: the guaranteed-invalid value, or `unset`
 * for a property registered with a syntax other than `*`. An empty value is
 * a value; a string is text. A loop that may run through other elements'
 * values is not listed, and neither is anything past `MAX_CANDIDATES` or
 * `MAX_DEPTH`: `null`, which the caller counts. What is not modelled errs the
 * same way: a condition is taken as possibly false.
 */
const resolver = ({ definitions, registrations, namespaced, moving }) => {
  let budget = 10_000
  let depth = 0

  /* Every property on a cycle is invalid at computed-value time. The
     reference that closes one answers with a marker naming the property it
     met again; each property the marker passes through hands it on, merged
     with any other it meets — `--b: var(--b) var(--c)` is on two — until the
     property it names takes it as its own invalid value. Which properties a
     cycle takes in depends on the order the browser meets them — Chromium
     marks those between the one met again and the one reading it, and a
     `color: var(--c)` beside the cycle changes which a `z-index` finds
     invalid — and each outcome is here: every property on it gets its invalid
     value, and every property below it reads that value as well as its own. */
  const cycles = new Map()
  const cycleOf = (names) => {
    const key = [...new Set(names)].sort().join('\n')
    if (!cycles.has(key)) cycles.set(key, { cycle: new Set(key.split('\n')) })
    return cycles.get(key)
  }
  /* Two pieces of a value side by side: text joins (a substituted piece
     padded, so it cannot fuse with its neighbours, as substitution never
     does); anything on a cycle is on it, and anything invalid is invalid. */
  const join = (head, option, padded) => {
    if (typeof head === 'string' && typeof option === 'string') return padded ? `${head} ${option} ` : head + option
    if (head?.cycle || option?.cycle) return cycleOf([...(head?.cycle ?? []), ...(option?.cycle ?? [])])
    return GUARANTEED_INVALID
  }

  const expand = (value, at) => {
    let heads = ['']
    let literal = ''
    let index = 0
    const extend = (options, padded) => {
      const out = new Set()
      for (const head of heads) for (const option of options) out.add(join(head, option, padded))
      heads = [...out]
      return heads.length <= MAX_CANDIDATES
    }
    const flush = () => {
      if (literal) extend([literal], false)
      literal = ''
    }
    while (index < value.length) {
      const char = value[index]
      if (char === '"' || char === "'") {
        // a string is text: `"var(--x)"` substitutes nothing
        const end = stringEnd(value, index)
        literal += value.slice(index, end)
        index = end
        continue
      }
      if (char === '\\') {
        literal += value.slice(index, index + 2)
        index += 2
        continue
      }
      if (identStartsAt(value, index)) {
        const { name, end } = nameAt(value, index)
        const fn = value[end] === '(' && startsToken(value, index) ? name.toLowerCase() : null
        if (fn === 'url' && !/^[ \t\n]*["']/.test(value.slice(end + 1))) {
          // an unquoted URL is an address, whatever is in it
          const close = unquotedUrlEnd(value, end + 1)
          literal += value.slice(index, close)
          index = close
          continue
        }
        if (fn === 'var') {
          // the end of the sheet closes a `var(` still open
          const close = closeAt(value, end + 1)
          const inner = close === -1 ? value.slice(end + 1) : value.slice(end + 1, close - 1)
          const comma = topLevelComma(inner)
          const reference = nameAt((comma === -1 ? inner : inner.slice(0, comma)).trim(), 0).name
          const options = candidatesOf(reference, comma === -1 ? null : inner.slice(comma + 1), at)
          flush()
          if (options === null || !extend(options, true)) return null
          index = close === -1 ? value.length : close
          continue
        }
        literal += value.slice(index, end)
        index = end
        continue
      }
      literal += char
      index += 1
    }
    flush()
    return heads
  }

  const candidatesOf = (name, fallback, at) => {
    if ((budget -= 1) < 0 || depth > MAX_DEPTH) return null
    depth += 1
    try {
      const out = new Set()
      const add = (options) => {
        if (options === null) return false
        for (const option of options) out.add(option)
        return true
      }
      const states = registrations.get(name) ?? [UNREGISTERED]
      if (at.seen.has(name)) out.add(cycleOf([name])) // a cycle on this element
      else for (const state of states) if (!add(valuesOf(name, fallback, at, state))) return null
      return out.size > MAX_CANDIDATES ? null : [...out]
    } finally {
      depth -= 1
    }
  }

  const valuesOf = (name, fallback, at, state) => {
    const rules = definitions.get(name) ?? []
    // the `var()`'s fallback, computed where the `var()` is
    const fallen = once(() => (fallback === null ? [GUARANTEED_INVALID] : expand(fallback, at)))
    const initial = () => (state.initial === undefined ? fallen() : [state.initial])
    const inherits = !state.registered || state.inherits
    const reaches = at.rule ? rules.map(({ rule }) => reachOf(rule, at.rule)) : []
    // set for the whole document, or on an element this one descends from
    const document =
      inherits &&
      rules.some(({ rule }, index) => (!namespaced && rule.universal === 'root') || reaches[index] === 'ancestor')

    /* What the rules here set it to, computed on `on`'s element; `parent` is
       what a value deferring to the parent comes to there. */
    const fromRules = (on, parent) => {
      const invalid = once(() =>
        !state.registered || state.universal ? fallen() : state.inherits ? parent() : [state.initial],
      )
      const out = []
      const add = (options) => options !== null && (out.push(...options), true)
      for (const { value } of rules) {
        const keyword = keywordOf(value)
        const options = keyword === 'initial' || DEFERRING.has(keyword) ? [value] : expand(value, on)
        if (options === null) return null
        for (const option of options) {
          if (typeof option === 'string') {
            // a CSS-wide keyword acts as one, written or substituted in
            const said = keywordOf(option)
            if (said === 'initial' || DEFERRING.has(said)) {
              if (!add(said === 'initial' ? initial() : parent())) return null
            } else if (!state.registered || state.universal) out.push(option)
            else {
              // registered: its computed value; not fitting, `unset`; not known, either
              const computed = computedIn(option, state.syntax)
              if (computed !== NO_FIT) out.push(computed ?? option)
              if (typeof computed !== 'string' && !add(invalid())) return null
            }
          } else if (option === GUARANTEED_INVALID) {
            if (!add(invalid())) return null
          } else if (option.cycle.has(name)) {
            if (!add(invalid())) return null
            const rest = [...option.cycle].filter((other) => other !== name)
            if (rest.length > 0) out.push(cycleOf(rest))
          } else out.push(option) // on a cycle that closes further up
        }
      }
      return out
    }

    /* Inherited: from any rule here, computed on another element — where a
       value deferring to its parent adds nothing new, unless it is the root,
       whose parent is the initial value — or not set anywhere. */
    const inherited = once(() => {
      if (at.path.has(name)) return null // a loop through other elements' values
      const elsewhere = { rule: null, seen: new Set([name]), path: new Set([...at.path, name]) }
      const set = fromRules(elsewhere, document ? initial : () => [])
      if (set === null || document) return set
      const unset = initial()
      return unset === null ? null : [RUNG, ...unset, ...set]
    })

    const here = reaches.includes('same')
    const values = here ? fromRules({ ...at, seen: new Set([...at.seen, name]) }, inherited) : inherited()
    if (values === null || !state.registered || !interpolates(state.syntax) || !moving(name)) return values
    // one that interpolates, animated or transitioned, can sit anywhere between two of its values
    return new Set(values.filter((option) => typeof option === 'string').map((option) => option.trim())).size > 1
      ? null
      : values
  }

  return { expand }
}

/*
 * The number an expression comes to, the way CSS Values 4 computes it: the
 * numeric math functions and constants, names decoded through the shared
 * escape reader so `c\61lc(` is `calc(`. `UNPROVEN` when it is a math
 * expression this cannot compute — a dimension, an angle, `if()`, `attr()`,
 * a function it does not know — which the stacking rule reports rather than
 * assumes small; `null` when it is not a number at all, or not valid CSS.
 *
 * Tokens are CSS's own, and so is the grammar (#762 review): a sign belongs to
 * its number (`-5`), `+` and `-` between terms need whitespace on both sides
 * (`calc(5 +5)` and `calc(5+ 5)` are not CSS), there is no unary minus
 * (`calc(- 5)`), `1e1` and `10.0` are numbers but not integers, nesting past
 * a hundred levels is refused, and functions still open at the end of the
 * sheet are closed there. Each of those checked in Chromium.
 */
const UNPROVEN = Symbol('unproven')
const MATH_FUNCTIONS = new Set([
  'calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign',
  'pow', 'sqrt', 'hypot', 'log', 'exp', 'sin', 'cos', 'tan',
])
const CONSTANTS = { pi: Math.PI, e: Math.E, infinity: Infinity, '-infinity': -Infinity, nan: NaN }
const ROUNDING = new Set(['nearest', 'up', 'down', 'to-zero'])
const MAX_NESTING = 100
const NUMBER_TOKEN = /^[+-]?(?:[0-9]*\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?/

const mathTokens = (text) => {
  const tokens = []
  let open = 0
  let at = 0
  while (at < text.length) {
    const char = text[at]
    if (/[ \t\n]/.test(char)) {
      while (/[ \t\n]/.test(text[at] ?? '')) at += 1
      tokens.push(' ')
      continue
    }
    const number = NUMBER_TOKEN.exec(text.slice(at))
    if (number) {
      at += number[0].length
      if (text[at] === '%') {
        at += 1
        tokens.push({ unit: true })
      } else if (identStartsAt(text, at)) {
        at = nameAt(text, at).end
        tokens.push({ unit: true })
      } else tokens.push({ num: Number(number[0]), int: !/[.eE]/.test(number[0]) })
      continue
    }
    if (identStartsAt(text, at)) {
      const { name, end } = nameAt(text, at)
      const lower = name.toLowerCase()
      if (text[end] !== '(') {
        tokens.push({ ident: lower })
        at = end
      } else if (MATH_FUNCTIONS.has(lower)) {
        tokens.push({ fn: lower })
        open += 1
        at = end + 1
      } else {
        // a function this does not compute — `if()`, `attr()`, `asin()` — read past whole
        tokens.push({ fn: lower, opaque: true })
        at = closeOf(text, end + 1)
      }
      continue
    }
    if (char === '(' || char === ')') open += char === '(' ? 1 : -1
    else if (!'+-*/,'.includes(char)) return null
    tokens.push(char)
    at += 1
  }
  for (; open > 0; open -= 1) tokens.push(')')
  return tokens
}

const evaluate = (tokens) => {
  let position = 0
  let unproven = false
  let depth = 0
  const invalid = () => {
    throw new Error('not CSS math')
  }
  const nextAt = () => {
    let at = position
    while (tokens[at] === ' ') at += 1
    return at
  }
  const peek = () => tokens[nextAt()]
  const take = () => {
    const at = nextAt()
    position = at + 1
    return tokens[at]
  }
  const expect = (token) => {
    if (take() !== token) invalid()
  }
  const nest = () => {
    if ((depth += 1) > MAX_NESTING) invalid()
  }
  const sum = () => {
    let total = product()
    for (;;) {
      // `+` and `-` only with whitespace on both sides
      if (tokens[position] !== ' ') return total
      const at = nextAt()
      const operator = tokens[at]
      if ((operator !== '+' && operator !== '-') || tokens[at + 1] !== ' ') return total
      position = at + 1
      const right = product()
      total = operator === '+' ? total + right : total - right
    }
  }
  const product = () => {
    let total = value()
    for (;;) {
      const operator = peek()
      if (operator !== '*' && operator !== '/') return total
      take()
      const right = value()
      total = operator === '*' ? total * right : total / right
    }
  }
  const argument = () => {
    const token = peek()
    if (token?.ident && (ROUNDING.has(token.ident) || token.ident === 'none')) return take().ident
    return sum()
  }
  const call = (fn) => {
    const args = [argument()]
    while (peek() === ',') {
      take()
      args.push(argument())
    }
    expect(')')
    const [a, b, c] = args
    const numbers = (count) => args.length === count && args.every((arg) => typeof arg === 'number')
    const variadic = () => args.length > 0 && args.every((arg) => typeof arg === 'number')
    if (fn === 'calc' && numbers(1)) return a
    if (fn === 'min' && variadic()) return Math.min(...args)
    if (fn === 'max' && variadic()) return Math.max(...args)
    if (fn === 'clamp' && args.length === 3 && typeof b === 'number') {
      // `none` for a bound is no bound (CSS Values 5)
      const low = a === 'none' ? -Infinity : a
      const high = c === 'none' ? Infinity : c
      if (typeof low === 'number' && typeof high === 'number') return Math.max(low, Math.min(b, high))
    }
    if (fn === 'round') {
      const [strategy, value, step] = typeof a === 'string' ? args : ['nearest', ...args]
      if (!ROUNDING.has(strategy) || typeof value !== 'number' || (step !== undefined && typeof step !== 'number') || args.length > 3) invalid()
      const unit = step ?? 1
      // a finite value to an infinite step: zero, or the infinity `up` and `down` round away to
      if (Math.abs(unit) === Infinity && Number.isFinite(value))
        return strategy === 'up' && value > 0 ? Infinity : strategy === 'down' && value < 0 ? -Infinity : 0
      const by = { nearest: Math.round, up: Math.ceil, down: Math.floor, 'to-zero': Math.trunc }[strategy]
      return by(value / unit) * unit
    }
    // a finite value by an infinite step is itself — for `mod()`, only with the step's sign
    const infiniteStep = numbers(2) && Math.abs(b) === Infinity && Number.isFinite(a)
    if (fn === 'mod' && infiniteStep) return a === 0 || Math.sign(a) === Math.sign(b) ? a : NaN
    if (fn === 'rem' && infiniteStep) return a
    if (fn === 'mod' && numbers(2)) return a - b * Math.floor(a / b)
    if (fn === 'rem' && numbers(2)) return a - b * Math.trunc(a / b)
    if (fn === 'abs' && numbers(1)) return Math.abs(a)
    if (fn === 'sign' && numbers(1)) return Math.sign(a)
    if (fn === 'pow' && numbers(2)) return a ** b
    if (fn === 'sqrt' && numbers(1)) return Math.sqrt(a)
    if (fn === 'hypot' && variadic()) return Math.hypot(...args)
    if (fn === 'log' && (numbers(1) || numbers(2))) return args.length === 2 ? Math.log(a) / Math.log(b) : Math.log(a)
    if (fn === 'exp' && numbers(1)) return Math.exp(a)
    if (fn === 'sin' && numbers(1)) return Math.sin(a)
    if (fn === 'cos' && numbers(1)) return Math.cos(a)
    if (fn === 'tan' && numbers(1)) return Math.tan(a)
    invalid()
  }
  const value = () => {
    const token = take()
    if (typeof token?.num === 'number') return token.num
    if (token?.unit) {
      unproven = true // a dimension: arithmetic on units is not modelled here
      return 1
    }
    if (token?.ident && token.ident in CONSTANTS) return CONSTANTS[token.ident]
    if (token?.opaque) {
      unproven = true
      return 1
    }
    if (token === '(' || token?.fn) {
      nest()
      const result = token === '(' ? sum() : call(token.fn)
      if (token === '(') expect(')')
      depth -= 1
      return result
    }
    invalid()
  }
  try {
    const result = sum()
    if (nextAt() !== tokens.length) return null
    return unproven ? UNPROVEN : result
  } catch {
    return null
  }
}

/*
 * The layer a resolved `z-index` value is, `UNPROVEN`, or `null`. The value
 * has to be one integer token or one math function: arithmetic outside a
 * function is not CSS (`sign(-5) * -12` computes to `auto` in Chromium). A
 * math result is rounded, as CSS rounds an integer, and clamped to the
 * integer range.
 */
const layerIn = (tokens) => {
  const meaningful = tokens?.filter((token) => token !== ' ') ?? []
  if (meaningful.length === 0) return null
  const [first] = meaningful
  if (meaningful.length === 1 && typeof first.num === 'number') return first.int ? first.num : null
  if (!first.fn) return null
  let depth = 0
  for (let index = 0; index < meaningful.length; index += 1) {
    const token = meaningful[index]
    if (token === '(' || (token?.fn && !token.opaque)) depth += 1
    else if (token === ')') depth -= 1
    if (depth === 0 && index !== meaningful.length - 1) return null
  }
  const result = evaluate(tokens)
  if (result === null || result === UNPROVEN) return result
  if (Number.isNaN(result)) return 0
  return Math.max(-2147483648, Math.min(2147483647, Math.round(result)))
}
const layerOf = (text) => layerIn(mathTokens(text))

/* Whether every `var()` in a value names one custom property before its
   comma: `var(foo)` and `var(--a b)` drop the whole declaration at parse time
   (checked in Chromium), so it sets and stacks nothing. */
const varsWellFormed = (value) => {
  for (let at = 0; at < value.length; ) {
    const char = value[at]
    if (char === '"' || char === "'") at = stringEnd(value, at)
    else if (char === '\\') at += 2
    else if (identStartsAt(value, at)) {
      const { name, end } = nameAt(value, at)
      const fn = value[end] === '(' && startsToken(value, at) ? name.toLowerCase() : null
      if (fn === 'url' && !/^[ \t\n]*["']/.test(value.slice(end + 1))) at = unquotedUrlEnd(value, end + 1)
      else if (fn === 'var') {
        const close = closeAt(value, end + 1)
        const inner = close === -1 ? value.slice(end + 1) : value.slice(end + 1, close - 1)
        const comma = topLevelComma(inner)
        const first = (comma === -1 ? inner : inner.slice(0, comma)).trim()
        const named = identStartsAt(first, 0) ? nameAt(first, 0) : null
        if (!named?.name.startsWith('--') || named.end !== first.length) return false
        at = end + 1 // and on into its fallback
      } else at = end
    } else at += 1
  }
  return true
}

/*
 * Whether an expression over rungs still takes a name, as the audit
 * documents it and nothing looser (#762 review): a rung; a function that
 * chooses one of its arguments — `min()`, `max()`, `clamp()`, `calc()` of
 * one — when every argument is itself such a choice; or one of those nudged
 * by a whole number from 0 to 9, `calc(var(--hd-z-sticky) + 1)` being the
 * app's one case. Anything else computes a plane of its own —
 * `calc(rung * rung)`, `abs(rung)`, `calc(rung + infinity)`, `+ 9.9`, which
 * rounds to a move of ten — and is counted.
 */
const choiceEnd = (tokens, at, depth = 0) => {
  const token = tokens[at]
  if (token?.ident === RUNG) return at + 1
  const choosing = token === '(' || token?.fn === 'calc' || token?.fn === 'min' || token?.fn === 'max' || token?.fn === 'clamp'
  if (!choosing || depth > MAX_NESTING) return -1
  let end = at + 1
  let count = 0
  for (;;) {
    end = choiceEnd(tokens, end, depth + 1)
    if (end === -1) return -1
    count += 1
    if (tokens[end] !== ',') break
    end += 1
  }
  if (tokens[end] !== ')') return -1
  const arity = token === '(' || token.fn === 'calc' ? count === 1 : token.fn === 'clamp' ? count === 3 : true
  return arity ? end + 1 : -1
}
const nudge = (token) => Number.isInteger(token?.num) && token.num >= 0 && token.num <= 9
const takesAName = (spaced) => {
  const tokens = spaced.filter((token) => token !== ' ')
  if (choiceEnd(tokens, 0) === tokens.length) return true
  if (tokens[0]?.fn !== 'calc' || tokens[tokens.length - 1] !== ')') return false
  const inner = tokens.slice(1, -1)
  const end = choiceEnd(inner, 0)
  if (end !== -1 && end === inner.length - 2) return (inner[end] === '+' || inner[end] === '-') && nudge(inner[end + 1])
  return nudge(inner[0]) && inner[1] === '+' && choiceEnd(inner, 2) === inner.length
}

/**
 * `z-index` written as a number in the shared band — 10 and up, however it is
 * spelled: a literal, math over literals (`calc(5 + 5)`, `abs(-12)`,
 * `round(up, 10.1, 1)`), or anything a `var()` in it can come to — a custom
 * property's value, its fallback, a registered initial value — as `resolver`
 * above works out, over the declarations the browser keeps. A math expression
 * that cannot be computed here is counted, and so is a value too deep to
 * follow: a number the audit cannot prove small is not assumed small. An
 * expression that is not CSS once its rungs are in is `auto`. What a rung
 * may have done to it is `takesAName`'s list; anything else done to a rung
 * (`+ 60`, `* 2`) writes a plane of its own and is counted (#762 review).
 */
export const rawZIndexes = (css) => {
  const { declarations, statements } = declarationsIn(css)
  const kept = declarations.filter(({ valid, value }) => valid && varsWellFormed(value))
  const definitions = new Map()
  for (const { property, value, rule } of kept) {
    if (property.startsWith('--')) definitions.set(property, [...(definitions.get(property) ?? []), { value, rule }])
  }
  const registrations = registrationsOf(kept)
  // a default namespace narrows `*`, `:root` and `html` to its own elements
  const namespaced = statements.has('namespace')
  const keyframed = (rule) => {
    for (let at = rule; at !== null; at = at.parent) if (/^-?(?:webkit-)?keyframes$/.test(atRuleOf(at.prelude) ?? '')) return true
    return false
  }
  const animated = new Set(kept.filter(({ property, rule }) => property.startsWith('--') && keyframed(rule)).map(({ property }) => property))
  const transitions = kept.some(
    ({ property, value }) => /^(?:-webkit-)?transition(?:-property)?$/.test(property) && keywordOf(value) !== 'none',
  )
  const moving = (name) => transitions || animated.has(name)
  const counts = (option) => {
    if (typeof option !== 'string') return false // invalid at computed-value time: `auto`
    const tokens = mathTokens(option)
    if (tokens?.some((token) => token?.ident === RUNG)) {
      // not CSS once the rung is in, it is `auto`; CSS, it takes a name or is counted
      const valid = layerIn(tokens.map((token) => (token?.ident === RUNG ? { num: 1, int: true } : token))) !== null
      return valid && !takesAName(tokens)
    }
    const layer = layerIn(tokens)
    return layer === UNPROVEN || (layer !== null && Math.abs(layer) >= 10)
  }
  return kept
    .filter(({ property, value, rule }) => {
      if (property !== 'z-index') return false
      try {
        const at = { rule, seen: new Set(), path: new Set() }
        const options = resolver({ definitions, registrations, namespaced, moving }).expand(value, at)
        return options === null || options.some(counts)
      } catch {
        return true // too deep to follow: counted, never assumed small
      }
    })
    .map(({ property, value }) => ({ property, value }))
}

/**
 * A `.tsx` file's code, with its comments gone.
 *
 * `bare` above is for CSS and must not be pointed at TypeScript: `/*` opens a
 * comment for it wherever it appears, so `files: ['src/api/**']` in
 * `preview/main.tsx` opened one that ran 149 lines to the next `*` + `/`, and
 * every rule here was blind to that stretch (#229). The compiler's parser is
 * the only thing that tells a comment from a string, and it is the one the
 * layering gate already reads. Parsed once per file, however many rules ask.
 */
const parsed = new Map()
export const codeOf = (file) => {
  if (!parsed.has(file)) parsed.set(file, withoutComments(read(file), file, { strict: true }))
  return parsed.get(file)
}

const findings = {
  wrongVariant: [],
  missingClass: [],
  forkedToken: [],
  handRolledOverlay: [],
  looseIcon: [],
  looseTarget: [],
  offGrid: [],
  rawRadius: [],
  danglingToken: [],
  crossImport: [],
  rawZIndex: [],
  rawColour: [],
  arbitraryUtility: [],
  rawType: [],
  rawWeight: [],
  patternClass: [],
}

/**
 * The shapes a screen keeps re-declaring instead of composing.
 *
 * One stem, and the list has been cut twice. It began at thirteen and matched
 * on a class's leading stem alone, so a diff table's `.row`, the library's
 * 250px sticky `.name` and a flex `.body` were all counted as re-declared
 * patterns. Narrowing to `head`, `header` and `empty` was supposed to leave
 * the words that name exactly one thing, and it did not: reading the fourteen
 * `head` findings, `ToolPanes` draws a 46px pane title bar, `MessageQueue` a
 * 12px status strip, `GitPane` a 24px table header with a rule under it, and
 * `Approvals` a card header at 14/600. Four different components, not four
 * copies of one.
 *
 * `empty` survives because it is the one word here that names a single thing:
 * a list with nothing in it. Sampled, every finding was a screen saying
 * "nothing here" at its own padding and its own size.
 *
 * The rule this leaves, and it is the useful half: **a stem is only worth
 * counting when the word names exactly one thing.** For everything else the
 * question is what a class *declares*, not what it is called, and that is a
 * different check from this one.
 */
const PATTERN_STEMS = new Set(['empty'])

/** A screen's own stylesheet, as opposed to the system's. */
const isScreenSheet = (file) => /\/(components|slots|panels)\//.test(file)

/**
 * Controls sitting in a slot whose meaning the design system has fixed.
 *
 * The allow-lists are read from `design/usage.ts` rather than repeated here,
 * so the rule, the generated documentation of the rule, and this gate cannot
 * drift from one another — which is the same claim the token snapshot makes
 * about values, applied to choices.
 *
 * Only slots whose meaning does not depend on what the screen is about. A
 * header's action is a header's action on every page; whether *this* button is
 * the important one is a judgement, and judgement is what the `when` column in
 * usage.ts is for. So this never says "that should have been primary" — only
 * "that variant cannot appear here at all".
 */

/**
 * The files that are allowed to write an `<svg>`.
 *
 * `Icons.tsx` is a façade over lucide; `BrandIcons.tsx` holds the marks lucide
 * does not have. Everywhere else an icon is imported, which is what makes
 * "change the icon set" one edit rather than a search across the app.
 *
 * `spark.tsx` is the third, and it is not an exception to the rule so much as
 * outside it: what it draws is not a glyph but the data — a path computed from
 * an array of numbers. There is no icon set it could be imported from, and
 * swapping the icon set must not change a chart. The rule this file enforces
 * is "one place decides what a symbol looks like"; a sparkline has no symbol.
 */
const ICON_MODULES = new Set([
  'Icons.tsx',
  'BrandIcons.tsx',
  'spark.tsx',
  // Data marks and illustrations are not glyphs. They remain local because
  // their paths are the content being rendered, not a replaceable icon set.
  'chart.tsx',
  'AppearancePreview.tsx',
  'GitGraph.tsx',
])

/** Existing screen families only, capped at eleven additional owners. An
 * annotation documents membership; it cannot grant a new exception. See
 * AGENTS.md rule 11. Shared generic UI still belongs in design/. */
export const STYLESHEET_OWNERS = Object.freeze({
  'components/Conversation.module.css': ['components/TurnTail.tsx'],
  'components/Items.module.css': ['components/MessageActions.tsx', 'components/StepGroup.tsx'],
  'components/Plugins.module.css': ['components/PluginsSection.tsx'],
  'components/Settings.module.css': ['components/Extensions.tsx'],
  'components/Sidebar.module.css': ['components/SessionTree.tsx'],
  'components/ToolPanes.module.css': ['components/BrowserPane.tsx', 'components/FilePane.tsx', 'components/PreviewPane.tsx', 'components/TerminalPane.tsx', 'components/ToolPaneHeader.tsx'],
})

/** The space steps the system offers, as plain numbers. */
const tokens = resolveTokens({ root })
const SPACE = new Set(
  [...tokens]
    .filter(([name]) => name.startsWith('--hd-space-'))
    .map(([, value]) => Number.parseInt(value, 10))
    .filter((n) => Number.isFinite(n)),
)
const RADIUS = new Set(
  [...tokens]
    .filter(([name]) => /^--hd-radius(-|$)/.test(name))
    .map(([, value]) => Number.parseInt(value, 10))
    .filter((n) => Number.isFinite(n)),
)

for (const file of cssFiles()) {
  const name = label(file)
  const css = bare(read(file))

  // Type written out rather than named. `offGrid` and `rawRadius` already do
  // this for space and shape; type had no check at all, which is how 11px,
  // 11.5px and 12.5px reached the tree while the scale said four steps.
  if (isScreenSheet(file)) {
    for (const match of css.matchAll(/font-size:\s*([^;]+);/g)) {
      const value = match[1].trim()
      /*
       * `em` is a ratio, not a size. Inline code inside prose is 0.875 of
       * whatever it sits in, so it follows a heading down and a caption up; a
       * fixed step would freeze it against its own paragraph. The scale is for
       * absolute type, and this is the one place the app is right not to use
       * it — all three occurrences now agree on the same ratio.
       */
      if (/var\(--hd|inherit|100%|em\b|--prose/.test(value)) continue
      findings.rawType.push(`${name}: font-size: ${value}`)
    }

    /*
     * And the other half of a type step. The scale is three rungs — normal,
     * medium, semibold — and the app agreed with it on every value while
     * writing ninety of them as bare numbers, which is a scale nobody can
     * move: shifting medium off 500 would have meant finding forty-six
     * places. Two of the ninety were not even on the scale, and one of those
     * two could not render — the bundled face stops at 600, so 650 was
     * always drawing 600 while telling the next reader it was heavier.
     *
     * A weight with a space in it is a variable face's range in `@font-face`,
     * not a declaration a screen is making.
     */
    for (const match of css.matchAll(/font-weight:\s*([^;]+);/g)) {
      const value = match[1].trim()
      if (/var\(--hd|inherit|\s/.test(value)) continue
      findings.rawWeight.push(`${name}: font-weight: ${value}`)
    }
    /*
     * Once per sheet per pattern, not once per class.
     *
     * `.rowWrap`, `.rowHead`, `.rowBody`, `.rowTitle` and `.rowMeta` in one
     * stylesheet are a single row's anatomy, not five duplicated patterns —
     * counting each of them would make renaming `.rowTitle` to
     * `.sessionTitle` read as progress, which is worse than the drift. What
     * is actually being counted is "this screen declares a row of its own",
     * and eighteen screens do.
     */
    const declared = new Set()
    for (const match of css.matchAll(/^\.([A-Za-z][A-Za-z0-9]*)/gm)) {
      const stem = (/^[a-z]+/.exec(match[1]) ?? [])[0]
      if (stem && PATTERN_STEMS.has(stem)) declared.add(stem)
    }
    for (const stem of [...declared].sort()) findings.patternClass.push(`${name}: .${stem}*`)
  }

  // Spacing that is not a step of the scale.
  for (const match of css.matchAll(/(padding|margin|gap)(-[a-z]+)?:\s*([^;]+);/g)) {
    for (const piece of match[3].split(/\s+/)) {
      const px = /^(\d+)px$/.exec(piece.trim())
      if (px && Number(px[1]) !== 0 && !SPACE.has(Number(px[1]))) {
        findings.offGrid.push(`${name}: ${match[1]}${match[2] ?? ''}: ${piece}`)
      }
    }
  }

  // A radius the system does not have a name for. 50% and 9999px are circles.
  //
  // `(?<![-\w])` so the property is matched, not a substring of one: without
  // it, `--card-radius:` reads as `radius:` and a custom property is audited
  // by accident — which is worse than not auditing it, because the check looks
  // like it is working.
  for (const match of css.matchAll(/(?<![-\w])border-radius\s*:\s*([^;]+);/g)) {
    const value = match[1].trim()
    if (value.includes('var(') || value === '50%' || value === 'inherit' || value === '9999px') continue
    const px = /^(\d+)px$/.exec(value)
    if (px && !RADIUS.has(Number(px[1]))) findings.rawRadius.push(`${name}: border-radius: ${value}`)
  }

  // A colour written out rather than named — in any declaration, custom
  // properties included, which is where one hides: a literal behind
  // `--row-tint` follows a theme change exactly as badly as one written in
  // place. See `declarationsOf` for why this reads values, not property names.
  for (const { property, value } of rawColours(read(file))) {
    findings.rawColour.push(`${name}: ${property}: ${value.replace(/\s+/g, ' ').slice(0, 48)}`)
  }

  // Stacking written as a number.
  //
  // The ladder in `tokens.css` already says it: "Stacking is a system, not a
  // race. A component that needs to sit above another takes the next name up;
  // it never writes a number." Twenty-four places wrote a number, because the
  // rule was prose and nothing read it.
  //
  // Single digits are left alone deliberately. A `z-index: 1` that lifts a
  // label over the image beside it is ordering *within* one component's own
  // stacking context — it can no more collide with the dialog layer than
  // `order: 1` can, and a rung would say something false about it. From 10 up
  // is the band where two components can genuinely claim the same plane, and
  // that is the band the ladder is for.
  for (const { value } of rawZIndexes(read(file))) findings.rawZIndex.push(`${name}: z-index: ${value}`)

  // A system token defined outside the file that owns the system.
  //
  // The `--hd-` prefix means "this is the app's vocabulary". Defining one in a
  // screen forks the source of truth: the doc will not know about it, the token
  // snapshot will not cover it, and a redesign that rewrites `tokens.css` will
  // sail straight past it. A component's own private property is fine — it just
  // may not wear the system's prefix.
  //
  // A FOUNDATION is the exception, and it is not a loophole — it is the
  // mechanism. `tokens.<name>.css` is a set of overrides applied last in the
  // cascade, which is how a candidate redesign or a user's own theme happens
  // without editing the system it is varying (design/explorer/foundation.ts).
  // Redefining `--hd-*` is the entire job of such a file, so flagging it would
  // forbid the one sanctioned way to do the thing this system exists to allow.
  if (!/^tokens\.[A-Za-z0-9-]+\.css$/.test(path.basename(file))) {
    for (const match of css.matchAll(/(--hd-[A-Za-z0-9-]+)\s*:/g)) {
      findings.forkedToken.push(`${name}: defines ${match[1]}`)
    }
  }

  // A token nobody defines, with no fallback: resolves to nothing, silently.
  // Component-local properties are legitimate — a component may declare its
  // own, in its own file or through an inline style — so only a name that
  // nothing anywhere sets is a finding.
  const localNames = new Set(
    [...css.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((hit) => hit[1]),
  )
  const sibling = file.replace(/\.module\.css$/, '.tsx')
  if (fs.existsSync(sibling)) {
    for (const hit of read(sibling).matchAll(/'(--[A-Za-z0-9-]+)'\s*:/g)) localNames.add(hit[1])
  }
  for (const match of css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*\)/g)) {
    if (!tokens.has(match[1]) && !localNames.has(match[1])) {
      findings.danglingToken.push(`${name}: var(${match[1]})`)
    }
  }
}

// A screen used as a component library: the drift that makes rebuilding one
// screen break another.
//
// The same pass answers a sharper question. A CSS module resolves an unknown
// class to `undefined`, and `className={undefined}` is valid React — so a
// class that has been renamed or deleted in the stylesheet leaves the element
// it styled completely unstyled, silently, with nothing failing. Nobody finds
// that except by looking at the screen. Every reference is checked against the
// classes its stylesheet actually declares.
const classesOf = (source) => {
  const names = new Set()
  for (const hit of bare(source).matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) names.add(hit[1])
  return names
}

/**
 * The stylesheets one file draws from, by the binding each is imported as, and
 * the imports that reach into another screen.
 *
 * A file may draw from its own stylesheet, or from the one named after the
 * folder it lives in. The second case is a screen that outgrew one file —
 * `explorer/Explorer.tsx` and `explorer/boards.tsx` are one screen sharing
 * `explorer.module.css`, which is the right arrangement, not drift. The rule
 * being enforced is that a screen may not reach into a DIFFERENT screen.
 *
 * It takes the UI's source root rather than reading the checkout's, so a test
 * can drive it over a tree holding the import shapes this one does not: a
 * `../` import, and one behind the `@/` alias (#185).
 */
export const sheetsOf = (dir, file, name, source, uiSrc) => {
  const sheets = new Map()
  const crossImports = []
  // The whole source: `stylesheetImports` strips comments itself, and is the one that has to (review of #183, round 7).
  for (const { binding, file: spec } of stylesheetImports(source, file, { strict: true })) {
    const sheet = resolveStylesheet(dir, spec, uiSrc)
    const target = path.join(dir, sheet)
    const css = sourceOf(target)
    const declaredOwners = css !== null
      ? /@design-owners\s+([^\n*]+)/.exec(css)?.[1]?.split(',').map((owner) => owner.trim()) ?? []
      : []
    const cappedOwners = STYLESHEET_OWNERS[path.relative(uiSrc, target).split(path.sep).join('/')] ?? []
    const declared = declaredOwners.includes(path.basename(file, path.extname(file)))
      && cappedOwners.includes(path.relative(uiSrc, file).split(path.sep).join('/'))
    // As written, so the finding greps back to its line; resolved beside it when an alias made them differ.
    if (!ownsStylesheet(file, sheet) && !declared) crossImports.push(`${name} imports ${spec}${spec === sheet ? '' : ` (${sheet})`}`)
    if (css !== null) sheets.set(binding, { file: sheet, classes: classesOf(css) })
  }
  return { sheets, crossImports }
}

/**
 * WCAG 2.2 SC 2.5.8 asks 24×24 CSS pixels of a control.
 *
 * There is an exception for an undersized target with clearance — a 24px
 * circle on it meeting no other target's circle — and it is a real exception,
 * not a loophole: the accent swatches in Appearance are 20px with their
 * centres 28px apart and pass on it. So this counts rather than forbids, and
 * the baseline is what the app has today. Clearing one means measuring the
 * surface, not editing the number here.
 */
const TARGET_FLOOR = 24

/**
 * The pieces of a selector list, or of one selector, split on `separators` at
 * the top level only: a comma inside `:not(…)` or a space inside `[data-x=" "]`
 * separates nothing.
 *
 * Depth is counted outside quotes only. A `(` in an attribute value —
 * `[data-x="("]` — raised a depth that the closing `]` lowered once, so every
 * separator after it in the selector looked nested and the list stopped
 * splitting: the rule was then filed under its last selector alone, and the
 * first one was dropped (#267).
 */
const outside = (text, separators) => {
  const parts = []
  let depth = 0
  let at = 0
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote) {
      if (character === quote && text[index - 1] !== '\\') quote = ''
    } else if (character === '"' || character === "'") quote = character
    else if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth -= 1
    else if (depth === 0 && separators.includes(character)) {
      parts.push(text.slice(at, index))
      at = index + 1
    }
  }
  parts.push(text.slice(at))
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * The classes one selector is about: the classes of its *subject*, the
 * compound at the end.
 *
 * `.tray .tabClose` is a rule about `tabClose`; taking the first class filed
 * it under `tray`, so the button carrying `styles.tabClose` found nothing and
 * an undersized target went uncounted. And when that last compound carries no
 * class — `.onTask svg`, `.grid [data-mark]` — the rule is about something
 * inside the class, not about it: 13px of icon inside a button was counted as
 * a 13px button (#185).
 */
const subjectClasses = (selector) => {
  const subject = outside(selector, ' \t\n>+~').pop() ?? ''
  // What a `:not(…)` or `:has(…)` holds is about other elements, not this one:
  // `.mark:not(.a .b)` is a rule about `mark`. Innermost first, for nesting.
  let stripped = subject
  let shorter = stripped.replace(/\([^()]*\)/g, '')
  while (shorter !== stripped) {
    stripped = shorter
    shorter = stripped.replace(/\([^()]*\)/g, '')
  }
  // Every class on the compound, not its last: `.foo.bar` is one element
  // wearing both names, and the component may reach it by either. Filing the
  // rule under `bar` alone hid it from a control carrying `styles.foo` (#267).
  const classes = [...stripped.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((match) => match[1])
  if (classes.length > 0) return classes
  /* `:is(…)` and `:where(…)` are the exception to the stripping above: where
     nothing else names the subject, what they hold *is* it, so `:is(.a, .b)`
     is a rule about both rather than a rule about nothing. Only where nothing
     else does — an element matching `.delta:is(.epsilon)` is named `delta`,
     and `epsilon` only narrows which deltas (#267). */
  return [...subject.matchAll(/:(?:is|where)\(([^()]+)\)/g)]
    .flatMap((match) => outside(match[1], ','))
    .flatMap((argument) => subjectClasses(argument))
}

/** `class` → the px of a rule that declares an equal literal width and height. */
export const squaresOf = (cssPath) => {
  const out = new Map()
  for (const rule of bare(read(cssPath)).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const width = /(?:^|;|\s)width:\s*(\d+)px/.exec(rule[2])
    const height = /(?:^|;|\s)height:\s*(\d+)px/.exec(rule[2])
    if (!width || !height || width[1] !== height[1]) continue
    // Every selector in the list, since `.a, .b` is one rule about two things.
    for (const selector of outside(rule[1], ',')) {
      for (const name of subjectClasses(selector)) out.set(name, Number(height[1]))
    }
  }
  return out
}

/*
 * Arbitrary Tailwind values in the component layer.
 *
 * The CSS rules above catch a literal in a stylesheet, and for most of this
 * app's life that was every literal there was. The shadcn layer changed that:
 * its components carry their measures as utilities, so `text-[11px]` and
 * `rounded-[3px]` are exactly the drift `offGrid` and `rawRadius` exist to
 * count — written where those rules cannot see them. A gate that only watches
 * the door the drift stopped using is worse than no gate, because the number
 * it reports looks like an answer.
 *
 * Only `design/` is scanned. A screen writing a one-off utility is a screen's
 * business; the *system* claiming to own a scale while writing outside it is
 * the contradiction worth failing on.
 */
const ARBITRARY = /\b(?:text|rounded|h|w|size|p[xytblr]?|m[xytblr]?|gap(?:-[xy])?)-\[(\d+)px\]/g

for (const file of tsxFiles()) {
  if (file.includes(`${path.sep}design${path.sep}`) && !file.includes('.test.')) {
    for (const match of codeOf(file).matchAll(ARBITRARY)) {
      findings.arbitraryUtility.push(`${label(file)}: ${match[0]}`)
    }
  }
}

for (const file of tsxFiles()) {
  const name = label(file)
  const dir = path.dirname(file)
  const source = read(file)

  // Shared structural policy covers both raw dialog attributes and low-level
  // parts, including aliased imports. Canonical patterns own overlay policy;
  // AppWindow is the exact specialized composition recorded in that policy.
  const code = codeOf(file)
  for (const detail of overlayViolations(path.relative(root, file).split(path.sep).join('/'), source)) findings.handRolledOverlay.push(`${name}: ${detail}`)

  // An icon drawn in place rather than imported.
  if (!ICON_MODULES.has(path.basename(file)) && /<svg[\s>]/.test(code)) {
    findings.looseIcon.push(`${name}: <svg> outside the icon modules`)
  }

  // A control in a slot the system has a written rule for.
  // `code`, not `source`: every other check here reads the comment-stripped
  // form, and this one did not — so a commented-out `<SectionHead action={…}>`
  // in a doc comment was scanned as if it rendered.
  for (const hit of slotOffenders(code, name)) findings.wrongVariant.push(hit)

  /** Local binding → the classes that stylesheet declares. */
  const { sheets, crossImports } = sheetsOf(dir, file, name, source, UI_SRC)
  findings.crossImport.push(...crossImports)

  // A glyph control drawn smaller than a finger.
  //
  // Only classes that actually land on a `<button>`: the same stylesheets are
  // full of 7px dots and 14px marks, and a parser cannot tell a status light
  // from a close button by looking at the rule. The element it is written on
  // can.
  // The tag is walked, not matched with a length cap. `[\s\S]{0,400}?>` gave
  // up on any `<button>` longer than that and reported nothing — which is the
  // only reason the accent swatches were not a twelfth finding. They do pass
  // SC 2.5.8 on clearance (20px, 28px between centres, measured in the running
  // app), but nothing here knew that: they were missed, not exempted, and the
  // difference matters because the next long tag would be missed too.
  for (const tag of code.matchAll(/<button\b/g)) {
    const className = attributes(code, tag.index + tag[0].length).get('className') ?? ''
    for (const use of className.matchAll(/(\w+)\.([A-Za-z][A-Za-z0-9_]*)/g)) {
      const sheet = sheets.get(use[1])
      if (!sheet) continue
      const px = squaresOf(path.join(dir, sheet.file)).get(use[2])
      if (px === undefined || px >= TARGET_FLOOR) continue
      // One class on three buttons is one undersized control, not three: the
      // fix is a single rule, and a count that says otherwise makes the
      // backlog look bigger than the work.
      // Keyed by where the sheet is, from the UI's root: two spellings of one path are one sheet (review of #183, round 7).
      const line = `${path.relative(UI_SRC, path.join(dir, sheet.file))}: .${use[2]} is ${px}px square, under the ${TARGET_FLOOR}px target`
      if (!findings.looseTarget.includes(line)) findings.looseTarget.push(line)
    }
  }

  for (const [binding, sheet] of sheets) {
    const use = new RegExp(`\\b${binding}\\.([A-Za-z][A-Za-z0-9_]*)`, 'g')
    // `code`, not `source`: a class named in a comment is not one used (review of #183).
    for (const hit of code.matchAll(use)) {
      if (!sheet.classes.has(hit[1])) {
        findings.missingClass.push(`${name}: ${binding}.${hit[1]} — not in ${sheet.file}`)
      }
    }
  }
}


const counts = Object.fromEntries(SECTIONS.map(([key]) => [key, findings[key].length]))
const total = Object.values(counts).reduce((sum, n) => sum + n, 0)

if (process.argv.includes('--baseline')) {
  const strictTotal = SECTIONS
    .filter(([key]) => !BURN_DOWN.has(key))
    .reduce((sum, [key]) => sum + counts[key], 0)
  if (strictTotal !== 0) {
    console.error(`Refusing to record a non-zero design baseline (${strictTotal} findings). Fix the drift first.`)
    process.exit(1)
  }
  fs.writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`)
  console.log('baseline written:', counts)
  process.exit(0)
}

const verbose = process.argv.includes('--verbose')
/* Everything above is the scan; everything below runs it. The split is what
   lets a test import `squaresOf` without the audit printing a report and
   calling `process.exit` out from under the runner — the same guard
   `design-doc.mjs` and `check-layering.mjs` already carry. */
const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

/**
 * Validates the zero baseline and reports any current finding. A non-zero
 * baseline is itself invalid: debt cannot be accepted by editing the ledger.
 */
export const compareBaseline = (counts, baseline) => {
  const problems = []
  let worse = false

  for (const [key, title, , fix] of SECTIONS) {
    const rawWas = baseline[key]
    if (rawWas === undefined) {
      problems.push({ key, title, message: `Missing baseline entry for '${key}'` })
      worse = true
      continue
    }
    const was = Number(rawWas)
    if (typeof rawWas !== 'number' || Number.isNaN(was) || !Number.isFinite(was)) {
      problems.push({
        key,
        title,
        message: `Baseline value for '${key}' is not a valid number: ${JSON.stringify(rawWas)}`,
      })
      worse = true
      continue
    }
    const current = counts[key] ?? 0
    if (BURN_DOWN.has(key)) {
      if (current > was) {
        worse = true
        problems.push({
          key,
          title,
          was,
          current,
          fix,
          message: `${title}: ${was} -> ${current}. This category may only fall.`,
        })
      } else if (current < was) {
        worse = true
        problems.push({
          key,
          title,
          was,
          current,
          fix: 'Record the lower ceiling: node script/design-audit.mjs --baseline',
          message: `${title}: ${was} -> ${current}. Tighten the ceiling so it cannot drift back.`,
        })
      }
      continue
    }
    if (was !== 0) {
      problems.push({
        key,
        title,
        was,
        message: `Baseline value for '${key}' must be zero, received ${was}`,
      })
      worse = true
    }
    if (current > 0) {
      worse = true
      problems.push({
        key,
        title,
        was,
        current,
        fix,
        message: `${title}: ${current}. The strict design gate requires zero.`,
      })
    }
  }

  return { worse, problems }
}

if (isMain) {
  console.log('Design system audit\n')
  for (const [key, title, why] of SECTIONS) {
    const list = findings[key]
    console.log(`${String(list.length).padStart(4)}  ${title}`)
    console.log(`      ${why}`)
    if (verbose) for (const line of list) console.log(`        ${line}`)
    else for (const line of list.slice(0, 3)) console.log(`        ${line}`)
    if (!verbose && list.length > 3) console.log(`        … ${list.length - 3} more (--verbose)`)
    console.log('')
  }
  console.log(`${total} findings.`)

  if (!process.argv.includes('--strict')) process.exit(0)

  if (!fs.existsSync(BASELINE)) {
    console.error('\nNo baseline. Run: node script/design-audit.mjs --baseline')
    process.exit(1)
  }
  const baseline = JSON.parse(read(BASELINE))
  const { worse, problems } = compareBaseline(counts, baseline)
  for (const p of problems) {
    console.error(`\n${p.message}`)
    if (findings[p.key]) {
      for (const line of findings[p.key].slice(0, 6)) console.error(`  ${line}`)
    }
    if (p.fix) console.error(`  → ${p.fix}`)
  }
  process.exit(worse ? 1 : 0)
}
