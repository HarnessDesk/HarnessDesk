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
 * an escaped CR LF ended a string early (#762 review).
 */
const preprocess = (text) => text.replace(/\r\n?|\f/g, '\n')

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

/* Whether a `url(` token opens at `index` — the function name itself, not the
   end of some longer identifier. */
const urlAt = (text, index) =>
  (text[index] === 'u' || text[index] === 'U') &&
  /^url\(/i.test(text.slice(index, index + 4)) &&
  !(index > 0 && /[\w-]/.test(text[index - 1]))

/**
 * Strip comments so prose about a value is not counted as the value.
 *
 * Only real comments. This was one pattern over the raw text, so a `/*`
 * inside a string opened a "comment" that ran to the next `*\/` anywhere —
 * `content: "/*"; color: red; content: "*\/"` lost the `color` between them,
 * and a raw colour slipped past the audit (#762 review). So it scans: strings
 * are copied whole, and an unquoted `url(...)` is copied through its `)`,
 * because the grammar reads everything there as the address — a `/*` inside
 * one is part of a path, not a comment.
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
    } else if (urlAt(css, index)) {
      let open = index + 4
      while (/\s/.test(css[open] ?? '')) open += 1
      if (css[open] === '"' || css[open] === "'") {
        out += css.slice(index, open)
        index = open
      } else {
        const end = unquotedUrlEnd(css, open)
        out += css.slice(index, end)
        index = end
      }
    } else {
      out += char
      index += 1
    }
  }
  return out
}

/*
 * A value with its strings and every `url(...)` blanked — what is left is what
 * the value itself says. A URL's payload is an image or a reference, never a
 * colour of this stylesheet's, however much it looks like one; and the
 * closing paren is found by depth outside strings, so a quoted payload that
 * holds `translate(1)` does not end the URL early and leave its tail exposed
 * (#762 review).
 */
const plainOf = (raw) => {
  const value = preprocess(raw)
  let out = ''
  let index = 0
  while (index < value.length) {
    const char = value[index]
    if (char === '"' || char === "'") {
      out += ' '
      index = stringEnd(value, index)
    } else if (urlAt(value, index)) {
      let depth = 0
      let at = index + 3
      while (at < value.length) {
        const inner = value[at]
        if (inner === '\\') {
          at += 2 // an escaped paren is part of the address, not its end
          continue
        }
        if (inner === '"' || inner === "'") {
          at = stringEnd(value, at)
          continue
        }
        if (inner === '(') depth += 1
        else if (inner === ')' && (depth -= 1) === 0) {
          at += 1
          break
        }
        at += 1
      }
      out += ' '
      index = at
    } else {
      out += char
      index += 1
    }
  }
  return out
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
 * declaration only outside a string and outside parentheses. A pattern took
 * the first one it met, so `content: "status: #fff; ready"` became the value
 * `"status: #fff` — a raw colour, on valid CSS — and an unquoted
 * `url(data:…;…)` would have split the same way (#762 review). A `{` outside a
 * string ends whatever came before it, which is a selector or an at-rule's
 * prelude — so `a:hover` never parses as a declaration. The last declaration
 * in a block needs no semicolon. Vendor prefixes and custom properties are
 * declarations like any other.
 */
export const declarationsOf = (css) => {
  const text = bare(css)
  const found = []
  let buffer = ''
  const flush = () => {
    const declaration = splitDeclaration(buffer)
    if (declaration) found.push(declaration)
    buffer = ''
  }
  let depth = 0
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'") {
      // the same notion of a string as `bare` and `plainOf` — one definition
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
    index += 1
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && char === '{') {
      buffer = ''
      continue
    } else if (depth === 0 && (char === ';' || char === '}')) {
      flush()
      continue
    }
    buffer += char
  }
  flush()
  return found
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
      const property = raw.slice(0, index).trim()
      if (!/^(?:--[\w-]+|-?[A-Za-z][\w-]*)$/.test(property)) return null
      const value = raw.slice(index + 1).replace(/\s*!\s*important\s*$/i, '').trim()
      return value === '' ? null : { property, value }
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
/* A whole identifier, any case — not part of `--hd-red` or `darkred-ish`, and
   not a function: `tan(45deg)` is trigonometry, not the colour. */
const NAMED = new RegExp(`(?<![-\\w#])(?:${NAMED_COLOURS.join('|')})(?![-\\w])(?!\\s*\\()`, 'i')

/* Properties whose values are names an author chose — a keyframes rule, a
   grid area, a counter, a font family, a container. A colour word there is an
   identifier, not a colour: `animation: red 1s` is a keyframes rule called
   `red`. Only the named-colour check stands aside for these; a hex or a colour
   function is a colour wherever it is written. Like the mask exemption, a list
   of exceptions: one missing from it shows up as a finding someone reads. */
const AUTHOR_NAMES =
  /^(?:animation(?:-name|-timeline)?|font(?:-family)?|grid(?:-area|-template(?:-areas)?|-(?:row|column)(?:-start|-end)?)?|counter-(?:reset|increment|set)|list-style(?:-type)?|container(?:-name)?|view-transition-name|anchor-name|position-anchor|timeline-scope|(?:scroll|view)-timeline(?:-name)?)$/

/** Whether a value writes a colour out: hex, a colour function or a named colour, outside `url()` and strings. */
export const rawColourIn = (value, { names = true } = {}) => {
  const plain = plainOf(value)
  return (
    /#[0-9a-fA-F]{3,8}\b/.test(plain) ||
    /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(plain) ||
    (names && NAMED.test(plain))
  )
}

/** Declarations that write a colour out, custom properties included. */
export const rawColours = (css) =>
  declarationsOf(css).filter(
    ({ property, value }) =>
      !ALPHA_ONLY.test(property) && rawColourIn(value, { names: !AUTHOR_NAMES.test(property) }),
  )

/** `z-index` written as a number in the shared band — 10 and up; `!important` does not hide one. */
export const rawZIndexes = (css) =>
  declarationsOf(css).filter(
    ({ property, value }) => property === 'z-index' && /^-?\d+$/.test(value) && Math.abs(Number(value)) >= 10,
  )

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
  for (const { property, value } of rawColours(css)) {
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
  for (const { value } of rawZIndexes(css)) findings.rawZIndex.push(`${name}: z-index: ${value}`)

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
