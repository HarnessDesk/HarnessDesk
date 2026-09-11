/**
 * Where the interface has stepped outside its own system.
 *
 * A design system that is only written down is a design system that gets
 * copied wrong, because the next screen is built by imitating the nearest
 * file rather than by reading a document. This counts the places where that
 * has already happened, so the drift is a number that can be driven to zero
 * instead of a feeling that things look a bit inconsistent.
 *
 * It reports; it does not fail. The findings below are the state of the app
 * as it stands, and fixing them is a migration to be done deliberately —
 * `--strict` fails on anything worse than the recorded baseline, which is how
 * this becomes a gate once the burn-down starts.
 *
 *   node script/design-audit.mjs            report
 *   node script/design-audit.mjs --strict   fail if worse than the baseline
 *   node script/design-audit.mjs --baseline rewrite the baseline
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SECTIONS } from './design-sections.mjs'
import { resolveTokens } from './design-tokens.mjs'
import { attributes, slotOffenders } from './design-usage.mjs'
import { bareSource, ownsStylesheet, resolveStylesheet, stylesheetImports } from './lib/stylesheet-imports.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPONENTS = path.join(root, 'packages/ui/src/components')
const BASELINE = path.join(root, 'packages/ui/src/design/audit-baseline.json')

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

/**
 * The foundation is not a screen, and must not be audited as one.
 *
 * `styles/` and the `design/` root are where tokens are declared — that is
 * their entire job, and `forkedToken` exists to stop a *screen* doing it. The
 * platform stylesheet in `styles/` is vendored besides, so its raw values are
 * upstream's to spell.
 */
const NOT_UI = new Set([path.join(UI_SRC, 'styles'), path.join(UI_SRC, 'design')])

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

const read = (file) => fs.readFileSync(file, 'utf8')
/** Where a finding is, said the way a person would look for it. */
const label = (file) => path.relative(path.join(root, 'packages/ui/src'), file)
const filesIn = (suffix, reject = () => false) =>
  DIRS.filter((dir) => fs.existsSync(dir)).flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(suffix) && !reject(name))
      .map((name) => path.join(dir, name)),
  )
const cssFiles = () => filesIn('.css')
const tsxFiles = () => filesIn('.tsx', (name) => name.includes('.test.'))

/** Strip comments so prose about a value is not counted as the value. */
const bare = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

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
  rawColour: [],
  arbitraryUtility: [],
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
const ICON_MODULES = new Set(['Icons.tsx', 'BrandIcons.tsx', 'spark.tsx'])

/** Where the primitives live: the one place allowed to define an overlay. */
const PRIMITIVES = path.join(root, 'packages/ui/src/design/primitives')

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

  // A colour written out rather than named — in a real property, and in a
  // custom property, which is where one hides. A literal behind `--row-tint`
  // follows a theme change exactly as badly as one written in place, and until
  // this the checks could not see it at all.
  const raw = (value) => /#[0-9a-fA-F]{3,8}\b/.test(value) || /\brgba?\(/.test(value)
  for (const match of css.matchAll(
    /(?<![-\w])(color|background|background-color|border-color|fill)\s*:\s*([^;]+);/g,
  )) {
    const value = match[2].trim()
    if (raw(value)) findings.rawColour.push(`${name}: ${value.slice(0, 48)}`)
  }
  for (const match of css.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const value = match[2].trim()
    if (raw(value)) findings.rawColour.push(`${name}: ${match[1]}: ${value.slice(0, 40)}`)
  }

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
const classesOf = (cssPath) => {
  const names = new Set()
  for (const hit of bare(read(cssPath)).matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) names.add(hit[1])
  return names
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

/** `class` → the px of a rule that declares an equal literal width and height. */
export const squaresOf = (cssPath) => {
  const out = new Map()
  for (const rule of bare(read(cssPath)).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const width = /(?:^|;|\s)width:\s*(\d+)px/.exec(rule[2])
    const height = /(?:^|;|\s)height:\s*(\d+)px/.exec(rule[2])
    if (!width || !height || width[1] !== height[1]) continue
    // The selector's *subject*, which is its last class: `.tray .tabClose`
    // is a rule about `tabClose`. Taking the first match filed it under
    // `tray`, so the button carrying `styles.tabClose` found nothing and an
    // undersized target went uncounted.
    const classes = [...rule[1].trim().split('\n').pop().matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)]
    const name = classes[classes.length - 1]
    if (name) out.set(name[1], Number(height[1]))
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
    for (const match of bare(read(file)).matchAll(ARBITRARY)) {
      findings.arbitraryUtility.push(`${label(file)}: ${match[0]}`)
    }
  }
}

for (const file of tsxFiles()) {
  const name = label(file)
  const dir = path.dirname(file)
  const source = read(file)

  // An overlay built beside the system rather than out of it.
  //
  // This is the rule the audit could not previously catch, and the one that
  // cost the most: `aria-modal` outside `design/primitives` means a screen has
  // answered where the buttons go, what Escape does, what a click outside
  // does and where focus returns — five decisions, made again, and usually at
  // least one of them made by omission.
  //
  // The recorded baseline is the four surfaces that are deliberately not
  // dialogs. It is a ceiling, not a target: a fifth is new drift.
  const code = bareSource(source)
  if (dir !== PRIMITIVES && /aria-modal/.test(code)) {
    findings.handRolledOverlay.push(`${name}: aria-modal outside design/primitives`)
  }

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
  const sheets = new Map()
  // A file may draw from its own stylesheet, or from the one named after the
  // folder it lives in. The second case is a screen that outgrew one file —
  // `explorer/Explorer.tsx` and `explorer/boards.tsx` are one screen sharing
  // `explorer.module.css`, which is the right arrangement, not drift. The rule
  // being enforced is that a screen may not reach into a DIFFERENT screen.
  // The whole source: `stylesheetImports` strips comments itself, and is the one that has to (review of #183, round 7).
  for (const { binding, file: spec } of stylesheetImports(source)) {
    const sheet = resolveStylesheet(dir, spec, UI_SRC)
    // As written, so the finding greps back to its line; resolved beside it when an alias made them differ.
    if (!ownsStylesheet(file, sheet)) findings.crossImport.push(`${name} imports ${spec}${spec === sheet ? '' : ` (${sheet})`}`)
    const target = path.join(dir, sheet)
    if (fs.existsSync(target)) sheets.set(binding, { file: sheet, classes: classesOf(target) })
  }

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
let worse = false
for (const [key, title, , fix] of SECTIONS) {
  const was = baseline[key] ?? 0
  if (counts[key] > was) {
    console.error(`\n${title}: ${was} -> ${counts[key]}. New drift is not accepted.`)
    for (const line of findings[key].slice(0, 6)) console.error(`  ${line}`)
    console.error(`  → ${fix}`)
    worse = true
  }
}
process.exit(worse ? 1 : 0)
}
