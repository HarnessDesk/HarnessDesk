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
import ts from 'typescript'

import { SECTIONS } from './design-sections.mjs'
import { resolveTokens } from './design-tokens.mjs'
import { attributes, footerOffenders, slotOffenders } from './design-usage.mjs'
import { ownsStylesheet, resolveStylesheet, stylesheetImports } from './lib/stylesheet-imports.mjs'
import { withoutComments } from './lib/without-comments.mjs'
import { repositoryFiles } from './lib/repository-files.mjs'
import { overlayViolations, utilityBase } from './ui-architecture.mjs'

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
const BURN_DOWN = new Set(['patternClass', 'screenAppearance'])

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
  screenAppearance: [],
  screenUnclassified: [],
  visualKindUnion: [],
  /**
   * Utilities that look like an appearance family this rule has not been
   * taught — `caret-red-500`, `from-black` — reported only under `--verbose`,
   * never counted. Deliberately outside `SECTIONS`: adding a family here
   * does not tighten anything, it is a hint for whoever next extends
   * `screenUtilityDeclarationOf`, not a second strict category.
   */
  unmappedScreenUtility: [],
}

/**
 * A `kind` prop large enough to be a component catalogue rather than one
 * component's variants. The prop may name a string-literal alias so the rule
 * follows the public API instead of depending on whether its author wrote the
 * union inline. Domain unions such as a notice's stored kind are outside the
 * design directory and are not scanned by the caller below.
 */
export const visualKindUnionsOf = (source) => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const aliases = new Map()
  for (const match of code.matchAll(/\btype\s+([A-Za-z_$][\w$]*)\s*=\s*(\|?\s*['"][^'"]+['"](?:\s*\|\s*['"][^'"]+['"])+)/g)) {
    aliases.set(match[1], [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]))
  }
  const found = []
  for (const match of code.matchAll(/\bkind\??\s*:\s*([A-Za-z_$][\w$]*)/g)) {
    const values = aliases.get(match[1])
    if (values && values.length > 8) found.push({ prop: 'kind', type: match[1], count: values.length })
  }
  return found
}

/**
 * The screen family a source belongs to.
 *
 * Most screens own their basename. The Git surface is deliberately spread
 * across several source files, so its recorded family prefixes collapse to
 * one area. A new multi-file family has to be named here; an unknown screen
 * must never become `null`, because `null` used to exempt every non-Git
 * consumer from the single-area pattern ledger.
 */
export const screenAreaOf = (file) => {
  const relative = path.relative(UI_SRC, file).split(path.sep).join('/')
  if (/^components\/(?:Git|Branch|Changes|Details(?:\.|$)|NewWorktree)/.test(relative)) return 'git'
  const match = /^(?:components|slots|panels)\/([^/]+)\.tsx$/.exec(relative)
  return match?.[1]?.toLowerCase() ?? null
}

/**
 * The pane registry mounts screens; it is not a screen family of its own.
 * Following a consumer into its hosts is right when the host is another
 * screen (a pattern used by Approvals, which the room also embeds, is used in
 * two places), but every pane is registered in `panels/builtins.tsx`, so
 * counting the registry as a host made every pane's pattern cross-area — and
 * the single-area pass below counted nothing at all (#912: GitHistory's only
 * consumer is GitPane, and it read as shared with the registry).
 */
const PANE_REGISTRIES = new Set(['panels/builtins.tsx'])
const isPaneRegistry = (file) => PANE_REGISTRIES.has(path.relative(UI_SRC, file).split(path.sep).join('/'))

/** One owning screen area, or `null` when a pattern is genuinely cross-area. */
export const singleScreenAreaOf = (files, importersByFile = new Map()) => {
  const screens = new Set(files)
  for (const file of files) {
    for (const importer of importersByFile.get(file) ?? []) if (!isPaneRegistry(importer)) screens.add(importer)
  }
  const areas = new Set([...screens].map(screenAreaOf))
  return areas.size === 1 && !areas.has(null) ? [...areas][0] : null
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
const isScreenSheet = (file) => !/[\\/]design[\\/]/.test(file) && /[\\/](components|slots|panels)[\\/]/.test(file)

/**
 * Specialized renderers whose appearance is their content rather than a role.
 *
 * Markdown keeps a prose ladder made from ratios of the body size, as
 * `docs/design.md` specifies, so a heading and the paragraph it belongs to
 * must scale together rather than take unrelated system steps. A diff viewer
 * is a specialized renderer: its ink, rows and marks describe source changes,
 * not a reusable screen role. Naming both here makes adding another boundary
 * a deliberate change to the gate rather than an accidental path omission.
 */
const SCREEN_APPEARANCE_EXEMPTIONS = new Set([
  'components/Markdown.module.css',
  'components/Diff.module.css',
])

const screenAppearanceName = (file) => file.replaceAll('\\', '/').split('/packages/ui/src/').at(-1)
const unprefixedProperty = (property) => property.replace(/^-(?:webkit|moz)-/, '')

/**
 * A height that describes where a box sits rather than what the role is: a
 * share of its container, a share of the viewport, or a keyword that lets the
 * content or the layout decide. Zero is the flex/grid shrink reset in every
 * unit spelling, not a role metric. Everything else — a non-zero length, a
 * token, a `calc()` of either — is the role's own metric, and counts.
 */
const ZERO_HEIGHT = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?(?:[a-z]+|%)?$/i
const LAYOUT_HEIGHT = /%|\d(?:[sld]?v(?:h|w|min|max|b|i)|cq(?:h|w|i|b|min|max))\b|^(?:auto|none|stretch|fit-content|min-content|max-content|inherit|initial|unset|revert|revert-layer)$|^fit-content\(/i

/**
 * The appearance side of the screen boundary: type, ink and ground, edges,
 * and a role's inner box. Families are stems because CSS may add or the app
 * may adopt another longhand without that spelling becoming invisible.
 */
export const APPEARANCE_PROPERTIES = {
  exact: new Set([
    'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'text-underline-offset', 'text-shadow',
    'color', 'fill', 'caret-color', 'accent-color', 'filter', 'backdrop-filter', 'mix-blend-mode',
    'box-shadow', 'height', 'min-height', 'max-height',
  ]),
  families: ['font', 'text-decoration', 'background', 'stroke', 'mask', 'border', 'outline', 'padding'],
}

/**
 * The layout and behaviour side of the screen boundary. It names geometry,
 * flow, interaction and motion explicitly; the last group are descriptors or
 * specialized properties that the app's screen sheets currently use.
 */
const LAYOUT_BEHAVIOUR_PROPERTIES = {
  exact: new Set([
    'display', 'gap', 'row-gap', 'column-gap', 'position', 'top', 'right', 'bottom', 'left',
    'width', 'min-width', 'max-width', 'block-size', 'min-block-size', 'max-block-size',
    'inline-size', 'min-inline-size', 'max-inline-size', 'z-index', 'order', 'float', 'box-sizing',
    'aspect-ratio', 'isolation', 'visibility', 'opacity', 'cursor', 'pointer-events', 'user-select',
    'will-change', 'content', 'white-space', 'text-overflow', 'text-align', 'vertical-align',
    'word-break', 'hyphens', 'table-layout', 'resize', 'appearance', 'app-region',
    'box-orient', 'caption-side', 'clip-path', 'direction', 'line-clamp', 'touch-action', 'unicode-bidi',
    'syntax', 'inherits', 'initial-value',
  ]),
  families: [
    'flex', 'grid', 'align', 'justify', 'place', 'inset', 'margin', 'overflow', 'object', 'transform',
    'contain', 'container', 'transition', 'animation', 'list-style', 'scroll', 'overscroll', 'scrollbar',
  ],
}

const inPropertyTable = (name, table) =>
  table.exact.has(name) || table.families.some((family) => name === family || name.startsWith(`${family}-`))

export const screenPropertySideOf = (property, value) => {
  if (property.startsWith('--')) return 'custom'
  const name = unprefixedProperty(property)
  if (inPropertyTable(name, APPEARANCE_PROPERTIES)) {
    if (name === 'height' || name === 'min-height' || name === 'max-height') {
      const metric = value.replace(/\s*!important\s*$/i, '').trim()
      if (ZERO_HEIGHT.test(metric) || LAYOUT_HEIGHT.test(metric)) return 'layout'
    }
    return 'appearance'
  }
  if (inPropertyTable(name, LAYOUT_BEHAVIOUR_PROPERTIES)) return 'layout'
  return 'unclassified'
}

/**
 * Appearance a screen draws for itself instead of composing from the system.
 *
 * Type, ink, ground, edges and a role's inner box are owned by the component
 * that names that role, so every declaration of one here is a copy a system
 * change cannot reach. Every ordinary property is matched against the two
 * explicit tables above; one on neither side is a separate strict finding,
 * rather than silently becoming layout. Custom properties define values
 * rather than draw either side and remain outside the split. Height and its
 * minimum and maximum constraints use one value rule: a non-zero fixed length
 * or token is a control metric, while zero, a percentage, an intrinsic size,
 * or a viewport/container share describes layout.
 *
 * Markdown is exempt because prose keeps its own ratio ladder, and Diff is
 * exempt because a diff viewer is a specialized renderer. Both boundaries
 * are named above rather than hidden in the directory walk.
 */
export const screenAppearanceOf = (file, css) => {
  if (!isScreenSheet(file) || SCREEN_APPEARANCE_EXEMPTIONS.has(screenAppearanceName(file))) return []
  return declarationsOf(css).filter(({ property, value }) => screenPropertySideOf(property, value) === 'appearance')
}

/** Ordinary declarations in a screen sheet that are on neither explicit side. */
export const screenUnclassifiedOf = (file, css) => {
  if (!isScreenSheet(file) || SCREEN_APPEARANCE_EXEMPTIONS.has(screenAppearanceName(file))) return []
  return declarationsOf(css).filter(({ property, value }) => screenPropertySideOf(property, value) === 'unclassified')
}

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

/**
 * Screen appearance, re-drawn as a Tailwind utility or an inline `style`
 * instead of a screen's `.module.css`.
 *
 * `screenAppearanceOf` above answers this for a stylesheet; it went quiet
 * because the same declarations moved into `className={\`... h-(--hd-chip-h)
 * ...\`}` and `style={{ background: ... }}` in the screen's own `.tsx`, which
 * that CSS-only rule cannot see. A screen that still draws its own type, ink,
 * ground, edges or a role's inner box should still count, whichever of the
 * three spellings — literal CSS, a utility class, an inline style — it used.
 *
 * A "screen" here is exactly `isScreenSheet`'s directory test (components,
 * slots, panels, outside design/), so `preview/` — the harness, not a screen —
 * and `app/` are never in scope without a separate rule. `ICON_MODULES` keeps
 * the exemption it already has from the loose-icon rule: a data mark is
 * content, not a role being redrawn. The `.tsx` that renders each exempt
 * `.module.css` in `SCREEN_APPEARANCE_EXEMPTIONS` gets the same exemption for
 * the same reason — prose keeps its own ratio ladder, a diff viewer is a
 * specialized renderer — whichever of the pair holds the declaration.
 */
const SCREEN_APPEARANCE_TSX_EXEMPTIONS = new Set(
  [...SCREEN_APPEARANCE_EXEMPTIONS].map((sheet) => sheet.replace(/\.module\.css$/, '.tsx')),
)

const isScreenTsx = (file) =>
  isScreenSheet(file)
  && !file.includes('.test.')
  && !ICON_MODULES.has(path.basename(file))
  && !SCREEN_APPEARANCE_TSX_EXEMPTIONS.has(screenAppearanceName(file))

/** The combiner every shadcn component reaches for (`lib/utils.ts`'s `cn`)
 * and its two common aliases — a `cn(...)`/`clsx(...)`/`cx(...)` call is a
 * third place a screen's classes are spelled, alongside a plain string and a
 * template literal. */
const CLASS_COMBINERS = new Set(['cn', 'clsx', 'cx'])

/**
 * A real parser never reads a comment as code, so there is nothing here for a
 * pre-pass to strip: a commented-out `className="…"` was never a token
 * `ts.createSourceFile` produced, with or without one. (An earlier version
 * ran the file through `withoutComments` first anyway, out of habit from the
 * regex-based rules elsewhere in this file — round 1 review found the habit
 * carried no effect and the fixture that claimed to prove it was vacuous.)
 * `strict` parsing is kept: a file the parser could not read fails by name,
 * the same contract `codeOf` and `ui-architecture.mjs`'s own `parseSource`
 * hold elsewhere.
 */
const parseScreenSource = (file, source) => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const problem = ast.parseDiagnostics?.[0]
  if (problem) throw new Error(`${file}: TypeScript could not parse this file (${ts.flattenDiagnosticMessageText(problem.messageText, ' ')})`)
  return ast
}

/* Tailwind's named type scale. `2xl` through `9xl` share one shape, so they
   are matched by pattern instead of listed one at a time. */
const TEXT_SIZE_SUFFIX = /^(?:xs|sm|base|lg|xl|\d+xl)$/
const TEXT_ALIGN_SUFFIX = new Set(['left', 'center', 'right', 'justify', 'start', 'end'])
// `text-wrap`/`nowrap`/`balance`/`pretty` set layout (`white-space`), not a
// colour — named so they do not fall into the "anything else is a colour"
// default below.
const TEXT_LAYOUT_SUFFIX = new Set(['wrap', 'nowrap', 'balance', 'pretty'])
const FONT_WEIGHT_SUFFIX = new Set(['thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black'])
const FONT_FAMILY_SUFFIX = new Set(['sans', 'serif', 'mono'])

const looksLikeColour = (value) =>
  /^#[0-9a-f]{3,8}$/i.test(value)
  || /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i.test(value)
  || /^(?:currentcolor|transparent|black|white)$/i.test(value)

/**
 * A `h-`/`min-h-`/`max-h-`/`size-` suffix, resolved to a value string that
 * carries the same layout-vs-metric signal a real CSS value would, so
 * `screenPropertySideOf` can decide it with the exact rule it already applies
 * to a stylesheet's `height`: `full`/`screen`/`dvh`/… are the keywords and
 * viewport units `LAYOUT_HEIGHT` matches, a fraction is a percentage, and a
 * bare scale number (`8`, `0.5`, `0`) is left for `ZERO_HEIGHT` to tell a
 * reset from a metric.
 */
const HEIGHT_KEYWORD_VALUE = {
  full: '100%', screen: '100vh', dvh: '100dvh', svh: '100svh', lvh: '100lvh',
  min: 'min-content', max: 'max-content', fit: 'fit-content', auto: 'auto',
}
const heightSuffixValue = (suffix) => {
  if (Object.hasOwn(HEIGHT_KEYWORD_VALUE, suffix)) return HEIGHT_KEYWORD_VALUE[suffix]
  const fraction = /^(\d+)\/(\d+)$/.exec(suffix)
  if (fraction) return `${(100 * Number(fraction[1])) / Number(fraction[2])}%`
  if (suffix === 'px') return '1px'
  return suffix
}
const HEIGHT_PROPERTY_OF = { h: 'height', 'min-h': 'min-height', 'max-h': 'max-height', size: 'height' }
const PADDING_SIDE_PROPERTY = {
  p: 'padding', px: 'padding-inline', py: 'padding-block',
  pt: 'padding-top', pr: 'padding-right', pb: 'padding-bottom', pl: 'padding-left',
  ps: 'padding-inline-start', pe: 'padding-inline-end',
  pbs: 'padding-block-start', pbe: 'padding-block-end',
}

/** A whole utility with no suffix — the class name itself is the declaration.
 * The numeric-variant family (`tabular-nums` and its siblings) all toggle
 * `font-variant-numeric`, the same property a stylesheet's own declaration of
 * it already counts under the `font` family match. */
const LITERAL_UTILITY_PROPERTY = {
  italic: 'font-style', 'not-italic': 'font-style',
  underline: 'text-decoration', 'line-through': 'text-decoration', 'no-underline': 'text-decoration',
  uppercase: 'text-transform', lowercase: 'text-transform', capitalize: 'text-transform', 'normal-case': 'text-transform',
  truncate: 'text-overflow', 'text-ellipsis': 'text-overflow', 'text-clip': 'text-overflow',
  border: 'border', rounded: 'border-radius', shadow: 'box-shadow', ring: 'box-shadow', outline: 'outline',
  'normal-nums': 'font-variant-numeric', ordinal: 'font-variant-numeric', 'slashed-zero': 'font-variant-numeric',
  'lining-nums': 'font-variant-numeric', 'oldstyle-nums': 'font-variant-numeric', 'proportional-nums': 'font-variant-numeric',
  'tabular-nums': 'font-variant-numeric', 'diagonal-fractions': 'font-variant-numeric', 'stacked-fractions': 'font-variant-numeric',
}

/**
 * A Tailwind utility — its variants and `!` already stripped by the caller —
 * mapped to the CSS property it sets, and a value string for the one family
 * where `screenPropertySideOf` reads the value at all (height). Classifying
 * the RESULT through that one function, rather than keeping a second
 * appearance/layout table here, is the whole point: a screen's utility and a
 * screen's literal CSS declaration are the same drift, spelled two ways.
 *
 * Returns `null` for a token this has not been taught. That is not the same
 * as "layout" — it is "not counted, and not claimed to be understood either".
 */
export const screenUtilityDeclarationOf = (token) => {
  // `[prop:value]` names its own property outright — Tailwind's escape hatch
  // for a property no utility covers. No prefix table applies; the bracket
  // contents are read directly and handed to the same boundary function.
  const arbitrary = /^\[([a-zA-Z-]+):(.+)\]$/.exec(token)
  if (arbitrary) return { property: arbitrary[1].toLowerCase(), value: arbitrary[2] }

  if (Object.hasOwn(LITERAL_UTILITY_PROPERTY, token)) return { property: LITERAL_UTILITY_PROPERTY[token], value: '' }

  // `h-`/`min-h-`/`max-h-`/`size-` with nothing after the hyphen is what a
  // template literal (`` `h-${n}` ``) leaves behind once its interpolation is
  // read separately: the prefix alone still names the role. An empty value
  // is neither `ZERO_HEIGHT` nor `LAYOUT_HEIGHT`, so it counts as a metric —
  // the same way `text-${x}` already fell through to a colour below. This is
  // the utility side only; an unknown *inline `style`* height is the opposite
  // decision, right below `screenInlineStyleAppearanceOf`.
  const height = /^(h|min-h|max-h|size)-(.*)$/.exec(token)
  if (height) {
    const [, key, rest] = height
    const bracket = /^\[(.+)\]$/.exec(rest)?.[1]
    const paren = /^\((.+)\)$/.exec(rest)?.[1]
    const value = bracket ?? paren ?? heightSuffixValue(rest)
    return { property: HEIGHT_PROPERTY_OF[key], value }
  }

  // `text-shadow-*` (Tailwind's own type shadow) shares the `text-` prefix
  // with the size/colour family below and must be pulled out first, or
  // `shadow-md` reads as its "rest" and falls through to the colour default.
  if (token.startsWith('text-shadow-')) return { property: 'text-shadow', value: '' }
  if (token.startsWith('underline-offset-')) return { property: 'text-underline-offset', value: '' }

  if (token.startsWith('text-')) {
    const rest = token.slice('text-'.length)
    const bracket = /^\[(.+)\]$/.exec(rest)?.[1]
    if (bracket !== undefined) return { property: looksLikeColour(bracket) ? 'color' : 'font-size', value: '' }
    const paren = /^\((.+)\)$/.exec(rest)?.[1]
    if (paren !== undefined) return { property: /^length:/.test(paren) ? 'font-size' : 'color', value: '' }
    if (TEXT_SIZE_SUFFIX.test(rest)) return { property: 'font-size', value: '' }
    if (TEXT_ALIGN_SUFFIX.has(rest)) return { property: 'text-align', value: '' }
    if (TEXT_LAYOUT_SUFFIX.has(rest)) return { property: 'white-space', value: '' }
    return { property: 'color', value: '' }
  }

  if (token.startsWith('font-')) {
    const rest = token.slice('font-'.length)
    if (rest.startsWith('stretch-')) return { property: 'font-stretch', value: '' }
    if (/^[[(]/.test(rest)) return { property: 'font-family', value: '' }
    if (FONT_WEIGHT_SUFFIX.has(rest)) return { property: 'font-weight', value: '' }
    if (FONT_FAMILY_SUFFIX.has(rest)) return { property: 'font-family', value: '' }
    return null
  }

  if (token.startsWith('leading-')) return { property: 'line-height', value: '' }
  // Tailwind negates an arbitrary/bracket value with a leading `-` rather
  // than a different utility name (`-tracking-[2px]`), so the family is
  // checked with the sign stripped, not as a second prefix.
  if (token.startsWith('tracking-') || token.startsWith('-tracking-')) return { property: 'letter-spacing', value: '' }
  if (token.startsWith('decoration-')) return { property: 'text-decoration', value: '' }

  if (token.startsWith('bg-')) {
    const rest = token.slice('bg-'.length)
    if (rest.startsWith('clip-')) return { property: 'background-clip', value: '' }
    if (rest.startsWith('origin-')) return { property: 'background-origin', value: '' }
    return { property: 'background', value: '' }
  }

  // `inset-shadow-*`/`inset-ring-*` before the plain `shadow-`/`ring-` check:
  // they do not share its prefix, so order does not matter for correctness,
  // only for reading the two rings of the same family next to each other.
  if (token.startsWith('inset-shadow-')) return { property: 'box-shadow', value: '' }
  if (token.startsWith('inset-ring-')) return { property: 'box-shadow', value: '' }
  if (token.startsWith('mix-blend-')) return { property: 'mix-blend-mode', value: '' }
  // Every `mask-*` sub-property (image, size, position, repeat, clip, origin,
  // type, mode, composite) is counted as one, the same approximation
  // `bg-clip-`/`bg-origin-` already makes for `background`.
  if (token.startsWith('mask-')) return { property: 'mask-image', value: '' }

  if (token.startsWith('border-')) return { property: 'border', value: '' }
  if (token.startsWith('rounded-')) return { property: 'border-radius', value: '' }
  if (token.startsWith('shadow-')) return { property: 'box-shadow', value: '' }
  if (token.startsWith('ring-')) return { property: 'box-shadow', value: '' }
  if (token.startsWith('outline-')) return { property: 'outline', value: '' }
  if (token.startsWith('fill-')) return { property: 'fill', value: '' }
  if (token.startsWith('stroke-')) return { property: 'stroke', value: '' }
  if (token.startsWith('opacity-')) return { property: 'opacity', value: '' }

  // As with height above, an empty suffix is what `` `px-${n}` `` leaves
  // once its interpolation is read separately — padding has no value-based
  // rule, so the property alone is enough to count it.
  const padding = /^(pbs|pbe|p|px|py|pt|pr|pb|pl|ps|pe)-(.*)$/.exec(token)
  if (padding) return { property: PADDING_SIDE_PROPERTY[padding[1]], value: '' }

  return null
}

/**
 * A Tailwind namespace this rule knows is appearance but has not mapped —
 * `caret-red-500`, `from-black`, bare `antialiased` — reported only under
 * `--verbose`, on `unmappedScreenUtility`, and never counted. Extending
 * `screenUtilityDeclarationOf` is the fix; adding a name here is not — this
 * is a hint, not a second strict category.
 */
const UNMAPPED_APPEARANCE_LITERAL = new Set(['antialiased', 'subpixel-antialiased'])
const UNMAPPED_APPEARANCE_PREFIX = /^(?:caret|accent|placeholder|divide|from|via|to|selection|blur|brightness|contrast|grayscale|hue-rotate|invert|saturate|sepia|drop-shadow|backdrop-(?:blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia))-/
export const looksLikeUnmappedAppearanceUtility = (token) =>
  UNMAPPED_APPEARANCE_LITERAL.has(token) || UNMAPPED_APPEARANCE_PREFIX.test(token)

/** Tailwind v4 moved the important marker to the end of a token
 * (`bg-red-500!`); a v3 source may still carry it at the front
 * (`!bg-red-500`). Either spelling is punctuation, not part of the name. */
const withoutImportantMarker = (token) => token.replace(/^!/, '').replace(/!$/, '')

/**
 * The scopes a reference node sits inside, innermost first: every enclosing
 * `{ }` block and the file itself. A function's own parameter list is not a
 * scope this walks into separately — nothing here resolves a parameter — and
 * arrow bodies with no block (`() => expr`) hold no declarations to find.
 */
const enclosingScopes = (node) => {
  const scopes = []
  let current = node.parent
  while (current) {
    if (ts.isSourceFile(current) || ts.isBlock(current)) scopes.push(current)
    current = current.parent
  }
  return scopes
}

/** A `const`/`let`/`var` declared directly in `scope`'s own statement list —
 * not in a nested block, which is a different scope with its own turn in
 * `enclosingScopes`. */
const directDeclarationIn = (scope, name) => {
  for (const statement of scope.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) return declaration
    }
  }
  return null
}

/**
 * A name, resolved to the nearest declaration in an enclosing scope — real JS
 * scoping, not "the first one anywhere in the file": two components each
 * declaring their own `const tone` are two declarations, and an inner block
 * that shadows an outer `const tone` resolves to its own, not the outer one.
 *
 * `const` yields its one initializer. `let`/`var` is read the same way when
 * it is never reassigned; when it is, every literal assignment reachable
 * from the declaring scope — the initializer and each `name = …` found in it
 * or a nested block, not inside a separate closure — is gathered, because a
 * variable that can hold more than one thing statically is not the one
 * declaration a `const` is. Either way the result is keyed by the
 * declaration's own position (`pos`), not by name, so `countedDefs` can
 * dedupe by the declaration rather than by a name two scopes both use.
 */
/** `=` and `+=` both introduce literal content worth gathering — `c += '
 * bg-(--x)'` after `let c = 'text-xs'` adds a second piece to the same
 * declaration, not a replacement of the first, so both are kept rather than
 * only the initializer or only the latest assignment. */
const REASSIGNMENT_OPERATORS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken])

const nearestDeclaration = (refNode, name) => {
  for (const scope of enclosingScopes(refNode)) {
    const declaration = directDeclarationIn(scope, name)
    if (!declaration) continue
    if ((declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
      return { pos: declaration.pos, nodes: [declaration.initializer] }
    }
    const assignments = []
    const visit = (node) => {
      if (node !== scope && ts.isFunctionLike(node)) return
      if (
        ts.isBinaryExpression(node) && REASSIGNMENT_OPERATORS.has(node.operatorToken.kind)
        && ts.isIdentifier(node.left) && node.left.text === name
      ) {
        assignments.push(node.right)
      }
      ts.forEachChild(node, visit)
    }
    visit(scope)
    return { pos: declaration.pos, nodes: [declaration.initializer, ...assignments] }
  }
  return null
}

/** A named or default import's binding in one file → the name it was
 * exported under (`'default'` for a default import) and the specifier it
 * came from. A namespace import (`import * as ns`) is resolved separately,
 * at its own `ns.NAME` property-access site, not by a bare name lookup. */
const importBinding = (ast, localName) => {
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const spec = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (clause.name && clause.name.text === localName) return { spec, exportedName: 'default' }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.name.text === localName) return { spec, exportedName: (element.propertyName ?? element.name).text }
      }
    }
  }
  return null
}

/** A namespace import's local binding (`import * as styles2 from '…'`) →
 * the specifier it came from, for a `styles2.NAME` property access. */
const namespaceImportSpec = (ast, localName) => {
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const bindings = statement.importClause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === localName) return statement.moduleSpecifier.text
  }
  return null
}

/** A relative or `@/`-aliased specifier → the `.tsx`/`.ts` file it names, the
 * same two resolutions `publicDesignImports` and `resolveStylesheet` already
 * make for their own imports. A bare package specifier resolves to nothing:
 * a screen's own constants are never published from `node_modules`. */
const resolveConstModule = (fromFile, spec) => {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null
  const base = spec.startsWith('@/') ? path.join(UI_SRC, spec.slice(2)) : path.resolve(path.dirname(fromFile), spec)
  for (const ext of ['.tsx', '.ts']) {
    const candidate = base.endsWith(ext) ? base : `${base}${ext}`
    if (sourceOf(candidate) !== null) return candidate
  }
  return null
}

/** Parsed once per file and kept: a constant several screens import —
 * `LibraryActions.tsx`'s `SWITCH_TRACK`, read by `Library.tsx` too — would
 * otherwise be re-parsed by every consumer that reaches for it. */
const constFileCache = new Map()
const parsedConstFile = (file) => {
  if (!constFileCache.has(file)) {
    const source = sourceOf(file)
    constFileCache.set(file, source === null ? null : { ast: parseScreenSource(file, source) })
  }
  return constFileCache.get(file)
}

/**
 * An exported name's value in `file`'s top level — where an import always
 * lands, since only a module's own top level can be exported — following a
 * re-export (`export { NAME } from './Other'`, `hops` deep, default four)
 * and a default export, either `export default <expr>` directly or
 * `export default NAME` naming a local `const`. `directDeclarationIn` at the
 * `SourceFile` scope is enough here; an export can never name a block-scoped
 * local.
 */
const exportedValueIn = (file, exportedName, hops = 4) => {
  const parsed = parsedConstFile(file)
  if (!parsed) return null
  if (exportedName === 'default') {
    for (const statement of parsed.ast.statements) {
      if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue
      if (ts.isIdentifier(statement.expression)) {
        const declaration = directDeclarationIn(parsed.ast, statement.expression.text)
        return declaration ? { file, ast: parsed.ast, pos: declaration.pos, nodes: [declaration.initializer] } : null
      }
      return { file, ast: parsed.ast, pos: statement.pos, nodes: [statement.expression] }
    }
    return null
  }
  const declaration = directDeclarationIn(parsed.ast, exportedName)
  if (declaration) return { file, ast: parsed.ast, pos: declaration.pos, nodes: [declaration.initializer] }
  if (hops <= 0) return null
  for (const statement of parsed.ast.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      if (element.name.text === exportedName) {
        const nextFile = resolveConstModule(file, statement.moduleSpecifier.text)
        if (!nextFile || !isScreenTsx(nextFile)) return null
        return exportedValueIn(nextFile, (element.propertyName ?? element.name).text, hops - 1)
      }
    }
  }
  return null
}

/**
 * A name used at a class site → the declaration it names, wherever that is:
 * the nearest enclosing scope first, then one or more hops through an import
 * to the file that (eventually, through a re-export chain) declares it. A
 * definition outside the screen boundary (`design/`, a test file) is not
 * followed — the boundary this whole rule enforces would otherwise credit a
 * screen's reference for the design system's own choice.
 */
const resolveClassConst = (identifierNode, file, ast) => {
  const name = identifierNode.text
  const local = nearestDeclaration(identifierNode, name)
  if (local) return { file, ast, pos: local.pos, nodes: local.nodes }
  const binding = importBinding(ast, name)
  if (!binding) return null
  const modulePath = resolveConstModule(file, binding.spec)
  if (!modulePath || !isScreenTsx(modulePath)) return null
  return exportedValueIn(modulePath, binding.exportedName)
}

/**
 * Every class-bearing site in a screen `.tsx`, resolved through however many
 * layers separate it from the literal: a `className` — string, template
 * literal, ternary, array, a nested `cn`/`clsx`/`cx` call, or a name that
 * only leads to one of those through its own declaration; a `className:` key
 * in an object literal (`BrowserPane.tsx`'s `createElement('webview', {
 * className: … })`); and a bare `cn`/`clsx`/`cx` call reached some other way,
 * such as a class list built once and assigned to a variable.
 *
 * The shapes this recurses into are named, not inferred by walking whatever
 * a node happens to hold — round 3 review found the closed list too narrow,
 * dropping 15 real shapes the previous, more permissive walker still caught,
 * so the list below is deliberately generous: a template's head and each
 * span, a type wrapper's expression (`as`, `as const`, `satisfies`, `!`,
 * `<T>x`), a spread's or an element access's expression (`[...B]`, `TONE[t]`,
 * `o?.a` — the object side only, same as a plain property access), a
 * ternary's two branches, `cond && '…'`'s right side, `a || b`'s and `a ?? b`'s
 * both sides, `a + b`'s both sides, an array's elements, an object literal's
 * string-literal keys and every value (`clsx({ 'text-xs': c })`), `X.join(…)`'s
 * `X`, a class-combiner call's arguments, a call resolving to a local
 * function's return expressions only (never its whole body), any other
 * call's arguments and (for a method call) the object it is called on, and a
 * name's resolved declaration(s). A comparison (`=== !== == != < > <= >= in
 * instanceof`) and a function body not reached through the call case above
 * are the two shapes this still refuses: `const active = x === 'underline'`
 * referenced at a class site counts nothing, and a bare reference to a
 * function that is never called does not have its body opened. A property
 * access reads only its object side (`styles.fileRow`'s `styles`, itself
 * rarely resolvable) and never its `.name` as though it were a bare
 * reference — `fileRow` is a property here, not a variable — except when the
 * object is a namespace import, where `.name` is exactly the exported name
 * being asked for.
 *
 * A name is counted once, at its declaration, however many times or files
 * use it: `countedDefs` is a set of `file::pos` already resolved — the
 * declaration's own position, not its name, so two components each
 * declaring `const tone` (two declarations) are not mistaken for one, and a
 * shadowed inner `const tone` is not mistaken for the outer one — shared
 * across every class site this walks in one audit run. Every *direct*
 * literal (typed at the class site itself, not reached through a name) is
 * still counted at every occurrence: two screens copying the same string by
 * hand is two copies, not one shared declaration.
 *
 * `file` on each result names where its token's declaration actually lives —
 * the current file for a direct literal or a same-scope declaration, the
 * imported module for one resolved across files — so the caller can label
 * the finding at its definition rather than at whichever site happened to
 * trigger it.
 *
 * `visitedCalls` guards the one way a `cn`/`clsx`/`cx` call can otherwise be
 * read twice: `classSiteEntries` finds it directly, wherever it sits in the
 * file, and a `className` that names the `const` it was assigned to reaches
 * the identical call node a second time by resolving that name. The set
 * remembers a call node once either path has read its arguments, so a
 * `const rowClass = cn('rounded-full')` used as `className={rowClass}`
 * counts `rounded-full` once, not twice.
 */
/** A function's return values only — the expression body of an arrow
 * function with no block, or every `return`'s expression inside one,
 * without crossing into a nested function's own returns. */
const returnExpressionsOf = (fn) => {
  if (!fn.body) return []
  if (!ts.isBlock(fn.body)) return [fn.body]
  const expressions = []
  const visit = (node) => {
    if (node !== fn.body && ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression)
    ts.forEachChild(node, visit)
  }
  visit(fn.body)
  return expressions
}

/** `=== !== == != < > <= >= in instanceof` — a comparison's operands are
 * never a class list (`x === 'underline'` must count nothing), so these are
 * excluded explicitly rather than left to fall through to the fallback by
 * accident. */
const COMPARISON_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InKeyword, ts.SyntaxKind.InstanceOfKeyword,
])

const classSiteTokens = (node, file, ast, countedDefs, out, visitedCalls) => {
  if (
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
  ) {
    for (const piece of node.text.split(/\s+/)) if (piece) out.push({ text: piece, file })
    return
  }
  if (ts.isTemplateExpression(node)) {
    classSiteTokens(node.head, file, ast, countedDefs, out, visitedCalls)
    for (const span of node.templateSpans) {
      classSiteTokens(span.expression, file, ast, countedDefs, out, visitedCalls)
      classSiteTokens(span.literal, file, ast, countedDefs, out, visitedCalls)
    }
    return
  }
  // A type wrapper (`as`, `as const`, `satisfies`, `!`, `<T>x`), a spread
  // (`[...B]`), and an element access (`TONE[t]`, `o?.a`) all name their one
  // interesting child the same way: `.expression`. An element access's index
  // is not walked, the same reason a property access's `.name` is not below
  // — `t` in `TONE[t]` selects which of `TONE`'s values applies, it is not
  // itself one.
  if (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isSpreadElement(node) || ts.isElementAccessExpression(node)
  ) {
    classSiteTokens(node.expression, file, ast, countedDefs, out, visitedCalls)
    return
  }
  if (ts.isConditionalExpression(node)) {
    classSiteTokens(node.whenTrue, file, ast, countedDefs, out, visitedCalls)
    classSiteTokens(node.whenFalse, file, ast, countedDefs, out, visitedCalls)
    return
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    // `done && 'text-(--hd-secondary-foreground)'` — a ternary missing its
    // "else" — reads only the guarded side; `||`, `??` and `+` read both,
    // since either side (or both, concatenated) can be the live value.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      classSiteTokens(node.right, file, ast, countedDefs, out, visitedCalls)
      return
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
      classSiteTokens(node.left, file, ast, countedDefs, out, visitedCalls)
      classSiteTokens(node.right, file, ast, countedDefs, out, visitedCalls)
      return
    }
    // A comparison, or any other operator (bitwise, arithmetic besides `+`)
    // — none of these build a class list, comparison or not.
    return
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) classSiteTokens(element, file, ast, countedDefs, out, visitedCalls)
    return
  }
  // `clsx({ 'text-xs': c })`: a string-literal key is itself a class,
  // whichever value decides whether it applies; every value is still walked,
  // since a nested `clsx`/ternary/etc. inside one is legible the same way.
  // An identifier key (`{ active: true }`) is not a string literal and is
  // not yielded — most single-word identifiers are not meant as a class.
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        if (ts.isStringLiteral(property.name)) classSiteTokens(property.name, file, ast, countedDefs, out, visitedCalls)
        else if (ts.isComputedPropertyName(property.name) && ts.isStringLiteral(property.name.expression)) {
          classSiteTokens(property.name.expression, file, ast, countedDefs, out, visitedCalls)
        }
        classSiteTokens(property.initializer, file, ast, countedDefs, out, visitedCalls)
      } else if (ts.isShorthandPropertyAssignment(property)) {
        classSiteTokens(property.name, file, ast, countedDefs, out, visitedCalls)
      } else if (ts.isSpreadAssignment(property)) {
        classSiteTokens(property.expression, file, ast, countedDefs, out, visitedCalls)
      }
    }
    return
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') {
    classSiteTokens(node.expression.expression, file, ast, countedDefs, out, visitedCalls)
    return
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_COMBINERS.has(node.expression.text)) {
    if (visitedCalls.has(node)) return
    visitedCalls.add(node)
    for (const argument of node.arguments) classSiteTokens(argument, file, ast, countedDefs, out, visitedCalls)
    return
  }
  // A call to a local helper (`classFor(k)`) — its return expressions only,
  // never the rest of its body, and counted once at the function's own
  // declaration the same way a name is.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !CLASS_COMBINERS.has(node.expression.text)) {
    const local = nearestDeclaration(node.expression, node.expression.text)
    const fn = local?.nodes.find((value) => ts.isArrowFunction(value) || ts.isFunctionExpression(value))
    if (fn) {
      const key = `${file}::${local.pos}`
      if (!countedDefs.has(key)) {
        countedDefs.add(key)
        for (const expression of returnExpressionsOf(fn)) classSiteTokens(expression, file, ast, countedDefs, out, visitedCalls)
      }
      return
    }
  }
  // Any other call — `twMerge(...)`, `buttonVariants({ className })`,
  // `String(x)`, `.filter(Boolean)` on the way to a `.join` this already
  // understands — is opaque itself, but its arguments and (for a method
  // call) the object it is called on are still read.
  if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression)) {
      classSiteTokens(node.expression.expression, file, ast, countedDefs, out, visitedCalls)
    }
    for (const argument of node.arguments) classSiteTokens(argument, file, ast, countedDefs, out, visitedCalls)
    return
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (ts.isIdentifier(node.expression)) {
      const nsSpec = namespaceImportSpec(ast, node.expression.text)
      if (nsSpec) {
        const modulePath = resolveConstModule(file, nsSpec)
        const resolved = modulePath && isScreenTsx(modulePath) ? exportedValueIn(modulePath, node.name.text) : null
        if (resolved) {
          const key = `${resolved.file}::${resolved.pos}`
          if (!countedDefs.has(key)) {
            countedDefs.add(key)
            for (const value of resolved.nodes) classSiteTokens(value, resolved.file, resolved.ast, countedDefs, out, visitedCalls)
          }
        }
        return
      }
    }
    classSiteTokens(node.expression, file, ast, countedDefs, out, visitedCalls)
    return
  }
  if (ts.isIdentifier(node)) {
    const resolved = resolveClassConst(node, file, ast)
    if (!resolved) return
    const key = `${resolved.file}::${resolved.pos}`
    if (countedDefs.has(key)) return
    countedDefs.add(key)
    for (const value of resolved.nodes) classSiteTokens(value, resolved.file, resolved.ast, countedDefs, out, visitedCalls)
    return
  }
  // Fallback: walk the children generically, the way the pre-round-3 walker
  // always did, with one exception — a function-like node reached this way
  // (a bare reference to a function that is never called, say) is not
  // entered. The one other exception, a comparison, is already handled
  // above and never reaches here.
  if (ts.isFunctionLike(node)) return
  ts.forEachChild(node, (child) => classSiteTokens(child, file, ast, countedDefs, out, visitedCalls))
}

/** Every class site's entries, `{ text, file }`, across a whole screen file. */
const classSiteEntries = (ast, file, countedDefs) => {
  const out = []
  const visitedCalls = new Set()
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'className') {
      let expr = node.initializer
      if (expr && ts.isJsxExpression(expr)) expr = expr.expression
      if (expr) classSiteTokens(expr, file, ast, countedDefs, out, visitedCalls)
      return
    }
    if (ts.isPropertyAssignment(node)) {
      const keyText = ts.isIdentifier(node.name) ? node.name.text : ts.isStringLiteral(node.name) ? node.name.text : null
      if (keyText === 'className') {
        classSiteTokens(node.initializer, file, ast, countedDefs, out, visitedCalls)
        return
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_COMBINERS.has(node.expression.text)) {
      classSiteTokens(node, file, ast, countedDefs, out, visitedCalls)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return out
}

/**
 * Appearance a screen draws with a Tailwind utility instead of composing it —
 * the `className` half of the split the module comment above describes.
 *
 * `ast` may be a tree already parsed for this file — the caller shares one
 * parse across this, `screenInlineStyleAppearanceOf`, `screenUnmappedUtilityOf`
 * and `screenUtilityUnclassifiedOf` — and `countedDefs` may be a set shared
 * across every file in one audit run, so a name resolved while scanning one
 * screen is not counted again reached from another. Fixtures pass neither:
 * each gets its own parse and its own empty set, so one test's resolutions
 * never leak into the next.
 */
export const screenUtilityAppearanceOf = (file, source, ast, countedDefs = new Set()) => {
  if (!isScreenTsx(file)) return []
  return utilityAppearanceIn(file, source, ast, countedDefs)
}

/* The classification itself, without the question of whose file this is:
   a screen's, or a pattern only one screen family consumes. */
const utilityAppearanceIn = (file, source, ast, countedDefs = new Set()) => {
  const tree = ast ?? parseScreenSource(file, source)
  const findings = []
  for (const { text: rawToken, file: originFile } of classSiteEntries(tree, file, countedDefs)) {
    const token = withoutImportantMarker(utilityBase(rawToken))
    if (!token) continue
    const declaration = screenUtilityDeclarationOf(token)
    if (declaration && screenPropertySideOf(declaration.property, declaration.value) === 'appearance') {
      findings.push(`${screenAppearanceName(originFile)}: ${rawToken} (${declaration.property})`)
    }
  }
  return findings
}

/**
 * A utility mapped to a real property that is on neither side of the screen
 * boundary — reachable today only through the `[prop:value]`
 * arbitrary-property escape hatch naming something `APPEARANCE_PROPERTIES`
 * and `LAYOUT_BEHAVIOUR_PROPERTIES` do not track, such as `[text-indent:2px]`.
 * Held to the same strict zero a stylesheet's own `screenUnclassifiedOf` is:
 * the boundary is total, or it silently is not.
 */
export const screenUtilityUnclassifiedOf = (file, source, ast) => {
  if (!isScreenTsx(file)) return []
  const tree = ast ?? parseScreenSource(file, source)
  const findings = []
  for (const { text: rawToken, file: originFile } of classSiteEntries(tree, file, new Set())) {
    const token = withoutImportantMarker(utilityBase(rawToken))
    if (!token) continue
    const declaration = screenUtilityDeclarationOf(token)
    if (declaration && screenPropertySideOf(declaration.property, declaration.value) === 'unclassified') {
      findings.push(`${screenAppearanceName(originFile)}: ${rawToken} (${declaration.property})`)
    }
  }
  return findings
}

/** The utilities `screenUtilityAppearanceOf` saw but could not classify,
 * worth a human's attention without being counted. See `--verbose`. Not
 * deduplicated by definition the way the counted list is: a hint repeated
 * from more than one call site is still worth seeing at each. */
export const screenUnmappedUtilityOf = (file, source, ast) => {
  if (!isScreenTsx(file)) return []
  const tree = ast ?? parseScreenSource(file, source)
  const findings = []
  for (const { text: rawToken, file: originFile } of classSiteEntries(tree, file, new Set())) {
    const token = withoutImportantMarker(utilityBase(rawToken))
    if (!token || screenUtilityDeclarationOf(token)) continue
    if (looksLikeUnmappedAppearanceUtility(token)) findings.push(`${screenAppearanceName(originFile)}: ${rawToken}`)
  }
  return findings
}

const unwrapStyleExpression = (node) => {
  let current = node
  while (
    current
    && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current))
  ) {
    current = current.expression
  }
  return current
}

/** `backgroundColor` → `background-color`, `WebkitTransform` → `-webkit-transform`
 * (a leading capital becomes a leading hyphen, which is exactly the vendor
 * prefix `screenPropertySideOf`'s `unprefixedProperty` already strips). A key
 * already spelled `--near` is a custom property name, not camelCase, and is
 * returned as written. */
const cssPropertyOfStyleKey = (key) => (key.startsWith('--') ? key : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`))

/** A style object's own properties: a plain `key: value`, a `{ color }`
 * shorthand (the value is a variable this does not chase — the property
 * alone still says which side of the boundary it is on), and `['color']`, a
 * computed key that is itself a literal. A truly dynamic computed key
 * (`[someVar]`) names nothing this can read and is skipped, the same as a
 * dynamic `className` reference. */
const styleObjectFindings = (object) => {
  const findings = []
  for (const property of object.properties) {
    let key = null
    let valueNode = null
    if (ts.isPropertyAssignment(property)) {
      const keyNode = property.name
      key = ts.isIdentifier(keyNode) ? keyNode.text
        : ts.isStringLiteral(keyNode) ? keyNode.text
        : ts.isComputedPropertyName(keyNode) && ts.isStringLiteral(keyNode.expression) ? keyNode.expression.text
        : null
      valueNode = property.initializer
    } else if (ts.isShorthandPropertyAssignment(property)) {
      key = property.name.text
    }
    if (key === null) continue
    const cssProperty = cssPropertyOfStyleKey(key)
    // A dynamic height-family value (not a literal this can read) is decided
    // explicitly as layout, not left to fall through the empty-string path:
    // `GitPane.tsx`'s `height: total * ROW` is a virtual list doing its own
    // scroll-height arithmetic, not a control's metric, and the value rule
    // that tells a real metric from a reset or a share has nothing to read
    // when there is no literal at all. This is the opposite default from a
    // utility's `` `h-${n}` `` above, where the prefix itself still names a
    // metric even with an unknown suffix; a `style` key has no such prefix.
    const literal = valueNode && ts.isStringLiteral(valueNode) ? valueNode.text
      : valueNode && ts.isNumericLiteral(valueNode) ? valueNode.text
      : null
    if (literal === null && (cssProperty === 'height' || cssProperty === 'min-height' || cssProperty === 'max-height')) continue
    if (screenPropertySideOf(cssProperty, literal ?? '') === 'appearance') findings.push(`style ${cssProperty}`)
  }
  return findings
}

/**
 * Appearance a screen draws with an inline `style` object instead of
 * composing it — the third spelling of the same boundary. A literal
 * `style={{ … }}` is legible this way, including through a `satisfies
 * CSSProperties` assertion, a `c ? {…} : {…}` conditional and a `s ?? {…}`
 * fallback (both sides of either read) and a `c && {…}` guard (its right
 * side read the same way a conditional's branch is); and so is `style={S}`,
 * an object `const` resolved the same way a class site's name is — the
 * nearest enclosing scope, or one or more hops through an import to the file
 * that declares it. A dynamic reference this cannot resolve — a prop, a
 * parameter, anything not a `const` reachable that way — is not counted,
 * the same way a dynamic `className` reference is not (`classNameIsStatic`
 * in `ui-architecture.mjs` draws the identical line for the same reason).
 */
export const screenInlineStyleAppearanceOf = (file, source, ast) => {
  if (!isScreenTsx(file)) return []
  return inlineStyleAppearanceIn(file, source, ast)
}

const inlineStyleAppearanceIn = (file, source, ast) => {
  const tree = ast ?? parseScreenSource(file, source)
  const findings = []
  const stylesIn = (expression) => {
    const resolved = unwrapStyleExpression(expression)
    if (!resolved) return
    if (ts.isObjectLiteralExpression(resolved)) { findings.push(...styleObjectFindings(resolved)); return }
    if (ts.isConditionalExpression(resolved)) { stylesIn(resolved.whenTrue); stylesIn(resolved.whenFalse); return }
    if (ts.isBinaryExpression(resolved) && resolved.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      stylesIn(resolved.right)
      return
    }
    if (ts.isBinaryExpression(resolved) && resolved.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      stylesIn(resolved.left)
      stylesIn(resolved.right)
      return
    }
    if (ts.isIdentifier(resolved)) {
      const declaration = resolveClassConst(resolved, file, tree)
      if (declaration) for (const value of declaration.nodes) stylesIn(value)
    }
  }
  const visit = (node) => {
    if (
      ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'style'
      && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression
    ) {
      stylesIn(node.initializer.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return findings
}

/**
 * The appearance a design module's own source draws — its className
 * utilities and its inline style keys — by exactly the classification a
 * screen's are. Counted only for a module one screen family consumes (see
 * the single-area pass below): such a pattern is that screen's code moved
 * into `design/`, and moving a drawing is not composing it. Before this, the
 * pass read only the module's stylesheet, so appearance written as Tailwind
 * in a single-consumer pattern left the ledger without converging (#912).
 */
export const patternSourceAppearanceOf = (file, source, ast, countedDefs = new Set()) => [
  ...utilityAppearanceIn(file, source, ast, countedDefs),
  ...inlineStyleAppearanceIn(file, source, ast).map((detail) => `${screenAppearanceName(file)}: ${detail}`),
]

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
    for (const { property } of screenAppearanceOf(file, read(file))) {
      findings.screenAppearance.push(`${name}: ${property}`)
    }
    for (const { property } of screenUnclassifiedOf(file, read(file))) {
      findings.screenUnclassified.push(`${name}: ${property}`)
    }
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
    for (const union of visualKindUnionsOf(codeOf(file))) {
      findings.visualKindUnion.push(
        `${label(file)}: ${union.prop}: ${union.type} has ${union.count} visual kinds (maximum 8)`,
      )
    }
  }
}

/** Named values re-exported by the public design entrypoint, by their module. */
const publicDesignExports = () => {
  const entry = path.join(UI_SRC, 'design', 'index.ts')
  const byName = new Map()
  const source = codeOf(entry)
  for (const match of source.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const module = path.resolve(path.dirname(entry), `${match[2]}.tsx`)
    for (const part of match[1].split(',')) {
      const words = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
      const publicName = words.at(-1)?.trim()
      if (publicName) byName.set(publicName, module)
    }
  }
  return byName
}

/** Named imports from the public design entrypoint in one screen source. */
const publicDesignImports = (file) => {
  const names = []
  for (const match of codeOf(file).matchAll(/\bimport\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = match[2]
    const resolved = spec.startsWith('@/')
      ? path.join(UI_SRC, spec.slice(2))
      : path.resolve(path.dirname(file), spec)
    if (resolved !== path.join(UI_SRC, 'design')) continue
    for (const part of match[1].split(',')) {
      const imported = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
      if (imported) names.push(imported)
    }
  }
  return names
}

/*
 * A pattern consumed by one screen family is still screen code when it moves
 * under `design/`. Count its stylesheet on the same appearance ledger as the
 * family that owns it. This is a burn-down rather than a blanket refusal:
 * layout may legitimately live with a typed cross-screen renderer, while its
 * copied type, ink, ground and inner box remain an honest part of the screen
 * appearance count.
 */
const exportedFrom = publicDesignExports()
const consumersByModule = new Map()
const screenSources = tsxFiles().filter((candidate) => isScreenSheet(candidate))
const importersByFile = new Map()
for (const importer of screenSources) {
  for (const match of codeOf(importer).matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    const spec = match[1]
    if (!spec.startsWith('.') && !spec.startsWith('@/')) continue
    const base = spec.startsWith('@/')
      ? path.join(UI_SRC, spec.slice(2))
      : path.resolve(path.dirname(importer), spec)
    const imported = base.endsWith('.tsx') ? base : `${base}.tsx`
    if (!tracked.has(imported) || !isScreenSheet(imported)) continue
    importersByFile.set(imported, [...(importersByFile.get(imported) ?? []), importer])
  }
}
for (const file of screenSources) {
  for (const name of publicDesignImports(file)) {
    const module = exportedFrom.get(name)
    if (!module) continue
    consumersByModule.set(module, [...(consumersByModule.get(module) ?? []), file])
  }
}
const patternCountedDefs = new Set()
for (const [module, consumers] of consumersByModule) {
  const area = singleScreenAreaOf(consumers, importersByFile)
  if (!area) continue
  const sheet = module.replace(/\.tsx$/, '.module.css')
  if (tracked.has(sheet)) {
    for (const { property } of declarationsOf(read(sheet)).filter(
      ({ property, value }) => screenPropertySideOf(property, value) === 'appearance',
    )) {
      findings.screenAppearance.push(`${label(sheet)} [${area} screen area]: ${property}`)
    }
  }
  if (tracked.has(module)) {
    for (const line of patternSourceAppearanceOf(module, read(module), undefined, patternCountedDefs)) {
      const at = line.lastIndexOf(': ')
      findings.screenAppearance.push(`${line.slice(0, at)} [${area} screen area]: ${line.slice(at + 2)}`)
    }
  }
}

// Shared across the whole run so a class constant resolved while scanning
// one screen file is not counted again when another screen imports it —
// see `classSiteTokens`. A fixture never touches this: each of
// `screenUtilityAppearanceOf` and `screenUnmappedUtilityOf` defaults to a
// set of its own when the caller does not share one.
const screenClassConstDefs = new Set()

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
  // A dialog's footer is read from the syntax tree, every branch of it: its
  // rule is about the buttons together, and the source keeps its comments
  // for a parser that understands them (the stripped text broke on a URL).
  for (const hit of footerOffenders(source, name)) findings.wrongVariant.push(hit)

  /** Local binding → the classes that stylesheet declares. */
  const { sheets, crossImports } = sheetsOf(dir, file, name, source, UI_SRC)
  findings.crossImport.push(...crossImports)

  // Appearance the screen drew as a Tailwind utility or an inline `style`
  // instead of its `.module.css` — the other two spellings of the same
  // boundary `screenAppearanceOf` reads a stylesheet for. One ceiling: both
  // land on `findings.screenAppearance` beside the CSS-declared kind.
  //
  // Parsed once and shared across all three: each independently defaulted to
  // parsing the file itself, so every screen file was read into a tree three
  // separate times for no reason three different walks needed their own.
  // `screenUtilityAppearanceOf` and `screenUnmappedUtilityOf` already carry
  // the file a resolved token's declaration lives in, so they push a fully
  // labelled line themselves; `screenInlineStyleAppearanceOf` never crosses a
  // file (a `style` object is not resolved across an import) and still
  // returns the bare detail for `name` to prefix here.
  const screenAst = isScreenTsx(file) ? parseScreenSource(file, source) : undefined
  findings.screenAppearance.push(...screenUtilityAppearanceOf(file, source, screenAst, screenClassConstDefs))
  for (const detail of screenInlineStyleAppearanceOf(file, source, screenAst)) findings.screenAppearance.push(`${name}: ${detail}`)
  findings.unmappedScreenUtility.push(...screenUnmappedUtilityOf(file, source, screenAst))
  // Held to the same strict zero a stylesheet's own unclassified property is:
  // an arbitrary-property utility naming something on neither side of the
  // boundary (`[text-indent:2px]`) is not silently uncounted.
  findings.screenUnclassified.push(...screenUtilityUnclassifiedOf(file, source, screenAst))

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
    if (verbose && key === 'screenAppearance') {
      const bySheet = new Map()
      for (const line of list) {
        const sheet = line.slice(0, line.lastIndexOf(': '))
        bySheet.set(sheet, (bySheet.get(sheet) ?? 0) + 1)
      }
      for (const [sheet, count] of [...bySheet].sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b))) {
        console.log(`        ${sheet}: ${count}`)
      }
    } else if (verbose) for (const line of list) console.log(`        ${line}`)
    else for (const line of list.slice(0, 3)) console.log(`        ${line}`)
    if (!verbose && list.length > 3) console.log(`        … ${list.length - 3} more (--verbose)`)
    console.log('')
  }

  // Outside SECTIONS on purpose: a hint for whoever next extends
  // `screenUtilityDeclarationOf`, never a second strict category.
  if (verbose && findings.unmappedScreenUtility.length > 0) {
    console.log(`${String(findings.unmappedScreenUtility.length).padStart(4)}  Unmapped utility (not counted; looks like appearance)`)
    for (const line of findings.unmappedScreenUtility) console.log(`        ${line}`)
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
