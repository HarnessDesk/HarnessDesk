import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withoutComments } from './lib/without-comments.mjs'
import { prose } from './design-doc.mjs'
import * as usage from './design-usage.mjs'
import {
  APPEARANCE_PROPERTIES,
  codeOf,
  compareBaseline,
  createSourceCache,
  declarationsOf,
  NAMED_COLOURS,
  rawColours,
  rawZIndexes,
  looksLikeUnmappedAppearanceUtility,
  screenAppearanceOf,
  screenAreaOf,
  singleScreenAreaOf,
  screenInlineStyleAppearanceOf,
  patternSourceAppearanceOf,
  screenPropertySideOf,
  screenUnclassifiedOf,
  screenUnmappedUtilityOf,
  screenUtilityAppearanceOf,
  screenUtilityDeclarationOf,
  screenUtilityUnclassifiedOf,
  sheetsOf,
  squaresOf,
  STYLESHEET_OWNERS,
  uppercaseLabelsOf,
  visualKindUnionsOf,
} from './design-audit.mjs'
import { SECTIONS } from './design-sections.mjs'
import { brandsIn } from './brands.mjs'
import { ciCommands, gateCommands, missingFromCI } from './check-verify-drift.mjs'
import { DESCRIBED_AS, problemsWith, sectionOf, stepNames } from './check-verify-steps.mjs'
import { ALLOWED, basesFor as docPathBasesFor, pathsIn, problemsWith as docPathProblems } from './check-doc-paths.mjs'
import { checkNotices, installedLicence } from './check-notices.mjs'
import { offendersIn } from './check-secrets.mjs'
import { methodsIn, reachedBy } from './check-reachable.mjs'
import { DOCUMENTATION } from './check-layering.mjs'
import { TEST_GLOB, distSegments, globToRegExp } from './prune-dist.mjs'

/**
 * A clean scan, derived rather than listed.
 *
 * These fixtures used to name every category by hand, which made adding one to
 * the audit break two tests that have nothing to say about it: the fixture was
 * a second copy of the category list, kept in step by whoever noticed. Reading
 * the list the audit itself uses means a new category arrives at zero, where a
 * clean scan is exactly where it should arrive.
 */
const zeroes = () => Object.fromEntries(SECTIONS.map(([key]) => [key, 0]))
import { createSteps } from './lib/steps.mjs'
import { removeTemporaryDirectory } from './lib/temporary-directory.mjs'
import { leadComment } from './design-doc.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('audit source cache reads each present or missing stylesheet once and preserves IO failures', () => {
  const calls = []
  const read = createSourceCache((file) => {
    calls.push(file)
    if (file === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    if (file === 'denied') throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return '.row { display: flex }'
  })
  assert.equal(read('sheet'), read('sheet'))
  assert.equal(read('missing'), null)
  assert.equal(read('missing'), null)
  assert.deepEqual(calls, ['sheet', 'missing'])
  assert.throws(() => read('denied'), /denied/)
})

test('existing stylesheet co-ownership is capped at six families and eleven modules', () => {
  assert.equal(Object.keys(STYLESHEET_OWNERS).length, 6)
  assert.equal(Object.values(STYLESHEET_OWNERS).flat().length, 11)
})

test('single-screen pattern accounting recognizes non-Git screen families', () => {
  const sidebar = path.join(repoRoot, 'packages/ui/src/components/Sidebar.tsx')
  const dashboard = path.join(repoRoot, 'packages/ui/src/components/Usage.tsx')
  assert.equal(screenAreaOf(sidebar), 'sidebar')
  assert.equal(screenAreaOf(dashboard), 'usage')
  assert.equal(singleScreenAreaOf([sidebar]), 'sidebar')
  assert.equal(singleScreenAreaOf([dashboard]), 'usage')
})

test('single-screen pattern accounting groups Git screens but exempts cross-family use', () => {
  const gitPane = path.join(repoRoot, 'packages/ui/src/components/GitPane.tsx')
  const gitDialogs = path.join(repoRoot, 'packages/ui/src/components/GitDialogs.tsx')
  const sidebar = path.join(repoRoot, 'packages/ui/src/components/Sidebar.tsx')
  assert.equal(singleScreenAreaOf([gitPane, gitDialogs]), 'git')
  assert.equal(singleScreenAreaOf([gitPane, sidebar]), null)
})

test('single-screen pattern accounting follows a pattern consumer into its screen hosts', () => {
  const approval = path.join(repoRoot, 'packages/ui/src/components/Approvals.tsx')
  const room = path.join(repoRoot, 'packages/ui/src/components/TeamRoomPane.tsx')
  const builtins = path.join(repoRoot, 'packages/ui/src/panels/builtins.tsx')
  const importers = new Map([[approval, [room, builtins]]])
  assert.equal(singleScreenAreaOf([approval], importers), null)
})

test('the pane registry mounts a screen without making its patterns shared', () => {
  const gitPane = path.join(repoRoot, 'packages/ui/src/components/GitPane.tsx')
  const builtins = path.join(repoRoot, 'packages/ui/src/panels/builtins.tsx')
  // Every pane is registered there; a pattern only GitPane uses is still Git's.
  assert.equal(singleScreenAreaOf([gitPane], new Map([[gitPane, [builtins]]])), 'git')
})

/*
 * A pattern one screen family consumes is that screen's code wherever it
 * lives, so its appearance counts on the same ledger whichever spelling it
 * takes. The stylesheet half was always counted; these hold the other two —
 * a Tailwind utility in the pattern's own className and a key in its inline
 * style — by the same classification a screen's are (#912 review: four
 * single-consumer TurnWork parts moved screen appearance into design/ and the
 * number fell without anything converging).
 */
const patternTsx = (name) => path.join(repoRoot, 'packages/ui/src/design/patterns', name)

test('a single-consumer pattern counts the utilities its own className draws', () => {
  const source = `export const Part = () => <span className="text-(--hd-muted-foreground) tabular-nums flex gap-2" />\n`
  assert.deepEqual(patternSourceAppearanceOf(patternTsx('Part.tsx'), source), [
    'design/patterns/Part.tsx: text-(--hd-muted-foreground) (color)',
    'design/patterns/Part.tsx: tabular-nums (font-variant-numeric)',
  ])
})

test('a single-consumer pattern counts appearance in its inline style, and not its layout or custom properties', () => {
  const source = `export const Part = () => <span style={{ color: 'red', width: 4, '--near': 1 }} />\n`
  assert.deepEqual(patternSourceAppearanceOf(patternTsx('Part.tsx'), source), ['design/patterns/Part.tsx: style color'])
})

test('a pattern reached through cn() and a class constant is read the way a screen is', () => {
  const source = [
    "import { cn } from '@/lib/utils'",
    "const INK = 'text-(--hd-warning-ink)'",
    'export const Part = ({ on }) => <span className={cn(\'shrink-0\', on && INK, \'px-2\')} />',
    '',
  ].join('\n')
  assert.deepEqual(patternSourceAppearanceOf(patternTsx('Part.tsx'), source), [
    'design/patterns/Part.tsx: text-(--hd-warning-ink) (color)',
    'design/patterns/Part.tsx: px-2 (padding-inline)',
  ])
})

test('single-screen patterns leave semantic appearance to system primitives', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'packages/ui/src/design/patterns/GitHistory.module.css'), 'utf8')
  const semantic = declarationsOf(css).filter(({ property }) =>
    property === 'color' || property === 'height' || property === 'min-height' || property.startsWith('padding'),
  )
  assert.deepEqual(semantic, [], 'GitHistory.module.css')

  const turnWork = fs.readFileSync(path.join(repoRoot, 'packages/ui/src/design/patterns/TurnWork.tsx'), 'utf8')
  assert.doesNotMatch(turnWork, /TurnWork\.module\.css/)
  assert.match(turnWork, /quietHover/)
})

test('the browser integration job builds workspace package entries before Vite', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  const browserJob = workflow.match(/^  ui-system-browser:[\s\S]*?(?=^  [a-z][a-z-]+:|\Z)/m)?.[0] ?? ''
  assert.match(browserJob, /run: pnpm run build:node[\s\S]*run: pnpm test:ui-system/)
})

test('UI system gates do not depend on an external ripgrep binary', () => {
  for (const file of ['ui-architecture.mjs', 'ui-catalog.mjs']) {
    const source = fs.readFileSync(path.join(repoRoot, 'script', file), 'utf8')
    assert.doesNotMatch(source, /execFileSync\(['"]rg['"]/, file)
  }
})

test('native evidence cleanup cannot turn a completed run red for a late helper write', () => {
  const busy = Object.assign(new Error('busy'), { code: 'ENOTEMPTY' })
  let warning = ''
  assert.equal(removeTemporaryDirectory('/temporary-rig', {
    remove: () => { throw busy },
    warn: (message) => { warning = message },
  }), false)
  assert.match(warning, /remained busy/)

  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  assert.throws(() => removeTemporaryDirectory('/temporary-rig', {
    remove: () => { throw denied },
  }), denied)
})

/**
 * The gates' own parsers, tested — because both of them were silently wrong
 * and neither could have said so.
 *
 * `check-layering` decides what counts as a comment before it applies nine
 * architectural rules, so a bug there does not fail loudly: it exempts code
 * from every rule in the file. One glob in a fixture — `'src/api/**'` —
 * opened a comment that ran three hundred lines, and a brand name in rendered
 * UI text sat inside that stretch unflagged for as long as it did.
 *
 * `design-doc` decides what a section's prose says, and `--check` only asks
 * whether the committed file matches what the generator produces. A generator
 * that mangles produces a matching mangled file, so the gate is green and the
 * document is wrong. Both failure modes are invisible from the outside, which
 * is exactly the shape of thing that earns a unit test.
 */

test('a glob does not open a comment that swallows the code after it', () => {
  /* The bug this whole test file exists for, and it needs all three lines.
     The glob's `i/` + `*` opens a comment; the *later* block comment closes
     it; everything between the two disappears. Without that third line there
     is no closing delimiter, the broken regex matches nothing, and a test
     written with two lines passes against the bug it exists to catch —
     checked, by reverting the fix and watching it stay green. */
  const source = [
    "const files = ['src/api/**']",
    'const brand = "Codex"',
    '/* an ordinary comment, further down the file */',
  ].join('\n')
  assert.match(withoutComments(source), /Codex/)
})

test('a real comment is still stripped, in every shape it is written', () => {
  const stripped = withoutComments(
    [
      '/* Codex leading */',
      '  /** Codex jsdoc */',
      'const a = 1 // Codex trailing',
      'const b = { /* Codex inline */ c: 1 }',
      'const d = fn(/* Codex arg */)',
      'visible Codex',
    ].join('\n'),
  )
  assert.equal((stripped.match(/Codex/g) ?? []).length, 1, stripped)
  assert.match(stripped, /visible Codex/)
})

test('a URL in a string is not a line comment', () => {
  assert.match(withoutComments("const u = 'https://example.com/Codex'"), /Codex/)
})

test('prose keeps a bold marker and drops a JSDoc gutter', () => {
  /* One asterisk is a gutter; two are Markdown's bold. Stripping one
     unconditionally shipped `*Ink is for what you press.**` into the
     committed doc — the opening of the sentence the solid's section is named
     after.

     The bold has to be tested with **no gutter in front of it**, which is how
     tokens.css actually writes it: a plain indented block whose first prose
     line opens in bold. With a gutter the broken regex eats the gutter and
     leaves the bold alone, so a test written that way passes against the bug
     it exists to catch — checked, by reverting the fix and watching it stay
     green. */
  assert.equal(prose('**Bold.** Then more.'), '**Bold.** Then more.')
  assert.equal(prose(' * **Bold.** Then more.'), '**Bold.** Then more.')
  assert.equal(prose(' * A gutter line.\n * A second one.'), 'A gutter line. A second one.')
  assert.equal(prose('   Plain indented prose.\n   Continued.'), 'Plain indented prose. Continued.')
})

test('prose folds a JSDoc-shaped block into one paragraph without its gutters', () => {
  const block = [
    ' *',
    ' * A page-sized decision about how big a control is.',
    ' *',
    " * `[data-hd-density='comfortable']` is the settings window.",
    ' ',
  ].join('\n')
  assert.equal(
    prose(block),
    "A page-sized decision about how big a control is. `[data-hd-density='comfortable']` is the settings window.",
  )
})

/**
 * The usage table and the gate that reads it.
 *
 * Same class of failure as the two above, one layer up: this one decides
 * which controls a rule even applies to, so a parser that misses an element
 * reports zero offenders and looks like a clean app. Each of these is a bug
 * that was really there, and each fails if its fix is reverted.
 */
test('a value keeps its apostrophes', () => {
  const { BUTTONS } = usage
  const outline = BUTTONS.find((rule) => rule.variant === 'outline')
  // A regex over `'…\'…'` ends at the backslash, taking a third of the
  // sentence. The generated doc would match its own truncation and pass.
  assert.match(outline.when, /the page's own ground with nothing else to separate it\.$/)
})

test('a type annotation spanning lines is stripped whole', () => {
  const stripped = usage.stripTypes(
    "export type T = {\n  readonly a: string\n}\nexport const X: readonly {\n  readonly b: string\n}[] = [{ b: 'kept' }]\n",
  )
  // Stopping at the first newline instead of the closing brace leaves
  // `readonly b: string` as a statement, and evaluation throws.
  assert.doesNotMatch(stripped, /readonly/)
  assert.match(stripped, /const X\s*=\s*\[\{ b: 'kept' \}\]/)
})

test('a variant written after a handler is still found', () => {
  // `<Btn\b([^>]*)>` stops at the `>` of the arrow, so this button used to
  // read as unqualified — the one state the rule exists to catch.
  const found = usage.buttonsIn('<Btn onClick={() => go()} variant="ghost">x</Btn>')
  assert.deepEqual(found, [{ tag: 'Btn', variant: 'ghost', size: 'full' }])
})

test('a conditional variant yields its branches, not its test', () => {
  // Reading quoted words out of the whole expression returns `hard`, which is
  // a git reset mode, and reports a control that does not exist.
  const found = usage.buttonsIn("<Btn variant={mode === 'hard' ? 'danger' : 'primary'}>x</Btn>")
  assert.deepEqual(found.map((one) => one.variant), ['danger', 'primary'])
})

test('a variant the parser cannot read is not called unqualified', () => {
  // Defaulting here would paint an opinion onto a button whose variant is a
  // variable, and charge the file for it. It is reported as `null` rather
  // than dropped — returning nothing made an unreadable slot and a clean slot
  // print the same nothing, which is how the mixed-branch hole stayed quiet.
  assert.deepEqual(usage.buttonsIn('<Btn variant={chosen}>x</Btn>').map((one) => one.variant), [null])
  assert.deepEqual(usage.buttonsIn('<Btn>x</Btn>'), [{ tag: 'Btn', variant: 'secondary', size: 'full' }])
  assert.deepEqual(usage.buttonsIn('<Button>x</Button>'), [{ tag: 'Button', variant: 'default', size: 'full' }])
})

test('the slot rule catches a variant that vanishes there, and only there', () => {
  const head = '<PageHead title="x" actions={<Btn variant="ghost">Add</Btn>} />'
  assert.deepEqual(usage.slotOffenders(head, 'F.tsx'), [
    'F.tsx: <Btn variant="ghost"> in a page head\'s action',
  ])
  // The same button one prop over is not in the slot, and is not the rule's
  // business.
  const elsewhere = '<PageHead title="x" note={<Btn variant="outline">Add</Btn>} />'
  assert.deepEqual(usage.slotOffenders(elsewhere, 'F.tsx'), [])
  // Nor is one on another element entirely. Searching forward from the head
  // for the word `actions` finds this `Toolbar`'s and charges the head for a
  // button that is nowhere near it.
  const nextElement = '<PageHead title="x" />\n<Toolbar actions={<Btn variant="ghost">Add</Btn>} />'
  assert.deepEqual(usage.slotOffenders(nextElement, 'F.tsx'), [])
})

test('a head action is held to its own rung', () => {
  // `small` carries no `=`, so an attribute walk that only matches `name=`
  // cannot see it — and every one of the app's eight section actions is
  // written exactly this way. The gate called all eight wrong while the
  // browser measured all eight at 28px, which is the rung they should be.
  assert.deepEqual(usage.slotOffenders('<SectionHead name="x" action={<Btn variant="outline" small>Add</Btn>} />', 'F.tsx'), [])
  assert.deepEqual(usage.slotOffenders('<SectionHead name="x" action={<Btn variant="outline">Add</Btn>} />', 'F.tsx'), [
    "F.tsx: <Btn> is full in a section head's action, which is sm",
  ])
  assert.deepEqual(usage.slotOffenders('<PageHead title="x" actions={<Btn variant="outline" small>Add</Btn>} />', 'F.tsx'), [
    "F.tsx: <Btn> is sm in a page head's action, which is full",
  ])
})

test('a dialog footer is held to its own list', () => {
  assert.deepEqual(usage.footerOffenders('<Dialog footer={<Btn variant="ghost">Save</Btn>} />', 'F.tsx'), [
    "F.tsx:1: <Btn variant=\"ghost\"> in a dialog's footer",
    "F.tsx:1: a lone button in a dialog's footer is its act, and is not filled",
  ])
  assert.deepEqual(usage.footerOffenders('<Dialog footer={<Btn variant="secondary">Cancel</Btn>} />', 'F.tsx'), [
    "F.tsx:1: a lone button in a dialog's footer is its act, and is not filled",
  ])
  // The soft red is a page's remove action, never a confirm's act.
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<><Button variant="destructive">Delete</Button><Button variant="secondary">Keep</Button></>} />', 'F.tsx'),
    [
      "F.tsx:1: <Button variant=\"destructive\"> in a dialog's footer",
      "F.tsx:1: a dialog's footer renders 2 buttons and no filled act",
    ],
  )
})


/**
 * The round of review that found these.
 *
 * Three reviewers read this parser and between them found eight live defects
 * in it, which is the honest measure of what the tests above were worth: each
 * one proved a specific bug and none of them established the thing was sound.
 * Every case below is a defect that was really in the tree, reproduced before
 * it was fixed.
 */
test('a bracket is closed by its own kind', () => {
  // The pairs map was built and its values never read, so one shared depth
  // was decremented by any closer and `{` was happily closed by `]`.
  assert.equal(usage.closes('{a]b}', 0), 4)
  assert.equal(usage.closes('{a}', 0), 2)
})

test('a bracket inside quoted text is not structure', () => {
  // `title="Smile :)"` closed the enclosing brace on the `)` in the string,
  // truncating the prop before its `variant=` — and the gate then reported a
  // header button as unqualified on a line that was correct.
  const region = '<PageHead t="x" actions={<Btn title="Smile :)" variant="outline">C</Btn>} />'
  assert.deepEqual(usage.slotOffenders(region, 'F.tsx'), [])
})

test('a mixed conditional is unreadable, and says so', () => {
  // Reading the quoted words after the `?` saw only the literal branch, so a
  // slot reported clean while the other branch was free to be `ghost`. It was
  // blind in both positions, which made it a bypass — and a silent one.
  const sneaky = "<PageHead t='x' actions={<Btn variant={ok ? 'outline' : other}>A</Btn>} />"
  assert.deepEqual(usage.slotOffenders(sneaky, 'F.tsx'), [
    "F.tsx: <Btn> in a page head's action has a variant this cannot read",
  ])
  assert.deepEqual(usage.buttonsIn("<Btn variant={ok ? other : 'outline'}>x</Btn>").map((one) => one.variant), [null])
  // A conditional every branch of which is a literal is still read, nesting
  // included: `a ? 'x' : b ? 'y' : 'z'` is `a ? 'x' : (b ? 'y' : 'z')`.
  assert.deepEqual(
    usage.buttonsIn("<Btn variant={a ? 'outline' : b ? 'ghost' : 'default'}>x</Btn>").map((one) => one.variant),
    ['outline', 'ghost', 'default'],
  )
})

test('a prop written with spaces round its equals keeps its value', () => {
  // Matching the valueless form first read `variant = "outline"` as a bare
  // `variant`, stored a boolean, and `written.startsWith` threw — which took
  // the whole audit down rather than reporting anything.
  assert.deepEqual(usage.buttonsIn('<Btn variant = "outline">x</Btn>').map((one) => one.variant), ['outline'])
  assert.deepEqual(usage.buttonsIn('<Btn variant>x</Btn>').map((one) => one.variant), [null])
})

test('a comparison inside a spread is not the end of the tag', () => {
  // Stepping into `{...(n > 0 ? a : b)}` read that `>` as the tag's own, so
  // every attribute after it was dropped and the button read as unqualified.
  const found = usage.buttonsIn('<Btn {...(n > 0 ? a : b)} variant="outline">x</Btn>')
  assert.deepEqual(found.map((one) => one.variant), ['outline'])
})

test('a rung it cannot read is not called full', () => {
  assert.deepEqual(usage.buttonsIn("<Button size='sm'>x</Button>").map((one) => one.size), ['sm'])
  assert.deepEqual(usage.buttonsIn('<Button size="sm">x</Button>').map((one) => one.size), ['sm'])
  assert.deepEqual(usage.buttonsIn('<Button size={d ? "sm" : "default"}>x</Button>').map((one) => one.size), [null])
  // …and an unknown rung is not charged against the slot's rung.
  assert.deepEqual(
    usage.slotOffenders('<SectionHead name="x" action={<Btn variant="outline" size={d}>A</Btn>} />', 'F.tsx'),
    [],
  )
})

test('a footer renders one filled act on every branch, a lone button included', () => {
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<><Btn variant="default">A</Btn><Btn variant="primary">B</Btn></>} />', 'F.tsx'),
    ["F.tsx:1: 2 filled actions in a dialog's footer, which holds one"],
  )
  // A filled red act is a filled button: beside the ink confirm it is a
  // second default, and the footer has no answer to lean on.
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<><Button variant="danger">Delete</Button><Button>Save</Button></>} />', 'F.tsx'),
    ["F.tsx:1: 2 filled actions in a dialog's footer, which holds one"],
  )
  // The footer's own grammar passes: one filled confirm, a quiet way out.
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<><Button variant="danger">Delete</Button><Button variant="secondary">Cancel</Button></>} />', 'F.tsx'),
    [],
  )
  assert.deepEqual(usage.footerOffenders('<Dialog footer={<><Button>Save</Button><Button variant="quiet">Close</Button></>} />', 'F.tsx'), [])
  // A lone Close is the footer's act, and filled: a secondary alone on the
  // footer's ground is a frame the colour of the ground. Two unfilled
  // buttons have no default.
  assert.deepEqual(usage.footerOffenders('<Dialog footer={<Button>Close</Button>} />', 'F.tsx'), [])
  assert.deepEqual(usage.footerOffenders('<Dialog footer={<Button variant="secondary">Close</Button>} />', 'F.tsx'), [
    "F.tsx:1: a lone button in a dialog's footer is its act, and is not filled",
  ])
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<><Button variant="secondary">Open</Button><Button variant="secondary">Close</Button></>} />', 'F.tsx'),
    ["F.tsx:1: a dialog's footer renders 2 buttons and no filled act"],
  )
  // Both arms of a conditional are read. Each arm here is right…
  const branched =
    '<Dialog footer={r ? (<Btn variant="primary">Close</Btn>) : (<><Btn variant="primary">Apply</Btn><Btn>Cancel</Btn></>)} />'
  assert.deepEqual(usage.footerOffenders(branched, 'F.tsx'), [])
  const nested =
    '<Dialog footer={<><Btn variant="secondary">Cancel</Btn>{e ? <Btn variant="default">Save</Btn> : <Btn variant="default">Create</Btn>}</>} />'
  assert.deepEqual(usage.footerOffenders(nested, 'F.tsx'), [])
  // …and an arm that is wrong is found, where the text check stayed silent.
  const wrongArm =
    '<Dialog footer={<>{hard ? <Button variant="destructive">Reset</Button> : <Button>Reset</Button>}<Button variant="secondary">Keep</Button></>} />'
  assert.ok(usage.footerOffenders(wrongArm, 'F.tsx').includes("F.tsx:1: a dialog's footer renders 2 buttons and no filled act"))
  // `&&` is read with and without its button: here the rendering with it is
  // two primaries…
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<><Button>Save</Button>{more && <Button>Also</Button>}</>} />', 'F.tsx'),
    ["F.tsx:1: 2 filled actions in a dialog's footer, which holds one"],
  )
  // …and here only the rendering without it is wrong: Keep alone, unfilled.
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<><Button variant="secondary">Keep</Button>{canSave && <Button>Save</Button>}</>} />', 'F.tsx'),
    ["F.tsx:1: a lone button in a dialog's footer is its act, and is not filled"],
  )
})

test('a footer counts its aside, a buttonVariants control, and a hoisted local', () => {
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<Button>Save</Button>} footerAside={<Button>Also save</Button>} />', 'F.tsx'),
    ["F.tsx:1: 2 filled actions in a dialog's footer, which holds one"],
  )
  // The aside is set a step down; its rung is not the footer's.
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<Button>Save</Button>} footerAside={<Button variant="secondary" size="sm">Prune</Button>} />', 'F.tsx'),
    [],
  )
  assert.deepEqual(
    usage.footerOffenders(
      "<Dialog footer={<><Button>Save</Button><DialogClose className={buttonVariants({ variant: 'ghost' })}>Cancel</DialogClose></>} />",
      'F.tsx',
    ),
    ["F.tsx:1: <DialogClose variant=\"ghost\"> in a dialog's footer"],
  )
  const hoisted = 'const actions = <><Button>Save</Button><Button>Save too</Button></>;\n<Dialog footer={actions} />'
  assert.deepEqual(usage.footerOffenders(hoisted, 'F.tsx'), ["F.tsx:2: 2 filled actions in a dialog's footer, which holds one"])
})

test('a footer written as a component is read through it, and one it cannot see into is unread, never empty', () => {
  // A component in the same file is read to what it returns — an arrow, a
  // block body with a return, and a function declaration.
  const arrow = 'const FooterButtons = () => <><Button variant="secondary">A</Button><Button variant="secondary">B</Button></>;\n<Dialog footer={<FooterButtons />} />'
  assert.deepEqual(usage.footerOffenders(arrow, 'F.tsx'), ["F.tsx:2: a dialog's footer renders 2 buttons and no filled act"])
  const block = 'const FooterButtons = ({ busy }) => { if (busy) return <Button disabled>Saving</Button>; return <><Button>Save</Button><Button variant="secondary">Cancel</Button></> };\n<Dialog footer={<FooterButtons />} />'
  assert.deepEqual(usage.footerOffenders(block, 'F.tsx'), [])
  const declared = 'function FooterButtons() { return <Button variant="destructive">Delete</Button> }\n<Dialog footer={<FooterButtons />} />'
  assert.deepEqual(usage.footerOffenders(declared, 'F.tsx'), [
    "F.tsx:2: <Button variant=\"destructive\"> in a dialog's footer",
    "F.tsx:2: a lone button in a dialog's footer is its act, and is not filled",
  ])
  // Imported, or otherwise out of sight: reported, not counted as empty.
  assert.deepEqual(usage.footerOffenders('<Dialog footer={<SharedFooter />} />', 'F.tsx'), [
    "F.tsx:1: a dialog's footer holds a part this cannot read",
  ])
  // A wrapper with buttons inside is read through its children.
  assert.deepEqual(
    usage.footerOffenders('<Dialog footer={<RefusedAction reason="x"><Button>Go</Button></RefusedAction>} />', 'F.tsx'),
    [],
  )
})

test('a spread that can set a footer button\'s variant makes it unread', () => {
  assert.deepEqual(usage.footerOffenders('<Dialog footer={<Button {...confirm}>Go</Button>} />', 'F.tsx'), [
    "F.tsx:1: <Button> in a dialog's footer has a variant this cannot read",
  ])
  // A variant written after the spread is the variant.
  assert.deepEqual(usage.footerOffenders('<Dialog footer={<Button {...confirm} variant="default">Go</Button>} />', 'F.tsx'), [])
  assert.deepEqual(usage.footerOffenders('<Dialog footer={<>{...buttons}</>} />', 'F.tsx'), [
    "F.tsx:1: a dialog's footer holds a part this cannot read",
  ])
})

test('a rule is filed under the class it is about', (t) => {
  // `.tray .tabClose` is a rule about `tabClose`. Taking the first class
  // filed it under `tray`, so the button carrying `styles.tabClose` matched
  // nothing and an undersized target went uncounted.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-sq-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'x.module.css')
  fs.writeFileSync(file, '.tray .tabClose { width: 18px; height: 18px; }\n.solo { width: 20px; height: 20px; }\n')
  const found = squaresOf(file)
  assert.equal(found.get('tabClose'), 18)
  assert.equal(found.get('solo'), 20)
  assert.equal(found.has('tray'), false)
})

test('the design audit reads a .tsx through the compiler, so a string is not a comment (#229)', (t) => {
  /* The audit tracked comment state one line at a time, and stripped block
     comments with a pattern: a `//` inside a template literal that spans
     lines was cut as though it opened one, and `['src/api/**']` opened a
     block comment that ran to the next star-slash — 149 lines of
     `preview/main.tsx`, which every rule below was blind to. Both are the
     failures `withoutComments` above was written for (#123, #228). */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-audit-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'Diff.tsx')
  fs.writeFileSync(
    file,
    [
      "const rule = { files: ['src/api/**'], dependsOn: [] }",
      'const diff = `@@ -84,6 +84,17 @@',
      '+  // worktree list reports the local registry, which outlives the remote:',
      ' }`',
      '// a real comment',
      'export const Diff = () => <button aria-modal="true">{diff}{String(rule)}</button>',
    ].join('\n'),
  )
  const code = codeOf(file)
  assert.match(code, /outlives the remote:/)
  assert.match(code, /dependsOn/)
  // The controls: a real comment still goes, and the tag the rules walk is whole.
  assert.doesNotMatch(code, /a real comment/)
  assert.match(code, /<button aria-modal="true">/)
})

test("a comment's divider becomes a heading rather than a rule and a stray line", () => {
  const comment = ['/**', ' * Title.', ' *', ' * ' + '-'.repeat(20), ' * Why this is data', ' *', ' * Because.', ' */'].join('\n')
  const out = leadComment(comment)
  assert.match(out, /^### Why this is data$/m)
  assert.doesNotMatch(out, /^-{10,}$/m)
})

test('compareBaseline requires a complete numeric zero baseline and zero current drift (#400)', () => {
  const cleanCounts = zeroes()

  // A malformed baseline with string/non-numeric values
  const malformedBaseline = { ...cleanCounts, offGrid: 'nan' }
  const result = compareBaseline(cleanCounts, malformedBaseline)
  assert.equal(result.worse, true)
  assert.ok(result.problems.some((p) => p.message.includes('not a valid number')))

  // Missing entry in baseline
  const missingBaseline = { ...cleanCounts }
  delete missingBaseline.offGrid
  const missingResult = compareBaseline(cleanCounts, missingBaseline)
  assert.equal(missingResult.worse, true)
  assert.ok(missingResult.problems.some((p) => p.message.includes('Missing baseline entry')))

  // Editing the baseline cannot accept existing debt.
  const raisedBaseline = { ...cleanCounts, offGrid: 1 }
  const raisedResult = compareBaseline(cleanCounts, raisedBaseline)
  assert.equal(raisedResult.worse, true)
  assert.ok(raisedResult.problems.some((p) => p.message.includes('must be zero')))

  // A zero baseline still fails any current finding.
  const driftResult = compareBaseline({ ...cleanCounts, offGrid: 1 }, cleanCounts)
  assert.equal(driftResult.worse, true)
  assert.ok(driftResult.problems.some((p) => p.message.includes('requires zero')))

  // Only a complete zero baseline with a clean scan passes.
  const validResult = compareBaseline(cleanCounts, cleanCounts)
  assert.equal(validResult.worse, false)
  assert.equal(validResult.problems.length, 0)
})


test('each burn-down category is gated on a ceiling that may only fall', () => {
  const clean = zeroes()

  for (const key of ['patternClass', 'screenAppearance']) {
    const ceiling = { ...clean, [key]: 126 }

    // At the ceiling: the debt is recorded, so the gate is quiet.
    const held = compareBaseline({ ...clean, [key]: 126 }, ceiling)
    assert.equal(held.worse, false, `${key} sitting at the recorded ceiling must pass`)

    // Above it: a screen just drew another piece of a role for itself.
    const grown = compareBaseline({ ...clean, [key]: 127 }, ceiling)
    assert.equal(grown.worse, true)
    assert.ok(grown.problems.some((p) => p.message.includes('may only fall')))

    // Below it: the work was done and the ceiling has to follow, or the debt can
    // silently come back to 126 without the gate ever noticing.
    const paid = compareBaseline({ ...clean, [key]: 125 }, ceiling)
    assert.equal(paid.worse, true)
    assert.ok(paid.problems.some((p) => p.message.includes('Tighten the ceiling')))
  }

  const ceiling = { ...clean, patternClass: 126, screenAppearance: 126 }

  // A non-zero ceiling is still refused for every other category.
  const smuggled = compareBaseline(clean, { ...ceiling, offGrid: 5 })
  assert.equal(smuggled.worse, true)
  assert.ok(smuggled.problems.some((p) => p.message.includes('must be zero')))

  // And a category that has burned down to nothing leaves the ratchet: type
  // sizes reached zero, so a single literal coming back is refused outright
  // rather than measured against a ceiling of nought.
  const returned = compareBaseline({ ...clean, rawType: 1, patternClass: 126, screenAppearance: 126 }, ceiling)
  assert.equal(returned.worse, true)
  assert.ok(returned.problems.some((p) => p.key === 'rawType'))
})

test('screen property families have one explicit appearance or layout boundary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-screen-appearance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const components = path.join(root, 'packages/ui/src/components')
  fs.mkdirSync(components, { recursive: true })
  const file = path.join(components, 'Example.module.css')
  const cases = [
    // Type.
    ['font', 'inherit', true],
    ['font-variant-numeric', 'tabular-nums', true],
    ['line-height', 'var(--hd-line)', true],
    ['letter-spacing', '0.01em', true],
    ['word-spacing', '0.01em', true],
    ['text-transform', 'uppercase', true],
    ['text-decoration-thickness', '1px', true],
    ['text-underline-offset', '2px', true],
    ['text-shadow', '0 1px black', true],
    // Ink and ground.
    ['color', 'var(--hd-foreground)', true],
    ['background-image', 'linear-gradient(red, blue)', true],
    ['fill', 'currentColor', true],
    ['stroke-dasharray', '2 2', true],
    ['caret-color', 'currentColor', true],
    ['accent-color', 'currentColor', true],
    ['filter', 'blur(1px)', true],
    ['backdrop-filter', 'blur(1px)', true],
    ['mix-blend-mode', 'multiply', true],
    ['mask-image', 'linear-gradient(black, transparent)', true],
    // Edge and inner box.
    ['border-image-source', 'linear-gradient(red, blue)', true],
    ['outline-offset', '2px', true],
    ['box-shadow', 'var(--hd-shadow-sm)', true],
    ['padding-inline', 'var(--hd-space-2)', true],
    // Layout and behaviour.
    ['display', 'grid', false],
    ['flex-basis', 'auto', false],
    ['grid-template-columns', '1fr 1fr', false],
    ['gap', 'var(--hd-space-2)', false],
    ['align-items', 'center', false],
    ['position', 'absolute', false],
    ['inset-inline', '0', false],
    ['width', '30px', false],
    ['margin-inline', 'auto', false],
    ['overflow-y', 'auto', false],
    ['z-index', 'var(--hd-z-popover)', false],
    ['order', '1', false],
    ['float', 'inline-start', false],
    ['box-sizing', 'border-box', false],
    ['aspect-ratio', '1', false],
    ['object-fit', 'cover', false],
    ['transform', 'translateX(1px)', false],
    ['contain', 'layout', false],
    ['isolation', 'isolate', false],
    ['visibility', 'hidden', false],
    ['opacity', '0', false],
    ['cursor', 'pointer', false],
    ['pointer-events', 'none', false],
    ['user-select', 'none', false],
    ['transition-duration', '100ms', false],
    ['animation-name', 'pulse', false],
    ['will-change', 'transform', false],
    ['content', '"ready"', false],
    ['white-space', 'nowrap', false],
    ['text-overflow', 'ellipsis', false],
    ['text-align', 'center', false],
    ['vertical-align', 'middle', false],
    ['word-break', 'break-word', false],
    ['overflow-wrap', 'anywhere', false],
    ['hyphens', 'auto', false],
    ['list-style-type', 'none', false],
    ['table-layout', 'fixed', false],
    ['resize', 'both', false],
    ['scroll-margin-top', '1rem', false],
    ['appearance', 'none', false],
    ['-webkit-app-region', 'drag', false],
  ]

  for (const [property, value, counts] of cases) {
    const css = `.role { ${property}: ${value}; }`
    const found = screenAppearanceOf(file, css)
    assert.equal(found.length, counts ? 1 : 0, `${property} ${counts ? 'counts' : 'does not count'}`)
    assert.deepEqual(screenUnclassifiedOf(file, css), [], `${property} is classified`)
  }
})

test('screen appearance uses one boundary for height, min-height and max-height', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-screen-height-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'packages/ui/src/components/Example.module.css')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const cases = [
    ['30px', true],
    ['2rem', true],
    ['var(--hd-nav-h)', true],
    ['calc(var(--hd-nav-h) + 2px)', true],
    ['220px', true],
    ['0', false],
    ['0px', false],
    ['100%', false],
    ['calc(100% - 2px)', false],
    ['100vh', false],
    ['10dvh', false],
    ['50svw', false],
    ['100cqh', false],
    ['20cqmin', false],
    ['auto', false],
    ['none', false],
    ['fit-content', false],
    ['fit-content(10rem)', false],
    ['min-content', false],
    ['max-content', false],
    ['inherit', false],
  ]

  for (const property of ['height', 'min-height', 'max-height']) {
    for (const [value, counts] of cases) {
      const css = `.role { ${property}: ${value}; }`
      assert.equal(
        screenAppearanceOf(file, css).length,
        counts ? 1 : 0,
        `${property}: ${value} ${counts ? 'counts' : 'does not count'}`,
      )
    }
  }
})

test('an unclassified screen property fails --strict and names the property and sheet', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const file = path.join(root, 'packages/ui/src/components/AppWindow.module.css')
  const original = fs.readFileSync(file, 'utf8')
  try {
    fs.writeFileSync(file, `${original}\n.unclassifiedGateProbe { speak: never; }\n`)
    const result = spawnSync(process.execPath, ['script/design-audit.mjs', '--strict'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, 'an unclassified property must fail the strict audit')
    assert.match(`${result.stdout}\n${result.stderr}`, /AppWindow\.module\.css: speak/)
  } finally {
    fs.writeFileSync(file, original)
  }
})

/**
 * The one group label is sentence case, and the only capitals the app keeps
 * are printed on a `Keycap`. `uppercaseLabel` counts every other one, in the
 * three spellings a screen has — a stylesheet's `text-transform`, a class
 * list's `uppercase` utility, an inline style's `textTransform` — and never a
 * comment, a keycap, or a string method that merely has the word in it.
 */
test('uppercaseLabel counts capitals on a label in every spelling, and none on a keycap', () => {
  const css = path.join(repoRoot, 'packages/ui/src/components/Example.module.css')
  const tsx = path.join(repoRoot, 'packages/ui/src/components/Example.tsx')
  const cases = [
    [css, '.label { font-size: var(--hd-text-xs); text-transform: uppercase; }', 1],
    [css, '.label { text-transform: var(--hd-label-transform, uppercase); }', 1],
    [css, '.a, .b { letter-spacing: 0.04em; text-transform: uppercase }', 1],
    [css, '.keycap { text-transform: uppercase; }', 0],
    [css, '.label { text-transform: none; }', 0],
    [css, '/* .label { text-transform: uppercase; } */ .label { color: red; }', 0],
    [tsx, 'export const A = () => <span className="text-xs font-medium uppercase" />\n', 1],
    [tsx, 'export const A = () => <span className="data-[on]:uppercase" />\n', 1],
    [tsx, "export const A = () => <span style={{ textTransform: 'uppercase' }} />\n", 1],
    [tsx, 'export const A = () => <><span className="uppercase" /><b className="uppercase" /></>\n', 2],
    [tsx, 'export const A = ({ name }: { name: string }) => <span>{name.toUpperCase()}</span>\n', 0],
    [tsx, '// uppercase once lived here\nexport const A = () => <span className="normal-case" />\n', 0],
    [tsx, 'export const A = () => <Keycap className="uppercase">k</Keycap>\n', 0],
  ]
  for (const [file, source, count] of cases) {
    assert.equal(uppercaseLabelsOf(file, source).length, count, source)
  }
  assert.match(uppercaseLabelsOf(css, '.railLabel { text-transform: uppercase }')[0], /components\/Example\.module\.css: \.railLabel/)
})

test('screen appearance excludes the design system and its named specialized renderers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-screen-appearance-scope-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = '.role { color: var(--hd-foreground); padding: var(--hd-space-2); }'
  const files = [
    path.join(root, 'packages/ui/src/design/patterns/Role.module.css'),
    path.join(root, 'packages/ui/src/components/Markdown.module.css'),
    path.join(root, 'packages/ui/src/components/Diff.module.css'),
  ]
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, source)
    assert.deepEqual(screenAppearanceOf(file, fs.readFileSync(file, 'utf8')), [], file)
  }
})

/**
 * `screenAppearanceOf` reads a screen's `.module.css`; these fixtures cover
 * the two other spellings the same drift moved into once the stylesheet went
 * quiet — a Tailwind utility in `className` and a key in an inline `style`.
 * No file is written to disk: `screenUtilityAppearanceOf` and
 * `screenInlineStyleAppearanceOf` take `source` directly, the same as
 * `screenAppearanceOf(file, css)` does, and only the path string drives the
 * screen/exemption checks.
 */
const screenTsx = (name) => path.join(repoRoot, 'packages/ui/src/components', name)
const classNameSource = (className) => `export const Example = () => <div className="${className}" />\n`
// Every finding now names the file its declaration actually lives in — the
// current file for a direct literal, a different one once item 1's identifier
// resolution crosses an import — so a same-file fixture's expectation carries
// the label too.
const label = (name) => `components/${name}: `

test('a plain screen utility counts, mapped to the property it draws', () => {
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), classNameSource('rounded-full')),
    [`${label('Example.tsx')}rounded-full (border-radius)`],
  )
})

test('a variant-prefixed screen utility is stripped to its base before it is classified', () => {
  const cases = [
    ['hover:bg-(--hd-accent-dim)', 'hover:bg-(--hd-accent-dim) (background)'],
    ['data-[open]:text-sm', 'data-[open]:text-sm (font-size)'],
    ['[&_h2]:text-base', '[&_h2]:text-base (font-size)'],
    // Stacked variants: each one is its own top-level `:`, so the base is
    // reached only once every layer is peeled off.
    ['md:dark:hover:rounded-full', 'md:dark:hover:rounded-full (border-radius)'],
  ]
  for (const [className, expected] of cases) {
    assert.deepEqual(
      screenUtilityAppearanceOf(screenTsx('Example.tsx'), classNameSource(className)),
      [`${label('Example.tsx')}${expected}`],
      className,
    )
  }
})

test('the important marker is punctuation, in either spelling Tailwind has used for it', () => {
  // v4 moved `!` to the end of the token; a v3 source may still lead with it.
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), classNameSource('bg-red-500!')),
    [`${label('Example.tsx')}bg-red-500! (background)`],
  )
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), classNameSource('!bg-red-500')),
    [`${label('Example.tsx')}!bg-red-500 (background)`],
  )
})

test('an arbitrary height value counts exactly where the CSS height rule would', () => {
  // Same three answers `screenAppearanceOf` gives a stylesheet's own
  // `height`/`min-height`/`max-height`, reached through the utility instead:
  // a real metric counts, a reset and a layout share do not.
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), classNameSource('max-h-[380px]')),
    [`${label('Example.tsx')}max-h-[380px] (max-height)`],
  )
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), classNameSource('h-full')), [])
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), classNameSource('h-0')), [])
})

test('a screen utility on the layout side of the boundary is not counted', () => {
  // `text-align` and the truncate family are layout in `LAYOUT_BEHAVIOUR_PROPERTIES`
  // whichever spelling declares them; a screen reaching for either is not new
  // debt.
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), classNameSource('text-center')), [])
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), classNameSource('truncate')), [])
})

test('a screen utility inside a ternary is read on both branches, not only the one that looks true', () => {
  // What spelling would this rule miss? A conditional class list, which is
  // static text on both branches even though only one renders at a time —
  // exactly `Items.tsx`'s `register === 'light' ? '' : ' rounded-(--hd-radius) ...'`.
  const source = 'export const Example = () => <div className={`${styles.row}${open ? \' rounded-full\' : \' text-xs\'}`} />\n'
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}rounded-full (border-radius)`, `${label('Example.tsx')}text-xs (font-size)`],
  )
})

test('a screen utility is read from a template literal and from a cn() call, not only a plain string', () => {
  const templateSource = 'export const Example = () => <div className={`${styles.row} rounded-full`} />\n'
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), templateSource),
    [`${label('Example.tsx')}rounded-full (border-radius)`],
  )

  const cnCallSource = "import { cn } from '../lib/utils'\nexport const Example = () => <div className={cn('rounded-full', open && 'text-xs')} />\n"
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), cnCallSource),
    [`${label('Example.tsx')}rounded-full (border-radius)`, `${label('Example.tsx')}text-xs (font-size)`],
  )
})

test('a cn() call reached only through the const it was assigned to is read once, not twice', () => {
  // What spelling would this rule miss? The call is found directly, wherever
  // it sits in the file, and again by resolving the name a `className`
  // references — both paths reach the identical call node, so its arguments
  // must be read once, not once per path.
  const indirectSource = "import { cn } from '../lib/utils'\nconst rowClass = cn('rounded-full')\nexport const Example = () => <div className={rowClass} />\n"
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), indirectSource),
    [`${label('Example.tsx')}rounded-full (border-radius)`],
  )
})

test('screen utility appearance excludes the design system, test files, and the Markdown/Diff exemption', () => {
  const source = classNameSource('rounded-full')
  const excluded = [
    path.join(repoRoot, 'packages/ui/src/design/ui/button.tsx'),
    path.join(repoRoot, 'packages/ui/src/components/Example.test.tsx'),
    path.join(repoRoot, 'packages/ui/src/components/Markdown.tsx'),
    path.join(repoRoot, 'packages/ui/src/components/Diff.tsx'),
    // The icon façade carries the same exemption the loose-icon rule gives it.
    path.join(repoRoot, 'packages/ui/src/components/Icons.tsx'),
  ]
  for (const file of excluded) assert.deepEqual(screenUtilityAppearanceOf(file, source), [], file)
  // The same source, in an ordinary screen, does count — proving the fixture
  // above excludes on purpose rather than by an accident in the source text.
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}rounded-full (border-radius)`],
  )
})

test('a Tailwind utility maps to a property by its own shape, not a second appearance table', () => {
  const cases = [
    // `text-` is ambiguous between a size and a colour; the suffix decides.
    ['text-xs', { property: 'font-size', value: '' }],
    ['text-(length:--hd-x)', { property: 'font-size', value: '' }],
    ['text-[12px]', { property: 'font-size', value: '' }],
    ['text-(--hd-x)', { property: 'color', value: '' }],
    ['text-(color:--hd-x)', { property: 'color', value: '' }],
    ['text-[#fff]', { property: 'color', value: '' }],
    ['text-red-500', { property: 'color', value: '' }],
    // `text-shadow-*` shares the `text-` prefix with the size/colour family
    // and must not fall through to it.
    ['text-shadow-md', { property: 'text-shadow', value: '' }],
    // `font-` is ambiguous between a weight, a family and (new) a stretch.
    ['font-semibold', { property: 'font-weight', value: '' }],
    ['font-mono', { property: 'font-family', value: '' }],
    ['font-(family-name:--hd-font)', { property: 'font-family', value: '' }],
    ['font-stretch-condensed', { property: 'font-stretch', value: '' }],
    // `size-` sets width and height; only the height half is counted, by the
    // same value rule as `h-`/`min-h-`/`max-h-`.
    ['size-8', { property: 'height', value: '8' }],
    ['size-full', { property: 'height', value: '100%' }],
    // `` `h-${n}` ``/`` `px-${n}` `` leave a dangling prefix with nothing
    // after the hyphen once the interpolation is read separately — counted
    // the same way a dangling `text-` already fell through to a colour.
    ['h-', { property: 'height', value: '' }],
    ['px-', { property: 'padding-inline', value: '' }],
    // The numeric-variant family, the negated tracking spelling, the new
    // logical padding pair, and Tailwind's own escape hatch for a property
    // no utility names.
    ['tabular-nums', { property: 'font-variant-numeric', value: '' }],
    ['-tracking-[2px]', { property: 'letter-spacing', value: '' }],
    ['pbs-2', { property: 'padding-block-start', value: '' }],
    ['pbe-2', { property: 'padding-block-end', value: '' }],
    ['underline-offset-2', { property: 'text-underline-offset', value: '' }],
    ['mix-blend-multiply', { property: 'mix-blend-mode', value: '' }],
    ['inset-shadow-sm', { property: 'box-shadow', value: '' }],
    ['inset-ring-2', { property: 'box-shadow', value: '' }],
    ['mask-none', { property: 'mask-image', value: '' }],
    ['[mask-type:luminance]', { property: 'mask-type', value: 'luminance' }],
    // A token this rule has not been taught returns null rather than a guess.
    ['font-condensed', null],
  ]
  for (const [token, expected] of cases) assert.deepEqual(screenUtilityDeclarationOf(token), expected, token)
})

/**
 * Item 3's mechanical coverage check, walked FROM the real
 * `APPEARANCE_PROPERTIES` export rather than a hand-copied list of its
 * names: every family or exact property it counts needs an entry in
 * `APPEARANCE_COVERAGE_SAMPLE` below, a representative utility that
 * `screenUtilityDeclarationOf` maps to it, or is named as a hint on
 * `looksLikeUnmappedAppearanceUtility` — never silently neither. Round 2
 * review found the previous version of this test read a copy of the
 * property names, so adding `text-indent` to the real table still passed:
 * nothing forced a new sample to be written. Walking the export instead
 * means a property or family with no entry here fails immediately, which is
 * the proof this test is not vacuous — see the manual check in the task
 * report, since committing the failing state itself would defeat the point.
 *
 * A property with no sample utility (`hint:` instead of a token) is one
 * Tailwind gives no default scale to (`caret-color`, `filter`) or
 * approximates only through the arbitrary-property escape hatch
 * (`word-spacing`); those are read from the hint list instead of a mapped
 * token.
 */
const APPEARANCE_COVERAGE_SAMPLE = {
  'line-height': 'leading-tight',
  'letter-spacing': 'tracking-wide',
  'word-spacing': '[word-spacing:0.1em]',
  'text-transform': 'uppercase',
  'text-underline-offset': 'underline-offset-2',
  'text-shadow': 'text-shadow-md',
  color: 'text-red-500',
  fill: 'fill-current',
  'caret-color': { hint: 'caret-red-500' },
  'accent-color': { hint: 'accent-red-500' },
  filter: { hint: 'blur-md' },
  'backdrop-filter': { hint: 'backdrop-blur-sm' },
  'mix-blend-mode': 'mix-blend-multiply',
  'box-shadow': 'shadow-md',
  height: 'h-8',
  'min-height': 'min-h-8',
  'max-height': 'max-h-8',
  font: 'font-mono',
  'text-decoration': 'underline',
  background: 'bg-red-500',
  stroke: 'stroke-current',
  mask: 'mask-none',
  border: 'border',
  outline: 'outline',
  padding: 'p-2',
}

test('every family or exact property APPEARANCE_PROPERTIES counts has a sample utility or a hint', () => {
  for (const property of [...APPEARANCE_PROPERTIES.exact, ...APPEARANCE_PROPERTIES.families]) {
    const sample = APPEARANCE_COVERAGE_SAMPLE[property]
    assert.ok(
      sample !== undefined,
      `${property} has no coverage sample — teach screenUtilityDeclarationOf a spelling (or add it to the hint list) and add one here`,
    )
    if (typeof sample === 'object') {
      assert.equal(screenUtilityDeclarationOf(sample.hint), null, `${property}: ${sample.hint} should be a hint, not a mapping`)
      assert.ok(looksLikeUnmappedAppearanceUtility(sample.hint), `${property}: ${sample.hint} should be flagged as a hint`)
      continue
    }
    const declaration = screenUtilityDeclarationOf(sample)
    assert.ok(declaration, `${property}: ${sample} has no utility mapping`)
    assert.equal(screenPropertySideOf(declaration.property, declaration.value), 'appearance', `${property}: ${sample} -> ${declaration.property} is not appearance`)
    assert.ok(
      declaration.property === property || declaration.property.startsWith(`${property}-`),
      `${property}: ${sample} mapped to ${declaration.property}, not the ${property} family`,
    )
  }
})

test('a bare antialiased is a hint, not a silent miss', () => {
  assert.equal(screenUtilityDeclarationOf('antialiased'), null)
  assert.ok(looksLikeUnmappedAppearanceUtility('antialiased'))
  assert.ok(looksLikeUnmappedAppearanceUtility('subpixel-antialiased'))
})

test('an unmapped utility that looks like appearance is reported for --verbose only, never counted', () => {
  const source = classNameSource('caret-red-500')
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), source), [])
  assert.deepEqual(screenUnmappedUtilityOf(screenTsx('Example.tsx'), source), [`${label('Example.tsx')}caret-red-500`])
})

/**
 * Item 1: a class site that only names a `const`, not the literal itself.
 * Round 1 review found four real shapes this rule missed entirely because it
 * never resolved an identifier — `Conversation.tsx`'s plain string constants,
 * `SettingsAgents.tsx`'s ternary, `TurnWork.tsx`'s array-and-`.join`, and
 * `LibraryActions.tsx`'s constant exported and used again from `Library.tsx`
 * — plus `BrowserPane.tsx`'s `className` written as an object key rather
 * than a JSX attribute.
 */
test('a same-file const resolves at a class site: a string, a ternary, and an array.join', () => {
  const stringSource = [
    "const TITLE_CLASSES = 'font-(family-name:--hd-font-display) text-base'",
    'export const Example = () => <div className={TITLE_CLASSES}>hi</div>',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), stringSource),
    [`${label('Example.tsx')}font-(family-name:--hd-font-display) (font-family)`, `${label('Example.tsx')}text-base (font-size)`],
  )

  const ternarySource = [
    "const fillClass = tone === 'bad' ? 'bg-(--hd-danger)' : 'bg-(--hd-success)'",
    'export const Example = () => <div className={`h-full ${fillClass}`} />',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), ternarySource),
    [`${label('Example.tsx')}bg-(--hd-danger) (background)`, `${label('Example.tsx')}bg-(--hd-success) (background)`],
  )

  const joinSource = [
    "const SHIMMER_CLASSES = ['bg-clip-text', 'text-transparent'].join(' ')",
    'export const Example = () => <span className={SHIMMER_CLASSES}>hi</span>',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), joinSource),
    [`${label('Example.tsx')}bg-clip-text (background-clip)`, `${label('Example.tsx')}text-transparent (color)`],
  )
})

test('a same-file const used at more than one class site is counted once, at its declaration', () => {
  const source = [
    "const SWITCH_TRACK = 'rounded-full'",
    'export const Example = () => (',
    '  <div>',
    '    <span className={SWITCH_TRACK} />',
    '    <span className={`${SWITCH_TRACK} w-fit`} />',
    '  </div>',
    ')',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}rounded-full (border-radius)`],
  )
})

test('a const imported from another screen is counted once, at the file that defines it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-screen-const-import-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const components = path.join(root, 'packages/ui/src/components')
  fs.mkdirSync(components, { recursive: true })
  const definingFile = path.join(components, 'LibraryActions.tsx')
  const consumingFile = path.join(components, 'Library.tsx')
  fs.writeFileSync(definingFile, [
    "export const SWITCH_TRACK = 'rounded-(--hd-radius-sm)'",
    'export const Example = () => <div className={SWITCH_TRACK} />',
  ].join('\n'))
  fs.writeFileSync(consumingFile, [
    "import { SWITCH_TRACK } from './LibraryActions'",
    'export const Example = () => <div className={SWITCH_TRACK} />',
  ].join('\n'))
  const shared = new Set()
  const definingFindings = screenUtilityAppearanceOf(definingFile, fs.readFileSync(definingFile, 'utf8'), undefined, shared)
  const consumingFindings = screenUtilityAppearanceOf(consumingFile, fs.readFileSync(consumingFile, 'utf8'), undefined, shared)
  assert.deepEqual(definingFindings, ['components/LibraryActions.tsx: rounded-(--hd-radius-sm) (border-radius)'])
  // Not found again labelled under Library.tsx, and not silently dropped
  // either — it was already counted once, at its definition.
  assert.deepEqual(consumingFindings, [])
})

/**
 * Item 1 (round 2): resolution is scope-correct, not "the first declaration
 * anywhere in the file". Two components each declaring their own `const
 * tone` are two declarations — both counted — and a shadowed inner `const
 * tone` resolves to its own declaration inside the block that shadows it,
 * not the outer one a flat name lookup would have found first.
 */
test('two components each declaring their own const tone are two declarations, both counted', () => {
  const source = [
    "const A = () => { const tone = 'rounded-full'; return <div className={tone} /> }",
    "const B = () => { const tone = 'text-xs'; return <div className={tone} /> }",
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}rounded-full (border-radius)`, `${label('Example.tsx')}text-xs (font-size)`],
  )
})

test('a shadowed inner const resolves to its own declaration, not the outer one', () => {
  const source = [
    'const Example = () => {',
    "  const tone = 'text-xs'",
    '  if (x) {',
    "    const tone = 'rounded-full'",
    '    return <span className={tone} />',
    '  }',
    '  return <span className={tone} />',
    '}',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}rounded-full (border-radius)`, `${label('Example.tsx')}text-xs (font-size)`],
  )
})

/**
 * Item 2 (round 2): a property access's member name is never treated as a
 * bare variable reference, and only a recognized shape (string, template,
 * ternary, array, `.join`, a class-combiner call) is walked once resolved —
 * an arbitrary expression, such as a comparison, is not.
 */
test('the name after a dot is never resolved as a variable: styles.fileRow does not find a const fileRow', () => {
  const source = [
    "const fileRow = 'rounded-full'",
    'export const Example = () => <div className={styles.fileRow} />',
  ].join('\n')
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), source), [])
})

test('a const holding a comparison, referenced at a class site, counts nothing', () => {
  const source = [
    "const active = x === 'underline'",
    'export const Example = () => <div className={active} />',
  ].join('\n')
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), source), [])
})

/**
 * Item 4 (round 2): the spellings round 2 review found still missed, none
 * used today. `let`/`var` behaves like `const` when never reassigned;
 * reassigned, every literal assignment reachable from the declaring scope is
 * gathered under the one declaration, since a variable that can hold more
 * than one thing statically is not the one thing a `const` is.
 */
test('a let never reassigned resolves like a const', () => {
  const source = "let tone = 'rounded-full'\nexport const Example = () => <div className={tone} />\n"
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), source), [`${label('Example.tsx')}rounded-full (border-radius)`])
})

test('a reassigned let counts every literal assignment it was given', () => {
  const source = [
    "let tone = 'rounded-full'",
    "if (x) { tone = 'bg-(--hd-card)' }",
    'export const Example = () => <div className={tone} />',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}rounded-full (border-radius)`, `${label('Example.tsx')}bg-(--hd-card) (background)`],
  )
})

test('a default import, a namespace import, a re-export, and a two-hop import all resolve, at their definition', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-screen-import-shapes-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const components = path.join(root, 'packages/ui/src/components')
  fs.mkdirSync(components, { recursive: true })
  const write = (name, content) => fs.writeFileSync(path.join(components, name), content)
  const read = (name) => fs.readFileSync(path.join(components, name), 'utf8')
  const at = (name) => path.join(components, name)

  write('DefaultBase.tsx', "export default 'rounded-full'\n")
  write('DefaultUser.tsx', "import CLASS from './DefaultBase'\nexport const Example = () => <div className={CLASS} />\n")
  assert.deepEqual(
    screenUtilityAppearanceOf(at('DefaultUser.tsx'), read('DefaultUser.tsx')),
    ['components/DefaultBase.tsx: rounded-full (border-radius)'],
  )

  write('NsBase.tsx', "export const TONE = 'bg-(--hd-card)'\n")
  write('NsUser.tsx', "import * as ns from './NsBase'\nexport const Example = () => <div className={ns.TONE} />\n")
  assert.deepEqual(
    screenUtilityAppearanceOf(at('NsUser.tsx'), read('NsUser.tsx')),
    ['components/NsBase.tsx: bg-(--hd-card) (background)'],
  )

  write('Origin.tsx', "export const SHARED = 'shadow-(--hd-hairline)'\n")
  write('Reexport.tsx', "export { SHARED } from './Origin'\n")
  write('ReexportUser.tsx', "import { SHARED } from './Reexport'\nexport const Example = () => <div className={SHARED} />\n")
  assert.deepEqual(
    screenUtilityAppearanceOf(at('ReexportUser.tsx'), read('ReexportUser.tsx')),
    ['components/Origin.tsx: shadow-(--hd-hairline) (box-shadow)'],
  )

  write('HopC.tsx', "export const DEEP = 'outline-2'\n")
  write('HopB.tsx', "export { DEEP } from './HopC'\n")
  write('HopA.tsx', "export { DEEP } from './HopB'\n")
  write('HopUser.tsx', "import { DEEP } from './HopA'\nexport const Example = () => <div className={DEEP} />\n")
  assert.deepEqual(
    screenUtilityAppearanceOf(at('HopUser.tsx'), read('HopUser.tsx')),
    ['components/HopC.tsx: outline-2 (outline)'],
  )
})

test('style={c && {...}} reads the guard\'s right side, and style={CONST} resolves a same-file object const', () => {
  const guardSource = 'export const Example = () => <div style={c && { color: "red" }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), guardSource), ['style color'])

  const constSource = [
    'const FROZEN_STYLE = { color: "red" }',
    'export const Example = () => <div style={FROZEN_STYLE} />',
  ].join('\n')
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), constSource), ['style color'])
})

test('an arbitrary property the stylesheet rule treats as unclassified is a strict screenUnclassified finding', () => {
  const source = classNameSource('[text-indent:2px]')
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), source), [])
  assert.deepEqual(
    screenUtilityUnclassifiedOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}[text-indent:2px] (text-indent)`],
  )
})

/**
 * Round 3 review: the closed shape list was too narrow and dropped 15 real
 * shapes the pre-round-2 walker still caught — none used in a counted file
 * today, but exactly the blind spot this PR exists to close. Each fixture
 * below was confirmed failing (finding nothing, or one token short) against
 * `fb5fa67e`, the head that introduced the closed list, before this file's
 * `classSiteTokens` grew the case that fixes it.
 */
const helperSource = (expr) => `export const Example = () => <div className={${expr}} />\n`

test('?? and || read both sides; + reads both sides of a concatenation', () => {
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), helperSource("cls ?? 'text-xs'")),
    [`${label('Example.tsx')}text-xs (font-size)`],
  )
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), helperSource("cls || 'text-xs'")),
    [`${label('Example.tsx')}text-xs (font-size)`],
  )
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), helperSource("'text-xs ' + extra")),
    [`${label('Example.tsx')}text-xs (font-size)`],
  )
})

test('as, as const, satisfies and ! all recurse into their expression', () => {
  const withConst = (expr) => `const cls = 'text-xs'\nexport const Example = () => <div className={${expr}} />\n`
  for (const expr of ["('text-xs' as string)", "('text-xs' as const)", "('text-xs' satisfies string)", 'cls!']) {
    assert.deepEqual(
      screenUtilityAppearanceOf(screenTsx('Example.tsx'), expr.startsWith("'") ? helperSource(expr) : withConst(expr)),
      [`${label('Example.tsx')}text-xs (font-size)`],
      expr,
    )
  }
  // `<T>x` is the same shape (recurse into `.expression`) but has no legal
  // spelling in a `.tsx` file — `<` opens a JSX element there — so it cannot
  // be fixture-tested on this parser; `screenUtilityDeclarationOf`'s dispatch
  // still names `ts.isTypeAssertionExpression` alongside the others.
})

test('an object literal yields its string-literal keys: clsx({ \'text-xs\': c })', () => {
  const source = "import { cn } from '../lib/utils'\nexport const Example = () => <div className={cn({ 'text-xs': c })} />\n"
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), source), [`${label('Example.tsx')}text-xs (font-size)`])
})

test('a spread inside an array joined with .join(\' \') reads every element', () => {
  const source = [
    "const B = ['bg-(--hd-card)']",
    "const SHIMMER = [...B, 'text-xs'].join(' ')",
    'export const Example = () => <span className={SHIMMER} />',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}bg-(--hd-card) (background)`, `${label('Example.tsx')}text-xs (font-size)`],
  )
})

test('an element access (TONE[t]) and optional chaining (o?.a) recurse into the object, not the key', () => {
  const mapSource = [
    "const TONE = { a: 'text-xs', b: 'rounded-full' }",
    'export const Example = () => <div className={TONE[t]} />',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), mapSource),
    [`${label('Example.tsx')}text-xs (font-size)`, `${label('Example.tsx')}rounded-full (border-radius)`],
  )
  const optionalSource = [
    "const o = { a: 'text-xs' }",
    'export const Example = () => <div className={o?.a} />',
  ].join('\n')
  assert.deepEqual(screenUtilityAppearanceOf(screenTsx('Example.tsx'), optionalSource), [`${label('Example.tsx')}text-xs (font-size)`])
})

test('a call this does not specifically recognize still reads its arguments and (for a method call) its object', () => {
  assert.deepEqual(
    screenUtilityAppearanceOf(
      screenTsx('Example.tsx'),
      "import { twMerge } from 'tailwind-merge'\nexport const Example = () => <div className={twMerge('text-xs', 'rounded-full')} />\n",
    ),
    [`${label('Example.tsx')}text-xs (font-size)`, `${label('Example.tsx')}rounded-full (border-radius)`],
  )
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), helperSource("buttonVariants({ variant: 'a' }) + ' text-xs'")),
    [`${label('Example.tsx')}text-xs (font-size)`],
  )
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), helperSource("buttonVariants({ className: 'text-xs' })")),
    [`${label('Example.tsx')}text-xs (font-size)`],
  )
  const filterJoinSource = [
    "const PARTS = ['text-xs', false]",
    "const SHIMMER = PARTS.filter(Boolean).join(' ')",
    'export const Example = () => <span className={SHIMMER} />',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), filterJoinSource),
    [`${label('Example.tsx')}text-xs (font-size)`],
  )
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), helperSource("String('text-xs')")),
    [`${label('Example.tsx')}text-xs (font-size)`],
  )
})

test('a call resolving to a local function const is walked through its return expressions only', () => {
  const source = [
    "const classFor = (k) => { if (k === 'a') return 'text-xs'; return 'rounded-full' }",
    'export const Example = () => <div className={classFor(k)} />',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}text-xs (font-size)`, `${label('Example.tsx')}rounded-full (border-radius)`],
  )
})

test('a reassigned let with += gathers that literal alongside the initializer', () => {
  const source = [
    "let c = 'text-xs'",
    "c += ' bg-(--hd-card)'",
    'export const Example = () => <div className={c} />',
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}text-xs (font-size)`, `${label('Example.tsx')}bg-(--hd-card) (background)`],
  )
})

test('style={s ?? {...}} reads both sides, and an imported style={S} is read at its definition', (t) => {
  assert.deepEqual(
    screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), 'export const Example = () => <div style={s ?? { color: "red" }} />\n'),
    ['style color'],
  )

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-style-import-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const components = path.join(root, 'packages/ui/src/components')
  fs.mkdirSync(components, { recursive: true })
  const definingFile = path.join(components, 'StyleBase.tsx')
  const consumingFile = path.join(components, 'StyleUser.tsx')
  fs.writeFileSync(definingFile, "export const S = { color: 'red' }\n")
  fs.writeFileSync(consumingFile, "import { S } from './StyleBase'\nexport const Example = () => <div style={S} />\n")
  assert.deepEqual(screenInlineStyleAppearanceOf(consumingFile, fs.readFileSync(consumingFile, 'utf8')), ['style color'])
})

test('a className written as an object key is a class site, the same as a JSX attribute', () => {
  // BrowserPane.tsx: createElement('webview', { className: `...` }).
  const source = [
    'export const Example = () =>',
    "  createElement('webview', { className: `border-0 bg-(--hd-card)` })",
  ].join('\n')
  assert.deepEqual(
    screenUtilityAppearanceOf(screenTsx('Example.tsx'), source),
    [`${label('Example.tsx')}border-0 (border)`, `${label('Example.tsx')}bg-(--hd-card) (background)`],
  )
})

test('an inline style counts its appearance keys and not its layout keys or an unresolvable reference', () => {
  const styleSource = 'export const Example = () => <div style={{ background: "red", width: 10 }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), styleSource), ['style background'])

  // A same-file object const is now resolved (item 4) — see the dedicated
  // fixture below. What is still unresolvable is a value this cannot chase
  // to any declaration at all: a function parameter, a prop, anything not a
  // `const` this file itself declares.
  const dynamicSource = 'export const Example = ({ obj }) => <div style={obj} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), dynamicSource), [])

  // camelCase -> kebab-case, including a vendor prefix, and a key already
  // spelled as a custom property is left exactly as written.
  const vendorSource = 'export const Example = () => <div style={{ WebkitTransform: "scale(1)", \'--near\': near }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), vendorSource), [])
})

/** Item 4: style shapes round 1 review found unused but unhandled. */
test('an inline style reads a shorthand key, a computed string key, satisfies, and a conditional', () => {
  const shorthandSource = 'const color = "red"\nexport const Example = () => <div style={{ color }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), shorthandSource), ['style color'])

  const computedSource = 'export const Example = () => <div style={{ [\'color\']: "red" }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), computedSource), ['style color'])

  const satisfiesSource = 'export const Example = () => <div style={{ color: "red" } satisfies React.CSSProperties} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), satisfiesSource), ['style color'])

  // Both branches read, not only the one a fixed `c` would pick.
  const conditionalSource = 'export const Example = () => <div style={c ? { color: "red" } : { background: "blue" }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), conditionalSource), ['style color', 'style background'])
})

/**
 * Item 5: the over-count round 1 review found — `GitPane.tsx`'s virtual list
 * sets `height: total * ROW`, and the empty-value path a real metric falls
 * through to (nothing looks like a reset or a layout share) was counting a
 * plain arithmetic expression as though it were one. A height-family key
 * with no literal value is decided explicitly as layout; every other
 * property is unaffected, since only height has a value-based rule at all.
 */
test('a dynamic height-family style value is not counted; a dynamic value on an ordinary property still is', () => {
  const heightSource = 'export const Example = () => <div style={{ height: total * ROW }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), heightSource), [])

  const minHeightSource = 'export const Example = () => <div style={{ minHeight: rowCount * ROW }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), minHeightSource), [])

  // A literal height value is unaffected — this is about an unknown value,
  // not about height keys generally.
  const literalSource = 'export const Example = () => <div style={{ height: 40 }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), literalSource), ['style height'])

  // An ordinary (non-height) property with a dynamic value is still counted
  // by property alone, as it always was — this decision is specific to the
  // height family's value rule, not a blanket "unknown value" refusal.
  const backgroundSource = 'export const Example = () => <div style={{ background: pick() }} />\n'
  assert.deepEqual(screenInlineStyleAppearanceOf(screenTsx('Example.tsx'), backgroundSource), ['style background'])
})

test('a visual kind prop cannot hide a component catalogue in one string union', () => {
  assert.deepEqual(
    visualKindUnionsOf(`
      type PartKind =
        | 'surface' | 'toolbar' | 'quiet' | 'meta' | 'path'
        | 'card' | 'row' | 'label' | 'warning'
      type PartProps = { kind: PartKind; children?: unknown }
    `),
    [{ prop: 'kind', type: 'PartKind', count: 9 }],
  )
  assert.deepEqual(
    visualKindUnionsOf(`
      type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
      type AlertProps = { tone: Tone }
    `),
    [],
  )
})


test('a slot this cannot see into is reported, not skipped', () => {
  // Hoisting the action out of the tag emptied the region of JSX, so every
  // rule passed it in silence — a bypass an ordinary refactor opens without
  // meaning to.
  assert.deepEqual(usage.slotOffenders('<PageHead t="x" actions={headerAction} />', 'F.tsx'), [
    "F.tsx: a page head's action is held in `headerAction`, which this cannot read",
  ])
  assert.deepEqual(usage.footerOffenders('<Dialog footer={renderFooter()} />', 'F.tsx'), [
    "F.tsx:1: a dialog's footer holds a part this cannot read",
  ])
  // An element that simply is not a button is legible, and is not the rule's
  // business.
  assert.deepEqual(usage.slotOffenders('<PageHead t="x" actions={<Chip>3</Chip>} />', 'F.tsx'), [])
})

test('parentheses do not hide a conditional', () => {
  // A formatter writes both of these, and a wrapper put the `?` at depth 1,
  // so a readable conditional was reported as unreadable.
  const both = ['outline', 'default']
  assert.deepEqual(usage.buttonsIn("<Btn variant={(c ? 'outline' : 'default')}>x</Btn>").map((one) => one.variant), both)
  assert.deepEqual(usage.buttonsIn("<Btn variant={c ? ('outline') : ('default')}>x</Btn>").map((one) => one.variant), both)
  // …and one that genuinely cannot be read still says so.
  assert.deepEqual(usage.buttonsIn("<Btn variant={(c ? 'outline' : other)}>x</Btn>").map((one) => one.variant), [null])
})

test('a long tag is read to its end', () => {
  // The scan capped a `<button>` at 400 characters and reported nothing
  // beyond it, which is the only reason the accent swatches were not counted.
  const padding = Array.from({ length: 40 }, (_, n) => `data-x${n}="0123456789"`).join(' ')
  const tag = `<button ${padding} className={styles.tiny}>x</button>`
  assert.ok(tag.length > 400)
  assert.deepEqual([...usage.attributes(tag, '<button'.length).keys()].includes('className'), true)
})

/*
 * `brands.mjs` decides which marks `build-icons` renders for the menu bar, and
 * it is the third parser here that fails by omission rather than by error.
 * Found in review (Cursor/Gemini 3.8 Flash on PR #90): the first version
 * matched a shape a brand was expected to have, and a key that did not fit it
 * was skipped rather than refused — which also left the count untouched, so
 * the floor guarding against a short read was satisfied by the very thing it
 * was meant to catch.
 */

const listOf = (...brands) =>
  `export const BRANDS = [\n${brands.map((brand) => `  '${brand}',`).join('\n')}\n] as const\n`

test('a brand the old shape-matching parser could not see is read, not skipped', () => {
  // `/'([a-z]+)',/g` matches neither of the last two. Skipping them is silent:
  // the marks are simply never rendered, and nothing anywhere says so.
  const source = listOf('codex', 'claudecode', 'gpt-5', 'o3-mini')
  assert.deepEqual(brandsIn(source), ['codex', 'claudecode', 'gpt-5', 'o3-mini'])
})

test('the floor cannot be satisfied by the omission it exists to catch', () => {
  // The bug in one line: four brands, a parser that sees two, a floor of two.
  // Reading every quoted string is what makes the floor mean something.
  const source = listOf('codex', 'claudecode', 'gpt-5', 'o3-mini')
  assert.equal(brandsIn(source, 4).length, 4)
  assert.throws(() => brandsIn(source, 5), /read only 4 brands/)
})

test('a brand named twice is refused rather than quietly deduplicated', () => {
  // `new Set` would have hidden it, and hidden it *as* a short read.
  assert.throws(() => brandsIn(listOf('codex', 'cursor', 'codex')), /names codex more than once/)
})

test('a source with no list at all is an error, not an empty answer', () => {
  assert.throws(() => brandsIn('export const OTHER = []\n'), /cannot find the BRANDS list/)
})

test('comments inside the list are not mistaken for brands', () => {
  const source = [
    'export const BRANDS = [',
    '  // Agents',
    "  'codex',",
    '  // Companies and models',
    "  'openai',",
    '] as const',
    '',
  ].join('\n')
  assert.deepEqual(brandsIn(source), ['codex', 'openai'])
})

test('quoted strings and contractions in comments inside BRANDS are not mistaken for brands (#489)', () => {
  const source = [
    'export const BRANDS = [',
    "  // Don't add unapproved marks here",
    "  'codex',",
    "  // 'codex' is the primary runtime",
    "  /* 'claudecode' and don't omit others */",
    "  'claudecode', // won't conflict with comment",
    '] as const',
    '',
  ].join('\n')
  assert.deepEqual(brandsIn(source), ['codex', 'claudecode'])
})

/*
 * `check-verify-drift`'s two parsers.
 *
 * This gate is the reason `pnpm verify` and CI cannot drift apart, and its own
 * header records the parser being silently wrong twice — a comment quoting a
 * `run(` call counted as a step that does not exist, and a block-comment regex
 * eating the middle of a test glob because `**​/*.test.js` contains a `/**​/`.
 * Both were found by a person noticing a wrong number, which is not a method.
 */

test('a gate step is read as the command line it becomes', () => {
  const source = [
    "step('build', () => run('pnpm', ['run', 'build']))",
    'step("tests", () => run("node", ["--test", "packages/*/dist/test/**/*.test.js"]))',
  ].join('\n')
  assert.deepEqual(gateCommands(source), [
    { command: 'pnpm', args: ['run', 'build'] },
    { command: 'node', args: ['--test', 'packages/*/dist/test/**/*.test.js'] },
  ])
})

test('a gate step with space between run and opening parenthesis is parsed (#401)', () => {
  const source = [
    "step('build', () => run ('pnpm', ['run', 'build']))",
    'step("tests", () => run  ("node", ["--test", "packages/*/dist/test/**/*.test.js"]))',
  ].join('\n')
  assert.deepEqual(gateCommands(source), [
    { command: 'pnpm', args: ['run', 'build'] },
    { command: 'node', args: ['--test', 'packages/*/dist/test/**/*.test.js'] },
  ])
})

test('gateCommands refuses when zero run calls are parsed (#401)', () => {
  const source = "const x = 1\nconsole.log('no steps')"
  assert.throws(() => gateCommands(source), /parsed zero run\(\.\.\.\) calls/)
})

test('gateCommands refuses run calls with non-literal arguments instead of dropping them (#402)', () => {
  const source = "const target = 'script/check-layering.mjs'\nrun('node', [target])"
  assert.throws(() => gateCommands(source), /run\(\.\.\.\) calls and this check could read 0/)
})

test('a test glob survives the comment stripper that once ate it', () => {
  // The bug: `/**​/` inside the glob opened a block comment, and every command
  // after it vanished — silently, because a shorter list still parses.
  const source = [
    "step('tests', () => run('node', ['--test', 'packages/*/dist/test/**/*.test.js']))",
    "step('after', () => run('node', ['script/check-secrets.mjs']))",
  ].join('\n')
  const read = gateCommands(source)
  assert.equal(read.length, 2, 'the command after the glob must still be seen')
  assert.deepEqual(read[1], { command: 'node', args: ['script/check-secrets.mjs'] })
})

test('a run( inside a comment is prose, not a step', () => {
  const source = [
    "// this used to be a bare run('pnpm', ['nonsense']) call",
    " * quoting run('node', ['gone.mjs']) in a doc comment",
    "step('real', () => run('node', ['script/check-secrets.mjs']))",
  ].join('\n')
  assert.deepEqual(gateCommands(source), [{ command: 'node', args: ['script/check-secrets.mjs'] }])
})

test('CI steps are read whichever way the workflow spells them', () => {
  const yaml = [
    'jobs:',
    '  verify:',
    '    steps:',
    '      - name: Build',
    '        run: pnpm run build',
    '      - name: Folded',
    '        run: >',
    '          node script/check-secrets.mjs',
    '          --strict',
    '      - uses: actions/checkout@v7',
  ].join('\n')
  const read = ciCommands(yaml)
  assert.ok(read.includes('pnpm run build'), 'the inline command, on its own')
  // A folded scalar is one command, not one command per line.
  assert.ok(read.includes('node script/check-secrets.mjs --strict'), 'the folded command, joined into one')
})

test('quoting style does not change what CI is seen to run', () => {
  const yaml = ['    steps:', '      - run: node --test "script/*.test.mjs"'].join('\n')
  // The comparison strips quotes on both sides; a formatter must not be able
  // to make a step disappear by rewriting them.
  assert.ok(ciCommands(yaml).includes('node --test script/*.test.mjs'), 'the quoted glob')
})

test('a gate command that is only part of a CI command is not in CI (#247)', () => {
  const workflow = ciCommands(['    steps:', '      - run: pnpm run build'].join('\n'))
  // The control: the whole command is there, and is not reported.
  assert.deepEqual(missingFromCI([{ command: 'pnpm', args: ['run', 'build'] }], workflow), [])
  // And a prefix of it is not a command CI runs, though it reads as one to a search through joined text.
  assert.deepEqual(missingFromCI([{ command: 'pnpm', args: ['run'] }], workflow), ['pnpm run'])
})

test('NOT_IN_CI exemption matches exact command line and cannot be injected by extra args (#403)', () => {
  const workflow = ciCommands(['    steps:', '      - run: pnpm run build'].join('\n'))
  // An extra argument mentioning an exempted script must not exempt an unrelated command.
  const gate = [
    { command: 'node', args: ['script/check-layering.mjs', 'script/generate-codex-protocol.mjs'] },
  ]
  assert.deepEqual(missingFromCI(gate, workflow), [
    'node script/check-layering.mjs script/generate-codex-protocol.mjs',
  ])
})

test('check-verify-drift preserves argument boundaries and distinguishes args with spaces from separate args (#404)', () => {
  // Gate has one argument containing a space: '--name=a b'
  const gate = [{ command: 'node', args: ['script/tool.mjs', '--name=a b'] }]

  // CI has two separate arguments: '--name=a' and 'b'
  const separateArgs = ciCommands(['    steps:', '      - run: node script/tool.mjs --name=a b'].join('\n'))
  assert.deepEqual(missingFromCI(gate, separateArgs), ['node script/tool.mjs --name=a b'])

  // CI has one argument with quotes: '--name=a b'
  const quotedArg = ciCommands(['    steps:', '      - run: node script/tool.mjs "--name=a b"'].join('\n'))
  assert.deepEqual(missingFromCI(gate, quotedArg), [])

  // CI has single quotes: '--name=a b'
  const singleQuotedArg = ciCommands(['    steps:', "      - run: node script/tool.mjs '--name=a b'"].join('\n'))
  assert.deepEqual(missingFromCI(gate, singleQuotedArg), [])
})

/**
 * `check-reachable` decides which host methods a surface can call, and both of
 * its halves fail silently in the same direction: a parser that finds fewer
 * methods, or a matcher that finds more callers, makes the gate green. It
 * would then be a check that cannot fail, which is the shape of thing this
 * file exists for.
 */

test('the method list is the validator table\u2019s own keys, not the fields inside them', () => {
  /* The trap this parser is written around. A params table nests its fields at
     four spaces, and several of them are named with a slash in the value — so
     a looser pattern reads `readonly runtime` or a nested `'a/b'` as a method
     and the list grows entries no host answers. Two spaces and a slash is the
     shape of a key. */
  const source = [
    "const paramsValidators = {",
    "  'session/list': shape({ runtime: isString }),",
    "  'team/post': shape({",
    "    'not/a/method': isString,",
    "    runtime: isString,",
    "  }),",
    "}",
  ].join('\n')
  assert.deepEqual(methodsIn(source), ['session/list', 'team/post'])
})

test('a hyphenated method name is on the list, not skipped', () => {
  /* `\w` has no `-`, so `'flow/start-goal':` failed the key pattern outright
     and the method was invisible to the gate — neither counted nor flagged.
     Found during the flows work; the control is `session/list` beside it. */
  const source = [
    "const paramsValidators = {",
    "  'session/list': shape({ runtime: isString }),",
    "  'flow/start-goal': shape({ room: isString }),",
    "  'agent-pool/lease-one': shape({}),",
    "}",
  ].join('\n')
  assert.deepEqual(methodsIn(source), ['session/list', 'flow/start-goal', 'agent-pool/lease-one'])
  assert.deepEqual([...reachedBy(['flow/start-goal'], ["await request('flow/start-goal', { room })"])], ['flow/start-goal'])
})

test('a longer method name does not make a shorter one look called', () => {
  /* `plugin/install` is a suffix of `runtime/plugin/install`, and both are
     real methods on this wire. A substring match on the bare name reads the
     one as the other — so the whole quoted literal is matched, quote
     included. Without the quotes this assertion is the control: it fails. */
  const methods = ['plugin/install', 'runtime/plugin/install']
  const reached = reachedBy(methods, ["await request('runtime/plugin/install', { runtime })"])
  assert.deepEqual([...reached], ['runtime/plugin/install'])
})

test('a method named in a comment is not a caller', () => {
  /* The failure that turns a check into decoration: the gate could be made
     green by writing its own excuse. Found in review, with this reproduction
     — `reachedBy(['team/state'], ["// 'team/state' is not a call"])` used to
     answer that it was. */
  const methods = ['team/state']
  assert.deepEqual([...reachedBy(methods, ["// 'team/state' is not a call"])], [])
  assert.deepEqual([...reachedBy(methods, ["/* was 'team/state' */"])], [])
  assert.deepEqual([...reachedBy(methods, ["const x = 1 // see 'team/state'"])], [])
  // The control: an actual call still counts.
  assert.deepEqual([...reachedBy(methods, ["await request('team/state', { room })"])], ['team/state'])
})

test('the method list stops at the validator table, not at the end of the file', () => {
  /* `slice(indexOf('paramsValidators'))` ran to EOF, so any later two-space
     object literal with a slash-separated key would be read as a method the
     host answers. Review found it; nothing in the file does that today, which
     is how long it would have stayed true. */
  const source = [
    "const paramsValidators = {",
    "  'session/list': shape({ runtime: isString }),",
    "}",
    "",
    "const somethingElse = {",
    "  'not/a/method': 1,",
    "}",
  ].join('\n')
  assert.deepEqual(methodsIn(source), ['session/list'])
})

test('a method group spread into the validator table is on the list', () => {
  /* `...goalValidators,` assembled goal/*, insight/* and finding/* into the
     table from literals declared above it, and the parser read only the
     table's own lines — every one of those methods was invisible to the gate.
     The spread is followed to its own declaration; `unrelated` beside it is
     the control that a literal nobody spreads is still not read. */
  const source = [
    "const goalValidators = {",
    "  'goal/list': goalShape({}),",
    "  'goal/create': goalShape({",
    "    'not/a/method': isString,",
    "  }),",
    "}",
    "const unrelated = {",
    "  'not/a/method': 1,",
    "}",
    "const paramsValidators = {",
    "  'session/list': shape({ runtime: isString }),",
    "  ...goalValidators,",
    "  'team/post': shape({}),",
    "}",
  ].join('\n')
  assert.deepEqual(methodsIn(source), ['session/list', 'goal/list', 'goal/create', 'team/post'])
  // A spread that names nothing declared fails loudly rather than dropping a group.
  assert.throws(() => methodsIn("const paramsValidators = {\n  ...missingValidators,\n}"), /missingValidators/)
})

test('the real validator table: every spread group is read, and every method is reachable or pinned', () => {
  /* The end-to-end half of the test above, against the file as it is. Before
     spreads were followed this list had no goal/* or insight/* entry at all. */
  const methods = methodsIn(fs.readFileSync(path.join(repoRoot, 'packages/protocol/src/wire-validators.ts'), 'utf8'))
  for (const method of ['goal/list', 'insight/usage']) assert.ok(methods.includes(method), method)
  const run = spawnSync(process.execPath, [path.join(repoRoot, 'script/check-reachable.mjs')], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr + run.stdout)
})

test('a method name held in a variable is not a caller either', () => {
  /* The half stripping comments did not reach, found in review round 2 with
     its own reproduction: `const marker = 'team/inbound'` counted. A method
     name has to be an argument to something — measured first, because a rule
     that narrows can only be worth having if nothing real is written the
     other way, and all 169 reachable methods are calls today. */
  const methods = ['team/inbound']
  assert.deepEqual([...reachedBy(methods, ["const marker = 'team/inbound'"])], [])
  assert.deepEqual([...reachedBy(methods, ["const list = ['team/inbound']"])], [])
  assert.deepEqual([...reachedBy(methods, ["export const NAME = 'team/inbound' as const"])], [])
  /* And not any call either — round 3's finding. `reachable` means a
     dispatch, so a name printed, logged, or passed to something else is not
     one however it is punctuated. */
  assert.deepEqual([...reachedBy(methods, ["console.log('team/inbound')"])], [])
  assert.deepEqual([...reachedBy(methods, ["track('event', 'team/inbound')"])], [])
  assert.deepEqual([...reachedBy(methods, ["describe('team/inbound', () => {})"])], [])

  // The controls: both shapes a real call is written in.
  assert.deepEqual([...reachedBy(methods, ["await request('team/inbound', { mode })"])], ['team/inbound'])
  assert.deepEqual(
    [...reachedBy(methods, ["await this.transport.request(\n  'team/inbound',\n  { mode },\n)"])],
    ['team/inbound'],
  )
})

test('the test glob is written one way everywhere it is run (#256)', () => {
  // Five encodings of one glob: the two runners, the two workflows, and prune-dist's own reading of dist.
  const repo = repoRoot
  for (const file of ['package.json', 'script/verify.mjs', '.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    assert.ok(text.includes(TEST_GLOB), `${file} runs the tests by the glob prune-dist.mjs writes`)
  }
})

test('the step that reads what the build writes says that it needs it (#208)', () => {
  const repo = repoRoot
  const verify = fs.readFileSync(path.join(repo, 'script/verify.mjs'), 'utf8')
  const at = verify.indexOf("step('node tests'")
  assert.notEqual(at, -1, 'verify.mjs still has a node tests step')
  const declared = verify.slice(at, verify.indexOf('\n)', at))
  assert.match(declared, /\{ needs: 'build' \}/, 'the node tests would otherwise run over the dist a failed build left')
})

test('a rule about what is inside a control is not a rule about the control (#185)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-subject-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'x.module.css')
  fs.writeFileSync(
    file,
    [
      '.onTask svg { width: 13px; height: 13px; }',
      '.card > .dot, .list .dot { width: 8px; height: 8px; }',
      '.pill:hover { width: 24px; height: 24px; }',
      '.grid [data-mark] { width: 9px; height: 9px; }',
      '.mark:not(.a .b) { width: 10px; height: 10px; }',
    ].join('\n'),
  )
  const found = squaresOf(file)
  assert.equal(found.has('onTask'), false, 'the 13px is the icon inside the button')
  assert.equal(found.get('dot'), 8, 'both selectors of the list are about the dot')
  assert.equal(found.has('card'), false)
  assert.equal(found.has('list'), false)
  assert.equal(found.get('pill'), 24, 'a pseudo-class is part of the subject')
  assert.equal(found.has('grid'), false, 'an attribute subject is about no class')
  assert.equal(found.get('mark'), 10, 'a space inside :not() separates nothing')
})

test('a rule on two classes at once is a rule about both of them (#267)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-subject-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'x.module.css')
  fs.writeFileSync(file, ['.solo { width: 20px; height: 20px; }', '.foo.bar { width: 22px; height: 22px; }'].join('\n'))
  const found = squaresOf(file)
  // The control: a subject wearing one class is read the same either way.
  assert.equal(found.get('solo'), 20, 'a single-class subject is still read')
  assert.equal(found.get('bar'), 22, 'the last class of the compound was always read')
  // `.foo.bar` is one element wearing two names, and the component may reach
  // it by either. Filing the rule under the last name alone left it invisible
  // to a button carrying `styles.foo`, which is the lookup that counts.
  assert.equal(found.get('foo'), 22, 'every class on the subject compound names the same element')
})

test('a bare :is() is the subject rather than a pseudo-class to strip (#267)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-subject-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'x.module.css')
  fs.writeFileSync(
    file,
    [
      '.solo { width: 20px; height: 20px; }',
      ':is(.alpha, .beta) { width: 21px; height: 21px; }',
      ':where(.gamma) { width: 23px; height: 23px; }',
      '.delta:is(.epsilon) { width: 25px; height: 25px; }',
    ].join('\n'),
  )
  const found = squaresOf(file)
  // The control: stripping `(…)` is right for every other pseudo-class, and
  // an ordinary subject must keep reading the same.
  assert.equal(found.get('solo'), 20, 'an ordinary subject is unaffected')
  assert.equal(found.get('delta'), 25, 'a class outside the :is() names the subject, as it always did')
  // Stripping `(…)` left `:is`, which holds no class, so the rule was filed
  // under nothing at all — the one shape where the parentheses *are* the
  // subject rather than a statement about other elements.
  assert.equal(found.get('alpha'), 21, 'both arguments of a bare :is() are the subject')
  assert.equal(found.get('beta'), 21)
  assert.equal(found.get('gamma'), 23, ':where() is the same shape at no specificity')
  // Conservative on purpose: an element matching `.delta:is(.epsilon)` is
  // named `delta`, and `epsilon` only narrows which deltas. A rule about a
  // 25px delta is not a rule about every epsilon.
  assert.equal(found.has('epsilon'), false, 'a class that only narrows the subject does not become one')
})

test('a parenthesis inside an attribute value separates nothing (#267)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-subject-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'x.module.css')
  fs.writeFileSync(file, ['.a[data-x="("], .b .c { width: 24px; height: 24px; }', '.solo { width: 20px; height: 20px; }'].join('\n'))
  const found = squaresOf(file)
  // The control: the rule is read, and its last selector was always right.
  assert.equal(found.get('solo'), 20)
  assert.equal(found.get('c'), 24, 'the last selector of the list was always read')
  // The `(` in the value raised the depth that the closing `]` lowered once,
  // so every separator after it looked nested: the comma never split the
  // list, and the first selector of the rule was dropped on the floor.
  assert.equal(found.get('a'), 24, 'the comma after a quoted ( still separates the list')
  assert.equal(found.has('b'), false, 'a descendant of the subject is not the subject')
})

test('the audit reads a stylesheet imported from another folder, and one behind the alias (#185)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-sheets-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  write('design/ui/kit.module.css', '.pill { width: 20px; height: 20px; }\n')
  write('screens/one/one.module.css', '.own { color: red; }\n')
  const source = [
    "import own from './one.module.css'",
    "import kit from '../../design/ui/kit.module.css'",
    "import aliased from '@/design/ui/kit.module.css'",
  ].join('\n')
  const dir = path.join(root, 'screens/one')
  const { sheets, crossImports } = sheetsOf(dir, path.join(dir, 'One.tsx'), 'screens/one/One.tsx', source, root)
  assert.deepEqual([...sheets.keys()], ['own', 'kit', 'aliased'])
  // Both spellings land on the same file on disk, which is what the audit reads classes from.
  assert.deepEqual([...sheets.get('kit').classes], ['pill'])
  assert.deepEqual([...sheets.get('aliased').classes], ['pill'])
  assert.equal(sheets.get('own').file, 'one.module.css')
  // And both are another screen's, the alias resolved beside what was written.
  assert.deepEqual(crossImports, [
    'screens/one/One.tsx imports ../../design/ui/kit.module.css',
    'screens/one/One.tsx imports @/design/ui/kit.module.css (../../design/ui/kit.module.css)',
  ])
})

test('a stylesheet cannot grant itself a new co-owner', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-style-owner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'components')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'Family.module.css'), '/* @design-owners Child */\n.row { display: flex; }\n')
  const allowed = sheetsOf(dir, path.join(dir, 'Child.tsx'), 'components/Child.tsx', "import styles from './Family.module.css'", root)
  const refused = sheetsOf(dir, path.join(dir, 'Stranger.tsx'), 'components/Stranger.tsx', "import styles from './Family.module.css'", root)
  assert.equal(allowed.crossImports.length, 1)
  assert.equal(refused.crossImports.length, 1)
})

test('a recorded stylesheet family accepts only its capped owner and declared annotation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-style-cap-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'components')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'Sidebar.module.css'), '/* @design-owners SessionTree, NewOwner */\n.row { display: flex; }')
  const inspect = (name) => sheetsOf(dir, path.join(dir, `${name}.tsx`), `components/${name}.tsx`, "import styles from './Sidebar.module.css'", root)
  assert.deepEqual(inspect('SessionTree').crossImports, [])
  assert.equal(inspect('NewOwner').crossImports.length, 1)
})

test('a glob that ends in a double star takes the rest of the path (#263)', () => {
  const deep = globToRegExp('packages/**')
  assert.ok(deep.test('packages/ui'), 'one segment under it')
  assert.ok(deep.test('packages/ui/dist/test/a.test.js'), 'and everything below that')
  assert.equal(deep.test('packages'), false, 'the directory itself is not under itself')
  // The control: the glob this repository actually runs reads the same as before.
  assert.ok(globToRegExp(TEST_GLOB).test('packages/server/dist/test/a/b.test.js'))
})

test('prune-dist refuses a test glob of another shape rather than reading the wrong segments (#263)', () => {
  // The control: today's glob is the shape it expects, and gives the three segments the walk needs.
  assert.deepEqual(distSegments(TEST_GLOB), { top: 'packages', dist: 'dist', tests: 'test' })
  assert.throws(() => distSegments('out/**/*.test.js'), /not that shape/, 'too few segments')
  assert.throws(() => distSegments('packages/ui/dist/test/**/*.test.js'), /not that shape/, 'the package segment must be the wildcard')
})

test('a step that needs a step nobody declared stops the run (#263)', () => {
  const written = []
  const sink = { write: (text) => written.push(text) }
  const { step } = createSteps({ out: sink, err: sink, exit: () => {} })
  step('build', () => {})
  assert.throws(() => step('node tests', () => {}, { needs: 'biuld' }), /no step before it declares/)
  // The control: spelled right, the same step is allowed and runs.
  assert.equal(
    step('node tests', () => {}, { needs: 'build' }),
    true,
  )
})

test('the documents are held to naming every step the gate runs (#246)', () => {
  const verify = ["step('build', () => run('pnpm', ['run', 'build']))", "// step('ghost', …) named in a comment is not a step", "step('gate tests', () => run('node', ['--test']))"].join('\n')
  assert.deepEqual(stepNames(verify), ['build', 'gate tests'])

  const described = new Map([['build', /the build/i]])
  const both = { 'AGENTS.md': 'it runs the build', 'CONTRIBUTING.md': 'the build, and more' }
  // The control: a step both documents name is not a problem.
  assert.deepEqual(problemsWith(['build'], both, described), [])
  // One document falling silent is what this exists to catch.
  const half = problemsWith(['build'], { ...both, 'AGENTS.md': 'it runs everything' }, described)
  assert.equal(half.length, 1)
  assert.match(half[0], /AGENTS\.md does not name it/)
  // A step nobody described says what to do about it, rather than passing.
  assert.match(problemsWith(['new gate'], both, described)[0], /no entry here/)
  // And an entry for a step that is gone is stale, not harmless.
  assert.match(problemsWith([], both, described)[0], /no longer runs it/)

  // The documents are hard-wrapped: a phrase the wrapping broke in two is still the document naming it.
  const wrapped = { 'AGENTS.md': 'it runs the\nbuild', 'CONTRIBUTING.md': 'the build' }
  assert.deepEqual(problemsWith(['build'], wrapped, described), [])
})

test('a section is read to the next heading, and a renamed one is empty rather than the whole file (#246)', () => {
  const doc = ['# Title', '', '## The gate', '', 'it runs the build', '', '## Commits', '', 'unrelated prose'].join('\n')
  assert.match(sectionOf(doc, '## The gate'), /it runs the build/)
  assert.equal(/unrelated/.test(sectionOf(doc, '## The gate')), false)
  assert.equal(sectionOf(doc, '## Renamed'), '')
})

test('a comment after a closing bracket, a dot or a semicolon is stripped too (#123)', () => {
  // The pattern only opened a comment after start, whitespace or one of `{([,=:`.
  for (const source of ['getValue()/* Codex */', '};/* Codex */', 'list[0]/* Codex */', 'a./* Codex */b', 'x;// Codex']) {
    assert.doesNotMatch(withoutComments(source), /Codex/, source)
  }
  // And a string keeps what only looks like a comment inside it.
  assert.match(withoutComments("const s = '/* Codex */'"), /Codex/)
})

test("a block comment keeps its line breaks, so a line number read from the result is the file's (#123)", () => {
  const lines = withoutComments('a\n/* one\ntwo */\nb Codex').split('\n')
  assert.equal(lines.length, 4)
  assert.equal(lines.findIndex((line) => line.includes('Codex')), 3)
})

test('a regex literal holding a backtick opens no template string, so what follows it is still read (#123)', () => {
  // Items.tsx, where a scan that skipped quoted strings lost its place for sixty lines.
  const source = "const parts = text.split(/(`[^`\\n]+`)/g)\n/** Codex */\nconst a = 1\n"
  assert.doesNotMatch(withoutComments(source), /Codex/)
})

test('JSX text is text: an apostrophe opens no string, and a // in it is not a comment (#123)', () => {
  assert.doesNotMatch(withoutComments("const A = () => <p>Don't {/* Codex */} go</p>\n", 'a.tsx'), /Codex/)
  assert.match(withoutComments('const A = () => <p>// Codex</p>\n', 'a.tsx'), /\/\/ Codex/)
})

test('a .ts file is parsed as TypeScript, so a generic arrow is not read as a JSX tag (#123)', () => {
  assert.doesNotMatch(withoutComments('const id = <T,>(x: T) => x // Codex\n', 'a.ts'), /Codex/)
  assert.doesNotMatch(withoutComments('const id = <T>(x: T) => x // Codex\n', 'a.ts'), /Codex/)
})

test("a doc comment comes out whole, even with a // after a link inside it (#123)", () => {
  // The comment's own nodes sit inside it; reading trivia at them re-emitted the lines after the link.
  const out = withoutComments('/**\n * See {@link Foo} // then more\n * Codex\n */\nconst a = 1\n')
  assert.doesNotMatch(out, /Codex/)
  assert.equal(out.split('\n').length, 6)
})

test("a .tsx caller is parsed as TSX, so a call after a // in JSX text still counts (#123)", () => {
  // Parsed as TypeScript, the // in the JSX text opened a comment and took the call with it.
  const source = "const A = () => <p>see // {request('team/state')}</p>\n"
  assert.deepEqual([...reachedBy(['team/state'], [{ file: 'a.tsx', text: source }])], ['team/state'])
})

test('a .js file is read as JavaScript, JSX and all, so a comment after a tag goes (review of #228, round 1)', () => {
  // Read as TypeScript, `</p> // Codex` was a regex literal and the comment stayed.
  assert.doesNotMatch(withoutComments('const A = () => <p>x</p> // Codex\n', 'r.js'), /Codex/)
  assert.doesNotMatch(withoutComments('const a = 1 // Codex\n', 'r.cjs'), /Codex/)
})

test('a file TypeScript could not parse is refused by name when a gate reads it (review of #228, round 1)', () => {
  assert.throws(() => withoutComments('const = ;\n', 'bad.ts', { strict: true }), /bad\.ts:1: TypeScript could not parse this file/)
  // Leniently, what a test hands it is still stripped: an unterminated comment at the end is a comment.
  assert.doesNotMatch(withoutComments('const a = 1 /* Codex', 'fine.ts'), /Codex/)
})

test("code the old pattern deleted stays: a // in a regex literal, and a comment in a template's text (review of #228, round 1)", () => {
  assert.ok(withoutComments("const path = uri.replace(/^file:\\/\\//, '')\n").includes("/^file:\\/\\//, '')"))
  assert.ok(withoutComments('const page = `/** Fields whose value must never leave the page */ keep`\n').includes('Fields whose value'))
})

test('reachedBy refuses a caller file TypeScript could not parse, by name (review of #228, round 2)', () => {
  /* `withoutComments`'s own refusal was tested directly and never through the
     caller that uses it. `check-reachable` hands every real caller file over
     as `{ file, text }` so it is parsed as what it is, and `strict` is what
     makes an unreadable one stop the gate: a recovered parse can leave a
     comment inside a token, and a method named in that comment would count as
     a call — which is the one failure that turns this check into decoration. */
  assert.throws(
    () => reachedBy(['team/state'], [{ file: 'broken.ts', text: "const = ;\nawait request('team/state')\n" }]),
    /broken\.ts:1: TypeScript could not parse this file/,
  )
  // The controls: a caller file that parses still counts, and a bare string is still read leniently.
  assert.deepEqual([...reachedBy(['team/state'], [{ file: 'fine.ts', text: "await request('team/state')\n" }])], ['team/state'])
  assert.deepEqual([...reachedBy(['team/state'], ["await request('team/state')\n"])], ['team/state'])
})

test('a .jsx file is read as JavaScript, which is the branch it now shares (review of #228, round 2)', () => {
  /* `kindOf` named `ScriptKind.JSX` in a branch of its own that nothing could
     reach — neither gate reads a `.jsx`. The parser gives JS and JSX one
     language variant, so the extension belongs on the JS branch and the dead
     one is gone. Read as TypeScript, `</p> // Codex` is a regex literal and
     the comment survives, which is what this asserts is not happening. */
  assert.doesNotMatch(withoutComments('const A = () => <p>x</p> // Codex\n', 'r.jsx'), /Codex/)
  // The control: the extension is what decides, and a `.ts` is still TypeScript.
  assert.match(withoutComments('const A = () => <p>x</p> // Codex\n', 'a.ts'), /Codex/)
})

/**
 * The gates that read this repository's own text.
 *
 * Same class of failure as the parsers above, one subject over: a check that
 * reads the documentation, the tracked files or the verify roster imprecisely
 * does not report a wrong answer — it goes quiet. An empty section passes
 * nothing and looks like the documents falling silent; a pattern that matches
 * any mention of a word cannot fail; a path nobody resolved is a path nobody
 * checked (#204, #223, #269).
 */

test('a repository path in the documentation that resolves nowhere fails (#223)', () => {
  const named = new Map([['packages/ui/src/state/store.ts', new Set(['docs/architecture.md'])]])
  // The control: a path that resolves from some base is not a problem.
  assert.deepEqual(docPathProblems(named, () => true, new Map()), [])
  /* Mis-rooted is the shape #94 reported and #189 fixed by hand: the file is
     real, the path written for it is not, and nothing read the prose. */
  const problems = docPathProblems(named, () => false, new Map())
  assert.equal(problems.length, 1)
  assert.match(problems[0], /resolves nowhere/)
  assert.match(problems[0], /docs\/architecture\.md/, 'the report names the document to edit')
})

test('an allowlisted doc path is held to its own reason (#223)', () => {
  const value = 'rmcp-client/src/oauth/store_lock.rs'
  const named = new Map([[value, new Set(['docs/runtimes.md'])]])
  const allowed = new Map([[value, "DeepSeek Harness's own Rust source"]])
  // The control: a named path that resolves nowhere is exactly what the entry is for.
  assert.deepEqual(docPathProblems(named, () => false, allowed), [])
  /* An exception that outlives its reason is a hole nobody decided to leave
     open, so both ways it can go stale are reported. Same idiom as a
     DESCRIBED_AS entry for a step the gate no longer runs. */
  assert.match(docPathProblems(named, () => true, allowed)[0], /it resolves now/)
  assert.match(docPathProblems(new Map(), () => false, allowed)[0], /no document names it/)
})

test('documented repository paths resolve only through tracked files', () => {
  const value = 'docs/architecture.md'
  assert.equal(docPathBasesFor(repoRoot, new Set())(value, 'README.md'), false)
  assert.equal(docPathBasesFor(repoRoot, new Set([value]))(value, 'README.md'), true)
})

test('what counts as a documented repository path (#223)', () => {
  // The controls: both shapes the documents really use — rooted, and package-relative.
  assert.deepEqual(pathsIn('see `packages/ui/src/lib/burn.ts` and `lib/limits.ts`'), [
    'packages/ui/src/lib/burn.ts',
    'lib/limits.ts',
  ])
  /* A path on the reader's machine, a glob, a placeholder, a URL, an npm
     specifier, a shell command, a CSS value and a bare directory are none of
     them files in this tree, and a gate that failed on them would be turned
     off within a week. */
  for (const text of [
    '`~/.codex/config.toml`',
    '`$CODEX_HOME/auth.json`',
    '`~/.claude/agents/*.md`',
    '`packages/server/src/methods/<domain>.ts`',
    '`@google/gemini-cli@0.58.0`',
    '`node script/diagram-export.mjs`',
    '`https://example.com/a.ts`',
    '`0 24px 60px / 0.3`',
    '`packages/plugins`',
  ]) {
    assert.deepEqual(pathsIn(text), [], text)
  }
})

test('an invented path in a fenced sample is a candidate, and ALLOWED is its escape hatch (#223)', () => {
  /* The expensive direction for this gate is the false red, and this is its
     shape: a fenced sample naming a file in the *reader's* project reads
     exactly like a path in ours, because `pathsIn` has no view of fences. That
     is deliberate — a real path inside a fenced block has to resolve too — so
     the way out is the allowlist, and this is what using it looks like.
     `src/server.js` is the entry the tree really carries for this reason
     (asked for in round 1 of #278, so the hatch is visible before someone
     meets it as a red build). */
  const sample = ['```md', 'Add a card that says: fix `src/server.js`', '```'].join('\n')
  assert.deepEqual(pathsIn(sample), ['src/server.js'], 'a fence does not hide a candidate')
  const named = new Map([['src/server.js', new Set(['docs/rooms.md'])]])
  // Without an entry it is a red gate, which is the report a contributor meets first.
  assert.match(docPathProblems(named, () => false, new Map())[0], /resolves nowhere/)
  // With one, the gate is green and the reason is on the record beside the path.
  const allowed = new Map([['src/server.js', "an invented file name in a demo board card"]])
  assert.deepEqual(docPathProblems(named, () => false, allowed), [])
})

test('every allowlisted doc path still names something outside this tree (#223)', () => {
  const repo = repoRoot
  for (const [value, reason] of ALLOWED) {
    assert.equal(fs.existsSync(path.join(repo, value)), false, `${value} is in this tree now: drop the entry`)
    assert.ok(reason.length > 20, `${value} needs a reason, not a label`)
  }
})

test('gate test scripts use fileURLToPath instead of URL.pathname for file URL resolution (#484)', () => {
  // On Windows, raw URL pathname includes a leading slash before the drive letter (/C:/...)
  // which causes path.win32.resolve to lose the drive root, whereas fileURLToPath is the standard Node method.
  const rawPathname = '/C:/Users/dev/HarnessDesk/script/gates.test.mjs'
  assert.equal(path.win32.resolve(path.win32.dirname(rawPathname), '..'), '\\C:\\Users\\dev\\HarnessDesk')

  const gatesTestSrc = withoutComments(fs.readFileSync(path.join(repoRoot, 'script/gates.test.mjs'), 'utf8'))
  const badPattern = new RegExp(['new\\s+URL\\(', 'import\\.meta\\.url', '\\)\\.pathname'].join(''))
  assert.doesNotMatch(
    gatesTestSrc,
    badPattern,
    'script/gates.test.mjs must resolve repository paths without URL pathname',
  )
})

test("a real account's address in a tracked file fails the secrets scan (#204)", () => {
  /* The controls: every address convention rule 13 names, and the shapes an
     address appears in without being anybody's mailbox. All of these are lines
     really in the tree — the git tests write four kinds of remote. */
  for (const line of [
    "const to = 'dev@example.com'",
    "const to = 'olivia@acme.dev'",
    "const to = 'shane@harnessdesk.app'",
    "git('-c', 'user.email=t@example.invalid', 'commit')",
    "await git(dir, 'remote', 'add', 'origin', 'git@github.com:openma/harnessdesk.git')",
    "await git(dir, 'remote', 'add', 'origin', 'ssh://deploy@github.com/openma/harnessdesk.git')",
    "await git(dir, 'remote', 'add', 'origin', 'ssh://git@github.com:22/openma/harnessdesk.git')",
    "await git(dir, 'remote', 'add', 'origin', 'ssh://git@github.com')",
    "expect(repoKey('git@github.com-work:AcmeCo/ledger-api.git')).toBe('github.com/acmeco/ledger-api')",
    '<InputGroupInput {...control} placeholder="git@github.com:…" />',
    /* The scp arm's own control: a remote whose user is not one of the service
       names, so nothing but the host-then-path shape can excuse it. Without a
       line like this the arm is unreachable from the tests — every scp remote
       the tree writes today says `git@`, and a rule no test can reach is a
       rule nothing holds. */
    "await git(dir, 'remote', 'set-url', 'origin', 'deploy@github.com:openma/harnessdesk.git')",
    /* The other two forges the tree writes, so the roster is exercised rather
       than merely declared: drop either name and one of these goes red. */
    "await git(dir, 'remote', 'set-url', 'origin', 'deploy@gitlab.com:openma/harnessdesk.git')",
    "await git(dir, 'remote', 'set-url', 'origin', 'deploy@bitbucket.org:openma/harnessdesk.git')",
    "'https://review-user:fake-secret@github.com/openma/harnessdesk.git'",
    "const spoof = 'http://127.0.0.1:54321@evil.com/steal'",
    /* A percent-encoded userinfo: the allowlist has to carry `%` and `:`, and
       nothing else in the tree spells both. */
    "const url = 'https://user%40name:pass@northwind.invalid/repo.git'",
    "render('menubar.svg', 50, 36, join(assetsDir, 'trayTemplate@2x.png'))",
  ]) {
    assert.deepEqual(offendersIn('a.ts', line), [], line)
  }
  /* Every shape that puts a character after an address and used to be excused
     for it. The exemption was a bare `^[:/]` on the next character, so a prose
     clause, a port, a smiley and a trailing path all read as a git remote —
     and the retina rule matched a domain *prefix*, so any host under a `2x.`
     subdomain read as an image file. All three seats measured this class in
     round 1 of #278: the gate passing a real address is the one failure it
     exists to prevent.

     The domains are RFC 2606 `.invalid` names rather than the live ones the
     reviews used to demonstrate it. They are unregistrable by definition, so
     the fixtures cannot name anybody's real mailbox — which is the same rule
     13 this gate enforces, applied to the gate's own test. */
  for (const line of [
    'See jane@northwind.invalid: the notes', // hd-secrets-ok
    'Contact jane@northwind.invalid for help', // hd-secrets-ok
    'user@northwind.invalid/path', // hd-secrets-ok
    'real@northwind.invalid:443', // hd-secrets-ok
    'real@northwind.invalid:8080/tickets', // hd-secrets-ok
    'hacker@northwind.invalid:)', // hd-secrets-ok
    'alice@2x.northwind.invalid', // hd-secrets-ok
    'alice@2x.png.northwind.invalid', // hd-secrets-ok
  ]) {
    const refused = offendersIn('a.ts', line)
    assert.equal(refused.length, 1, line)
    assert.match(refused[0], /rule 13/, line)
  }
  /* Round 2 of #278: the same failure wearing a scheme. The arm asked only
     that *some* `://` sit behind the address with nothing but non-space,
     non-quote characters in between, so a run containing `/`, `?`, `#`, `|`,
     `)` or `+` carried a mailbox further along the same token past the gate.
     Two seats measured the class independently and named these rows; every one
     of them is pinned here.

     The last three are the rows that separate the two repairs the reviews
     proposed. A fragment or a query on a URL with no path has no `/` to stop a
     rule that excludes only `/`; a pipe table cell and a Markdown link have no
     `?` or `#` to stop a rule that excludes only those. Excluding punctuation
     misses whichever shape the list forgot, which is why the arm names the
     characters a URL authority may carry instead of guessing at the ones it
     may not. */
  for (const line of [
    'https://example.com/path?email=real@northwind.invalid', // hd-secrets-ok
    'https://example.com/u/real@northwind.invalid', // hd-secrets-ok
    'https://example.com/path#real@northwind.invalid', // hd-secrets-ok
    'file:///tmp/real@northwind.invalid', // hd-secrets-ok
    'https://example.com/path+real@northwind.invalid', // hd-secrets-ok
    'https://example.com?email=real@northwind.invalid', // hd-secrets-ok
    'https://example.com#real@northwind.invalid', // hd-secrets-ok
    '|https://example.com|real@northwind.invalid|', // hd-secrets-ok
    '[text](https://example.com)real@northwind.invalid', // hd-secrets-ok
  ]) {
    const refused = offendersIn('a.ts', line)
    assert.equal(refused.length, 1, line)
    assert.match(refused[0], /rule 13/, line)
  }
  /* An address with a path after the colon is spelled exactly like a remote,
     so the shape cannot refuse one without refusing the other and the host
     decides instead. Round 2 named both of these as residuals on the argument
     that prose puts a space after a colon — which a fixture, a YAML value or a
     table cell need not do. A forge outside the roster is refused with them:
     that is the control proving the roster is what excuses the line above
     rather than the path shape it shares. */
  for (const line of [
    'jane@northwind.invalid:notes/x', // hd-secrets-ok
    'user@northwind.invalid:/abs/path', // hd-secrets-ok
    'deploy@northwind.invalid:openma/harnessdesk.git', // hd-secrets-ok
  ]) {
    const refused = offendersIn('a.ts', line)
    assert.equal(refused.length, 1, line)
    assert.match(refused[0], /rule 13/, line)
  }
  /* A service local part stays exempt on any domain, and that is a decision
     rather than an oversight: the account an address discloses is its local
     part, and an unattended role address is nobody's. Round 1 asked for it to
     be said out loud, so it is pinned here — changing it is a deliberate diff
     against a test, not a quiet edit to a regex. */
  assert.deepEqual(offendersIn('a.ts', 'noreply@northwind.invalid'), [])
  // A person in front of a real domain is the half of rule 13 a gate can catch.
  const found = offendersIn('a.ts', "const owner = 'j.roe@northwind-trading.co'") // hd-secrets-ok
  assert.equal(found.length, 1)
  assert.match(found[0], /rule 13/)
  // And the escape hatch still answers for a deliberate lookalike.
  assert.deepEqual(offendersIn('a.ts', "const owner = 'j.roe@northwind-trading.co' // hd-secrets-ok"), [])
})

test('a home directory that is not a declared placeholder fails the secrets scan (#204)', () => {
  /* The controls: every home-path convention the tree already holds. The last
     three are why the rule cannot be a bare shape match — an elided or
     bracketed segment is the opposite of a leak, and a URL path that reads
     /home is not a home directory at all. */
  for (const line of [
    "const p = '/Users/x/.local/bin/claude'",
    "projectsDirectory: '/home/dev/.claude/projects'",
    "env: { PATH: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin' }",
    "'/home/linuxbrew/.linuxbrew/bin'",
    "assert.equal(calls[0]?.[2], '/home/.codex/thread-writer-locks/thread-1.lock')",
    "detectSkillActivations('Use [$review](/Users/u/.codex/skills/review/SKILL.md)')",
    " * `/Users/<name>/…` in full.",
    " * any *other* `/Users/…` path is still audited",
    " * a URL is not a home directory: `https://acme.dev/home/settings`",
    /* The Windows shape, in both spellings the tree writes it: escaped inside
       a source string, bare in prose. Every one of these is a line really in
       the tree, and all four segments are excused by the same roster and the
       same shape rules the POSIX arm uses. */
    "    'C:\\\\Users\\\\someone\\\\project',",
    "  const paths = candidatePaths({ commands: ['gemini'] }, { home: 'C:\\\\Users\\\\x', platform: 'win32' })",
    " * `C:\\Users\\foo` returned as `C:\\\\Users\\\\foo`, and a label with a line",
    "               `C:\\\\Users\\\\…\\\\skill.md` as the file's name. `basename`",
  ]) {
    assert.deepEqual(offendersIn('a.ts', line), [], line)
  }
  // Somebody's actual home directory is the leak this catches, under any root.
  const mac = offendersIn('a.ts', "const root = '/Users/jroe/code/HarnessDesk'") // hd-secrets-ok
  assert.equal(mac.length, 1)
  assert.match(mac[0], /rule 13/)
  assert.match(offendersIn('a.ts', "const root = '/home/jroe/code'")[0], /rule 13/) // hd-secrets-ok
  /* Windows was invisible to this rule until #296: the screenshot audit that
     reuses it was asked to stop being macOS-only, and the roster it reuses can
     only answer for the shapes it reads. Both spellings, because a path in a
     source string is escaped and one in prose is not. */
  const windows = offendersIn('a.ts', "const root = 'C:\\\\Users\\\\jroe\\\\code'") // hd-secrets-ok
  assert.equal(windows.length, 1)
  assert.match(windows[0], /rule 13/)
  assert.match(offendersIn('a.ts', 'see C:\\Users\\jroe for it')[0], /rule 13/) // hd-secrets-ok
  // And a drive letter that is not C, since the shape is the rule, not the drive.
  assert.match(offendersIn('a.ts', "const root = 'D:\\\\Users\\\\jroe'")[0], /rule 13/) // hd-secrets-ok
})

test('a section whose heading is the first line of the file is found (#269)', () => {
  const tail = ['', 'it runs the build', '', '## Next', '', 'unrelated'].join('\n')
  /* `\n${heading}` cannot match at index 0, so a document whose target heading
     is its first line read as having no such section — and an empty section
     fails every pattern, which reads as both documents falling silent at once
     rather than as the check being unable to see them. */
  const first = sectionOf(`## The gate${tail}`, '## The gate')
  assert.match(first, /it runs the build/)
  assert.doesNotMatch(first, /unrelated/, 'the next heading still ends it')
  // The control: the same section under a title, which is how both documents write it today.
  const lower = sectionOf(`# Title\n\n## The gate${tail}`, '## The gate')
  assert.match(lower, /it runs the build/)
  assert.doesNotMatch(lower, /unrelated/)
  // And a heading that is not there is still an empty section, not the whole file.
  assert.equal(sectionOf(`## The gate${tail}`, '## Renamed'), '')
})

test('a ## inside a fenced code block does not end the section (#269)', () => {
  const doc = [
    '# Title',
    '',
    '## The gate',
    '',
    '```markdown',
    '## not a heading, a sample',
    '```',
    '',
    'it runs the build',
    '',
    '## Next',
    '',
    'unrelated',
  ].join('\n')
  const body = sectionOf(doc, '## The gate')
  /* The section was cut at the sample, so every step named below it reported
     as unnamed — a document that says everything failing as though it said
     nothing. Both sections here already open with a fenced block. */
  assert.match(body, /it runs the build/)
  // The control: a real heading at the same level still ends the section.
  assert.doesNotMatch(body, /unrelated/)
})

test('the three step patterns match the enumeration, not the word (#269)', () => {
  // Each was satisfied by any mention of its word anywhere in the section.
  assert.equal(DESCRIBED_AS.get('lockfile installs').test('lockfileVersion'), false)
  assert.equal(DESCRIBED_AS.get('build').test('a brand name in rendered text fails the build.'), false)
  assert.equal(DESCRIBED_AS.get('node tests').test('the test suite is slow today'), false)
  /* The controls: each still matches the sentence it stands for, in both
     documents' wording. The middle one is the one that was really load-bearing
     — CONTRIBUTING.md says "fails the build" three paragraphs under its list,
     so before this the list itself could have dropped the build and stayed green. */
  assert.ok(DESCRIBED_AS.get('lockfile installs').test('validates the lockfile with pnpm install --frozen-lockfile'))
  assert.ok(DESCRIBED_AS.get('lockfile installs').test('the lockfile install, the build'))
  assert.ok(DESCRIBED_AS.get('build').test('runs the build, every test suite'))
  assert.ok(DESCRIBED_AS.get('build').test('the lockfile install, the build, every test suite'))
  assert.ok(DESCRIBED_AS.get('node tests').test('every test suite (Node packages, gate scripts, UI and desktop)'))
})

test('distSegments refuses a wildcard where it reads a fixed segment (#269)', () => {
  // The control: today's glob is the shape it expects, and gives the three segments the walk needs.
  assert.deepEqual(distSegments(TEST_GLOB), { top: 'packages', dist: 'dist', tests: 'test' })
  /* Six segments with `*` second and `**` fifth was the whole guard, so both
     of these passed it and the positional read handed the walk a wildcard as
     the top directory — the error message promising more than it delivered. */
  assert.throws(() => distSegments('*/*/*/test/**/*.test.js'), /not that shape/)
  assert.throws(() => distSegments('packages/*/*/test/**/*.test.js'), /not that shape/)
})

test('tracked text files contain no raw NUL bytes (#360)', () => {
  const extensions = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|yml|yaml|sh|py|toml)$/
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\n')
    .filter((file) => extensions.test(file))
  const withNul = []
  for (const file of files) {
    const resolved = path.resolve(repoRoot, file)
    // The index still names a deletion until it is staged. That file is not
    // part of the working tree being verified; conversely, new untracked
    // source is, and is included by the command above.
    if (!fs.existsSync(resolved)) continue
    const buf = fs.readFileSync(resolved)
    if (buf.includes(0)) withNul.push(file)
  }
  assert.deepEqual(withNul, [])
})

test('a bare credential file does not leak credential characters in the offender report (#394)', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' // hd-secrets-ok
  const offenders = offendersIn('secret.txt', token)
  assert.equal(offenders.length, 1)
  assert.equal(offenders[0], 'secret.txt:1  [file is nothing but a credential]')
  assert.doesNotMatch(offenders[0], /abcdefghijkl/)
})

test('a detected secret on a source line does not leak line content or secret values in the offender report (#395)', () => {
  const line = "const secretKey = 'sk-abcdefghijklmnopqrstuvwxyz1234567890'" // hd-secrets-ok
  const offenders = offendersIn('config.ts', line)
  assert.equal(offenders.length, 1)
  assert.equal(offenders[0], 'config.ts:1  [OpenAI API key]')
  assert.doesNotMatch(offenders[0], /secretKey/)
  assert.doesNotMatch(offenders[0], /sk-abcdef/)
})

test('installedLicence finds installed package licenses without find binary (#397)', () => {
  // Test with real installed package
  const cordisLicence = installedLicence('@deepseek-ai/cordis', repoRoot)
  assert.equal(cordisLicence, 'MIT')

  const acpLicence = installedLicence('@agentclientprotocol/claude-agent-acp', repoRoot)
  assert.equal(acpLicence, 'Apache-2.0')

  // Returns null for non-installed package
  assert.equal(installedLicence('nonexistent-package-xyz', repoRoot), null)
})

test('checkNotices refuses when zero licence claims can be verified (#397)', () => {
  const sampleNotices = [
    '# Third-Party Notices',
    '',
    '## Packages used as dependencies',
    '',
    '| Package | Licence | Used for |',
    '| --- | --- | --- |',
    '| `nonexistent-pkg-a` | MIT | Testing |',
    '| `nonexistent-pkg-b` | Apache-2.0 | Testing |',
  ].join('\n')

  const result = checkNotices(sampleNotices, repoRoot)
  assert.equal(result.checked, 0)
  assert.equal(result.skipped, 2)
  assert.ok(result.problems.some((p) => p.includes('No licence claims could be verified')))
})

test('DOCUMENTATION regex exempts design explorer and showcase on both POSIX and Windows paths (#486)', () => {
  const posixExplorer = 'packages/ui/src/design/explorer/boards.tsx'
  const posixShowcase = 'packages/ui/src/design/showcase/preview.tsx'
  const winExplorer = 'packages\\ui\\src\\design\\explorer\\boards.tsx'
  const winShowcase = 'packages\\ui\\src\\design\\showcase\\preview.tsx'

  assert.equal(DOCUMENTATION.test(posixExplorer), true)
  assert.equal(DOCUMENTATION.test(posixShowcase), true)
  assert.equal(DOCUMENTATION.test(winExplorer), true)
  assert.equal(DOCUMENTATION.test(winShowcase), true)

  const nonExempt = 'packages\\ui\\src\\components\\BringHome.tsx'
  assert.equal(DOCUMENTATION.test(nonExempt), false)
})

test('packages/server/tsconfig.json includes project references for internal dependencies and excludes unused transport-acp (#485)', () => {
  const serverPkg = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'packages/server/package.json'), 'utf8'))
  const serverTsconfig = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'packages/server/tsconfig.json'), 'utf8'))
  const refs = new Set(serverTsconfig.references.map((r) => r.path))

  const internalDeps = Object.keys({ ...serverPkg.dependencies, ...serverPkg.devDependencies })
    .filter((name) => name.startsWith('@harnessdesk/'))
    .map((name) => `../${name.replace('@harnessdesk/', '')}`)

  for (const dep of internalDeps) {
    assert.ok(refs.has(dep), `packages/server/tsconfig.json is missing reference for dependency ${dep}`)
  }
  assert.ok(!refs.has('../transport-acp'), 'packages/server/tsconfig.json must not reference ../transport-acp')
})

/*
 * The colour and stacking rules read declarations, not property names (#762
 * review). Each case below is a spelling a property list would miss, or one it
 * would wrongly count — the rule has to be seen getting both right.
 */
test('a colour written into any property is counted, not only the ones someone listed (#762)', () => {
  const found = (css) => rawColours(css).map(({ property }) => property)
  assert.deepEqual(found('.a { border: 1px solid #fff; }'), ['border'])
  assert.deepEqual(found('.a { border-top: 1px solid rgb(0 0 0); }'), ['border-top'])
  assert.deepEqual(found('.a { outline: 2px solid hsl(210 50% 50%); }'), ['outline'])
  assert.deepEqual(found('.a { --tint: #abc; }'), ['--tint'])
  // the last declaration in a block needs no semicolon
  assert.deepEqual(found('.a { color: #fff }'), ['color'])
  // a vendor prefix is a property like any other
  assert.deepEqual(found('.a { -webkit-text-stroke: 1px #000; }'), ['-webkit-text-stroke'])
})

test('tokens, fragment references, strings and masks are not raw colours (#762)', () => {
  assert.deepEqual(rawColours('.a { color: var(--hd-foreground); border: 1px solid var(--hd-border); }'), [])
  assert.deepEqual(rawColours('.a { fill: url(#grad); }'), [])
  assert.deepEqual(rawColours(".a::before { content: '#fff'; }"), [])
  // a mask reads alpha: `#000` there means "show", not black
  assert.deepEqual(rawColours('.a { mask-image: linear-gradient(to right, #000 80%, transparent); }'), [])
  assert.deepEqual(rawColours('.a { -webkit-mask: radial-gradient(#000, transparent); }'), [])
})

test('a selector is never read as a declaration (#762)', () => {
  assert.deepEqual(
    declarationsOf('a:hover { color: red } .b:not(:focus) { gap: 4px; } @media (max-width: 720px) { .c { top: 0 } }')
      .map(({ property }) => property),
    ['color', 'gap', 'top'],
  )
})

test('a stacking number is counted with !important and without a semicolon (#762)', () => {
  const found = (css) => rawZIndexes(css).map(({ value }) => value)
  assert.deepEqual(found('.a { z-index: 10 !important; }'), ['10'])
  assert.deepEqual(found('.a { z-index: 40 }'), ['40'])
  assert.deepEqual(found('.a { z-index: -20; }'), ['-20'])
  // single digits order within one component; tokens are the point
  assert.deepEqual(found('.a { z-index: 5; } .b { z-index: var(--hd-z-popover) !important; }'), [])
})

/* The #762 re-review: a `;` inside a string ended the declaration, which read
   a colour out of valid CSS; and `red` was not a colour at all. */
test('a semicolon inside a string or parentheses does not end a declaration (#762)', () => {
  assert.deepEqual(declarationsOf('.a::before { content: "status: #fff; ready"; gap: 4px; }'), [
    { property: 'content', value: '"status: #fff; ready"' },
    { property: 'gap', value: '4px' },
  ])
  assert.deepEqual(rawColours('.a::before { content: "status: #fff; ready"; }'), [])
  assert.deepEqual(
    declarationsOf('.a { background: url(data:image/svg+xml;utf8,x); color: var(--hd-foreground) }').map(({ property }) => property),
    ['background', 'color'],
  )
})

test('a named colour is a raw colour; transparent, currentColor and the CSS-wide keywords are not (#762)', () => {
  assert.equal(NAMED_COLOURS.length, 148)
  const found = (css) => rawColours(css).map(({ property }) => property)
  assert.deepEqual(found('.a { color: red; }'), ['color'])
  assert.deepEqual(found('.a { border: 1px solid Tomato }'), ['border'])
  assert.deepEqual(found('.a { --tint: white; }'), ['--tint'])
  // a literal fallback is a literal
  assert.deepEqual(found('.a { color: var(--hd-accent, rebeccapurple); }'), ['color'])
  for (const keyword of ['transparent', 'currentColor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']) {
    assert.deepEqual(found(`.a { color: ${keyword}; }`), [], keyword)
  }
  // part of a token's name, or a function, is not a colour
  assert.deepEqual(found('.a { color: var(--hd-red); width: calc(tan(45deg) * 1px); }'), [])
})

test('a colour word is a name where authors write names (#762)', () => {
  assert.deepEqual(rawColours('.a { animation: red 1s; grid-area: tan; font-family: Orange, sans-serif; counter-reset: gold; }'), [])
  // but a hex there is still a colour, and a mask is still alpha
  assert.deepEqual(rawColours('.a { animation: pulse 1s #fff; }').map(({ property }) => property), ['animation'])
  assert.deepEqual(rawColours('.a { mask-image: linear-gradient(black, transparent); }'), [])
})

/* The second #762 re-review: two regex passes around the tokenizer did not
   know what a string is — comment stripping, and `url()` blanking. */
test('comment markers inside a string are not a comment (#762)', () => {
  const css = '.a::before { content: "/*"; color: red; content: "*/"; }'
  assert.deepEqual(declarationsOf(css).map(({ property }) => property), ['content', 'color', 'content'])
  assert.deepEqual(rawColours(css).map(({ property }) => property), ['color'])
  // a real comment still goes, apostrophe and all, without opening a string
  assert.deepEqual(rawColours(".a { /* it's a note, don't count it: #fff */ color: red }").map(({ property }) => property), ['color'])
  // an unquoted url() is an address: a `/*` there is a path, not a comment
  assert.deepEqual(
    declarationsOf('.a { background: url(img/*.png); color: red }').map(({ property }) => property),
    ['background', 'color'],
  )
})

test('a quoted url() ends at its own paren, not one inside its string (#762)', () => {
  assert.deepEqual(rawColours(`.a { background: url("data:image/svg+xml,<svg transform='translate(1)' fill='red'/>"); }`), [])
  assert.deepEqual(rawColours(".a { background: url('x(1).png') red; }").map(({ property }) => property), ['background'])
})

test('a stray quote ends at the line, and does not hide the rest of a stylesheet (#762)', () => {
  assert.deepEqual(rawColours('.a { content: "unterminated\n  ; color: red }').map(({ property }) => property), ['color'])
})

/* The third #762 re-review: escapes, and the newlines CSS counts as one. */
test('an escaped paren inside an unquoted url() is part of the address (#762)', () => {
  assert.deepEqual(rawColours('.a { background: url(a\\)red.png); }'), [])
  assert.deepEqual(rawColours('.a { background: url(x\\)#fff.png); }'), [])
  // and a colour after the whole address is still one
  assert.deepEqual(rawColours('.a { background: url(a\\)b.png) red; }').map(({ property }) => property), ['background'])
})

test('CR, form feed and CR LF are the newline CSS preprocessing makes them (#762)', () => {
  // an unescaped CR or form feed ends a string, as a newline does
  assert.deepEqual(rawColours('.a { content: "a\r; color: red }').map(({ property }) => property), ['color'])
  assert.deepEqual(rawColours('.a { content: "a\f; color: red }').map(({ property }) => property), ['color'])
  // a backslash before CR LF is one line continuation: the string goes on
  assert.deepEqual(rawColours('.a { content: "a\\\r\n#fff"; }'), [])
  assert.deepEqual(declarationsOf('.a {\r\n  color: red;\r\n  gap: 4px;\r\n}').map(({ property }) => property), ['color', 'gap'])
})

/* The fourth #762 re-review: CSS decodes escapes before it reads a name, so
   the audit has to as well — each spelling below checked in Chromium. */
test('an escaped colour, colour function or property is still one (#762)', () => {
  const found = (css) => rawColours(css).map(({ property }) => property)
  assert.deepEqual(found('.a { color: r\\65 d; }'), ['color'])
  assert.deepEqual(found('.a { color: r\\000065d; }'), ['color'])
  assert.deepEqual(found('.a { color: r\\67 b(255 0 0); }'), ['color'])
  assert.deepEqual(found('.a { color: #\\66 ff; }'), ['color'])
  assert.deepEqual(found('.a { c\\6f lor: red; }'), ['color'])
  const layers = (css) => rawZIndexes(css).map(({ value }) => value)
  assert.deepEqual(layers('.a { z-\\69 ndex: 10; }'), ['10'])
  // property names are case-insensitive; a sign and an escaped !important are still an integer and a flag
  assert.deepEqual(layers('.a { Z-INDEX: 10; }'), ['10'])
  assert.deepEqual(layers('.a { z-index: +10; }'), ['+10'])
  assert.deepEqual(layers('.a { z-index: 10 !\\69 mportant; }'), ['10'])
})

test('an escaped url() is a URL, and an escaped name that is not a colour is not one (#762)', () => {
  assert.deepEqual(rawColours('.a { background: u\\72l(red); }'), [])
  assert.deepEqual(rawColours('.a { color: r\\65 dx; }'), [])
  assert.deepEqual(rawColours('.a { color: var(--hd-r\\65 d); }'), [])
  // a custom property keeps its case, as the browser keeps it
  assert.deepEqual(declarationsOf('.a { --Tint: 1; }').map(({ property }) => property), ['--Tint'])
})

/* Swept before the next review round rather than found by it: spellings of
   the same two rules, each checked in Chromium first. */
test('color() is a colour function, and colour words in grid lines, pages and view-transition classes are names (#762)', () => {
  assert.deepEqual(rawColours('.a { color: color(srgb 1 0 0); }').map(({ property }) => property), ['color'])
  assert.deepEqual(
    rawColours('.a { grid-template-columns: [red] 1fr; grid-template-rows: [tan] auto; page: red; view-transition-class: red; }'),
    [],
  )
})

test('a z-index written as a number is counted however it is spelled (#762)', () => {
  const layers = (css) => rawZIndexes(css).map(({ value }) => value)
  assert.deepEqual(layers('.a { z-index: calc(10); }'), ['calc(10)'])
  assert.deepEqual(layers('.a { z-index: calc(5 + 5); }'), ['calc(5 + 5)'])
  assert.deepEqual(layers('.a { z-index: max(1, 12); }'), ['max(1, 12)'])
  assert.deepEqual(layers('.a { z-index: clamp(10, 5, 20); }'), ['clamp(10, 5, 20)'])
  // a number behind a custom property of this stylesheet, or in a fallback, is still a number
  assert.deepEqual(layers('.a { --l: 60; z-index: var(--l); }'), ['var(--l)'])
  assert.deepEqual(layers('.a { z-index: var(--nope, 60); }'), ['var(--nope, 60)'])
})

test('a z-index from the ladder, a single digit or not a number at all is not counted (#762)', () => {
  const layers = (css) => rawZIndexes(css).map(({ value }) => value)
  assert.deepEqual(layers('.a { z-index: var(--hd-z-popover); }'), [])
  // derived from a rung, so it moves when the ladder moves — the line drawn on purpose
  assert.deepEqual(layers('.a { z-index: calc(var(--hd-z-sticky) + 1); }'), [])
  assert.deepEqual(layers('.a { z-index: 5; } .b { z-index: calc(2 * 3); } .c { z-index: auto; }'), [])
  // not a valid z-index: the browser drops it
  assert.deepEqual(layers('.a { z-index: 10.5; }'), [])
  // a cycle resolves to nothing rather than looping
  assert.deepEqual(layers('.a { --a: var(--b); --b: var(--a); z-index: var(--a); }'), [])
})

/* The fifth #762 re-review, and the neighbours of each finding — every value
   below computed in Chromium first. */
const counted = (css) => rawZIndexes(css).length > 0

test('a z-index written through any CSS math function is counted, escaped or not (#762)', () => {
  for (const math of ['c\\61lc(5 + 5)', 'abs(-12)', 'round(up, 10.1, 1)', 'round(10.4)', 'calc(pi * 4)', 'calc(infinity)',
    'mod(25, 15)', 'rem(-25, 15)', 'pow(2, 4)', 'sqrt(100)', 'hypot(6, 8)', 'calc(e * 4)', 'calc(1e1)', 'calc(sin(0) + 12)'])
    assert.equal(counted(`.a { z-index: ${math}; }`), true, math)
  // what this cannot compute, and involves no rung, is reported rather than assumed small
  assert.equal(counted('.a { z-index: calc(asin(1) / 1deg); }'), true)
})

test('a z-index that is small, from the ladder, or not valid CSS is not counted (#762)', () => {
  for (const value of ['calc(2 * 3)', 'abs(-5)', 'var(--hd-z-popover)', 'calc(var(--hd-z-sticky) + 1)', 'auto',
    // arithmetic outside a math function is not CSS: Chromium computes these to auto
    'sign(-5) * -12', '5 + 5', '10.5'])
    assert.equal(counted(`.a { z-index: ${value}; }`), false, value)
})

test('var() falls back where the browser does, and each rule\'s custom property is its own candidate (#762)', () => {
  assert.equal(counted('.a { --l: var(--l); z-index: var(--l, 60); }'), true)
  assert.equal(counted('.a { --l: initial; z-index: var(--l, 60); }'), true)
  // a later rule's definition does not replace this rule's
  assert.equal(counted('.a { --l: 60; z-index: var(--l); } .b { --l: var(--hd-z-popover); }'), true)
  assert.equal(counted('.a { z-index: calc(var(--x, 5) + 5); }'), true)
  // a cycle with no fallback is invalid, and `inherit` defers to another element
  assert.equal(counted('.a { --a: var(--b); --b: var(--a); z-index: var(--a); }'), false)
  assert.equal(counted('.a { --l: inherit; z-index: var(--l); }'), false)
})

test('an author name is not a colour, in a property or inside a function (#762)', () => {
  assert.deepEqual(rawColours('.a { transition-property: red; will-change: tan; }'), [])
  assert.deepEqual(rawColours('.a { transition: red 1s; }'), [])
  for (const content of ['counter(red)', 'counters(red, ".")', 'counter(x, red)', 'attr(red)'])
    assert.deepEqual(rawColours(`.a { content: ${content}; }`), [], content)
  assert.deepEqual(rawColours('.a { font-variant-alternates: styleset(red); }'), [])
  // attr()'s fallback is a value, though, and a colour there is still one
  assert.deepEqual(rawColours('.a { color: attr(data-x, red); }').map(({ property }) => property), ['color'])
})

test('a rung may be named, chosen between, or nudged by one digit; anything else done to it is counted (#762)', () => {
  for (const value of ['var(--hd-z-popover)', 'calc(var(--hd-z-sticky) + 1)', 'calc(var(--hd-z-sticky) - 1)',
    'calc(1 + var(--hd-z-sticky))', 'max(var(--hd-z-popover), var(--hd-z-drawer))'])
    assert.equal(counted(`.a { z-index: ${value}; }`), false, value)
  for (const value of ['calc(var(--hd-z-sticky) + 60)', 'calc(var(--hd-z-popover) * 2)', 'max(var(--hd-z-popover), 60)'])
    assert.equal(counted(`.a { z-index: ${value}; }`), true, value)
  assert.equal(counted('.a { --l: 60; z-index: calc(var(--hd-z-sticky) + var(--l)); }'), true)
})

/* The sixth #762 re-review, and the neighbours of each finding — every case
   below computed in Chromium first, with the ladder in a sheet of its own. */
test('only a rung, a choice between rungs, or a rung nudged by a whole digit takes a name (#762)', () => {
  for (const value of ['calc(var(--hd-z-popover) * var(--hd-z-drawer))', 'abs(var(--hd-z-popover))',
    'calc(var(--hd-z-popover) + infinity)', 'calc(var(--hd-z-popover) + 9.9)', 'round(var(--hd-z-popover))',
    'calc(var(--hd-z-drawer) / var(--hd-z-popover))', 'calc(9 - var(--hd-z-popover))', 'calc(var(--hd-z-popover) + 1e1)',
    // a nudge is the last thing done, not something to choose between
    'max(var(--hd-z-popover), calc(var(--hd-z-drawer) + 1))'])
    assert.equal(counted(`.a { z-index: ${value}; }`), true, value)
  for (const value of ['calc(var(--hd-z-popover) + 9)', 'calc(var(--hd-z-popover) + 1.0)', 'calc(9 + var(--hd-z-popover))',
    'min(var(--hd-z-popover))', 'clamp(var(--hd-z-sticky), var(--hd-z-popover), var(--hd-z-drawer))',
    'calc(max(var(--hd-z-popover), var(--hd-z-drawer)) + 1)', 'C\\41LC(var(--hd-z-popover) + 1)'])
    assert.equal(counted(`.a { z-index: ${value}; }`), false, value)
})

test('a var() of nothing is invalid wherever it is, and a keyword is read decoded (#762)', () => {
  assert.equal(counted('.a { --l: var(--missing); z-index: var(--l, 60); }'), true)
  assert.equal(counted('.a { --l: in\\69 tial; z-index: var(--l, 60); }'), true)
  // invalid at computed-value time is the guaranteed-invalid value, not the parent's
  assert.equal(counted('.p { --l: 5; } .a { --l: var(--missing); z-index: var(--l, 60); }'), true)
  // a fallback that is used and reads the property back is a cycle; one that is not used is nothing
  assert.equal(counted('.a { --a: var(--missing, var(--a)); z-index: var(--a, 60); }'), true)
  assert.equal(counted('.a { --b: 5; --a: var(--b, var(--a)); z-index: var(--a, 60); }'), false)
})

test('a custom property another rule sets may not reach the element; one the whole document has does (#762)', () => {
  assert.equal(counted('.a { z-index: var(--l, 60); } .b { --l: 5; }'), true)
  for (const css of ['.a { --l: 5; } .a { z-index: var(--l, 60); }', ':root { --l: 5; } .a { z-index: var(--l, 60); }',
    'html { --l: 5; } .a { z-index: var(--l, 60); }', '* { --l: 5; } .a { z-index: var(--l, 60); }',
    ':r\\6f ot { --l: 5; } .a { z-index: var(--l, 60); }', '@layer x { :root { --l: 5; } } .a { z-index: var(--l, 60); }',
    '.a { --l: 5; @media all { z-index: var(--l, 60); } }'])
    assert.equal(counted(css), false, css)
  // under a condition, or computed on the root where the other property is not set
  assert.equal(counted('@media print { :root { --l: 5; } } .a { z-index: var(--l, 60); }'), true)
  assert.equal(counted(':root { --l: inherit; } .a { z-index: var(--l, 60); }'), true)
  assert.equal(counted(':root { --l: var(--m, 70); } .a { --m: 5; z-index: var(--l); }'), true)
})

test('an empty custom property is set, so its var() does not fall back (#762)', () => {
  assert.deepEqual(declarationsOf('.a { --l: ; gap: ; }'), [{ property: '--l', value: '' }])
  for (const css of ['.a { --l: ; z-index: var(--l, 60); }', '.a { --l: !important; z-index: var(--l, 60); }',
    '.a { --l: ; } .a { z-index: var(--l, 60); }', '.a { --m: ; --l: var(--m); z-index: var(--l, 60); }'])
    assert.equal(counted(css), false, css)
})

test('a registered custom property is its initial value where nothing sets it, and when what sets it does not fit (#762)', () => {
  const at = (body, rest) => `@property --l { ${body} } ${rest}`
  const integer = "syntax: '<integer>'; inherits: false; initial-value: 60"
  for (const css of [at(integer, '.a { z-index: var(--l); }'), at(integer, '.a { z-index: var(--l, 5); }'),
    at(integer, '.a { --l: initial; z-index: var(--l, 5); }'), at(integer, '.a { --l: foo; z-index: var(--l, 5); }'),
    // it does not inherit, so the root's value never reaches
    at(integer, ':root { --l: 5; } .a { z-index: var(--l); }'),
    at("syntax: '*'; inherits: false", '.a { z-index: var(--l, 60); }'),
    "@PROPERTY --\\6c { syntax: '<integer>'; inherits: false; initial-value: 60 } .a { z-index: var(--l, 5); }",
    // a descriptor that does not parse, or is marked !important, is dropped on its own — not the rule
    at("syntax: '<integer>'; syntax: '<Integer>'; inherits: false; initial-value: 60", '.a { z-index: var(--l, 5); }'),
    at(`${integer}; foo: 1 !important`, '.a { z-index: var(--l, 5); }'),
    // every property on a cycle is invalid, whatever a registration makes of what it read
    "@property --b { syntax: '<integer>'; inherits: false; initial-value: 3 } .a { --a: var(--b); --b: var(--a); z-index: var(--a, 60); }"])
    assert.equal(counted(css), true, css)
  // a rule that registers nothing, a later rule that wins, a value that fits
  for (const css of [at('initial-value: 60', '.a { z-index: var(--l, 5); }'),
    at("syntax: '<Integer>'; inherits: false; initial-value: 60", '.a { z-index: var(--l, 5); }'),
    at("syntax: '<integer>'; inherits: false; initial-value: 60px", '.a { z-index: var(--l, 5); }'),
    at("syntax: '<integer>'; inherits: false; initial-value: 60 !important", '.a { z-index: var(--l, 5); }'),
    at("syntax: '<integer>'; inherits: false; initial-value: var(--x)", '.a { z-index: var(--l, 5); }'),
    ".x { @property --l { syntax: '<integer>'; inherits: false; initial-value: 60 } } .a { z-index: var(--l, 5); }",
    at(integer, "@property --l { syntax: '<integer>'; inherits: false; initial-value: 3 } .a { z-index: var(--l, 5); }"),
    at(integer, '.a { --l: 5; z-index: var(--l); }'),
    at("syntax: 'auto'; inherits: false; initial-value: auto", '.a { z-index: var(--l, 60); }'),
    at("syntax: '<integer>'; inherits: true; initial-value: 60", ':root { --l: 5; } .a { z-index: var(--l); }')])
    assert.equal(counted(css), false, css)
})

/* Swept before the next review round rather than found by it: what a second
   reader found in the answer to the sixth, each case computed in Chromium. */
test('a declaration the browser drops sets nothing, and a comment still separates tokens (#762)', () => {
  // dropped: an unmatched closer, a `!` at the top of a custom property, a bad string or URL
  for (const value of ['5)', '5]', '(5])', '5 !foo', '!', '5 !important !important', '"x\n', 'url(a b)'])
    assert.equal(counted(`.a { --l: ${value}; z-index: var(--l, 60); }`), true, value)
  // kept: a `!` inside brackets, a lone block
  assert.equal(counted('.a { --l: (5 !); z-index: var(--l, 60); }'), false)
  assert.equal(counted('.a { --l: {5}; z-index: var(--l, 60); }'), false)
  // a `;` inside brackets is part of the value
  assert.deepEqual(declarationsOf('.a { --x: (a;b); gap: 1px }'), [{ property: '--x', value: '(a;b)' }, { property: 'gap', value: '1px' }])
  // `.b {}; .a {…}`: the `;` joins the next prelude, and the browser drops that rule
  assert.equal(counted('.b {}; .a { --l: 5 } .a { z-index: var(--l, 60); }'), true)
  // inside a bracket, or an unquoted URL, nothing is structure
  assert.equal(counted('.b { --x: [}]; --l: 5 } .a { --x: [}]; z-index: var(--l, 60); }'), true)
  assert.equal(counted('.a { background: url(a(b); z-index: 60 }'), true)
  // a comment is a token boundary
  assert.equal(counted("@property/**/--l { syntax: '<integer>'; inherits: false; initial-value: 60 } .a { z-index: var(--l, 5); }"), true)
  assert.equal(counted("@property --l { syn/**/tax: '<integer>'; inherits: false; initial-value: 5 } .a { z-index: var(--l, 60); }"), true)
  // a block names one layer or none; a default namespace narrows `:root` and `*`
  assert.equal(counted('@layer a, b { :root { --l: 5 } } .a { z-index: var(--l, 60); }'), true)
  assert.equal(counted('@namespace url(http://www.w3.org/2000/svg); :root { --l: 5 } .a { z-index: var(--l, 60); }'), true)
  // a `var()` that names no custom property drops its declaration
  assert.equal(counted('.a { z-index: var(foo, 60); }'), false)
  assert.equal(counted('.p { --l: 60; } .a { --l: var(foo); z-index: var(--l, 5); }'), true)
})

test('math is read with CSS tokens, and what cannot be computed is counted (#762)', () => {
  // `+` and `-` need whitespace; a sign belongs to its number; no unary minus
  for (const value of ['calc(5 +5)', 'calc(5+ 5)', 'calc(- 50)', 'calc(-(50))', 'calc(5 --5)', '1e1', '10.0'])
    assert.equal(counted(`.a { z-index: ${value}; }`), false, value)
  for (const value of ['calc(5 - -5)', 'calc(-5 * -2)', 'calc(6 * +2)', 'clamp(none, 60, 100)'])
    assert.equal(counted(`.a { z-index: ${value}; }`), true, value)
  // the end of the sheet closes what is open
  assert.equal(counted('.a { z-index: var(--l, 60'), true)
  assert.equal(counted('.a { z-index: calc(60'), true)
  // `if()`, typed `attr()` and anything else it does not compute
  for (const value of ['if(style(--x: 1): 5; else: 60)', 'attr(data-z type(<integer>), 60)', 'calc(10 * sibling-count())'])
    assert.equal(counted(`.a { z-index: ${value}; }`), true, value)
  // past a hundred levels Chromium refuses the expression
  assert.equal(counted(`.a { z-index: calc(${'('.repeat(100)}60${')'.repeat(100)}); }`), false)
  // and a rung's expression that is not CSS is `auto`, not a plane
  assert.equal(counted('.a { z-index: calc(var(--hd-z-popover) -1); }'), false)
})

test('a keyword substituted into a custom property acts as one (#762)', () => {
  for (const keyword of ['initial', 'unset', 'revert-layer', 'in\\69 tial', 'INITIAL'])
    assert.equal(counted(`.a { --l: var(--missing, ${keyword}); z-index: var(--l, 60); }`), true, keyword)
  // not alone, it is a value
  assert.equal(counted('.a { --l: var(--missing, initial) 5; z-index: var(--l, 60); }'), false)
})

test('a cycle is invalid in whichever order the browser meets it (#762)', () => {
  // a second cycle behind the first, or behind an invalid var(), still reaches its fallback
  assert.equal(counted('.a { --b: var(--b) var(--c); --c: var(--b, 9); z-index: var(--c, 60); }'), true)
  assert.equal(counted('.a { --m: initial; --b: var(--m) var(--c); --c: var(--b, 9); z-index: var(--c, 60); }'), true)
  // `color: var(--c)` beside it makes `--b` read `--a` resolved, and fall back to 60
  assert.equal(counted('.a { --c: var(--a) var(--b); --a: var(--c); --b: var(--a, 60); z-index: var(--b, 5); }'), true)
  // but a property that reads the other directly can never find it resolved first
  assert.equal(counted('.a { --a: var(--b, 70); --b: var(--a); z-index: var(--b, 5); }'), false)
  assert.equal(counted('.a { --l: var(--l, 70); z-index: var(--l, 5); }'), false)
})

test('a registered value computes the way Chromium computes it (#762)', () => {
  const at = (body, rest) => `@property --l { ${body} } ${rest}`
  const number = "syntax: '<number>'; inherits: false"
  const integer = "syntax: '<integer>'; inherits: false; initial-value: 60"
  for (const css of [at(`${number}; initial-value: 60.0`, '.a { z-index: var(--l, 5); }'),
    at(`${number}; initial-value: 6e1`, '.a { z-index: var(--l, 5); }'),
    at(`${number}; initial-value: 1`, '.a { --l: 30.0; z-index: calc(var(--l) * 2); }'),
    // math that is not CSS does not fit, so the property is its initial value
    at(integer, '.a { --l: calc(2 +3); z-index: var(--l); }'),
    at("syntax: '<integer>'; inherits: false; initial-value: calc(2 +3)", '.a { z-index: var(--l, 60); }'),
    at("syntax: '<length>'; inherits: false; initial-value: 5", '.a { z-index: var(--l, 60); }'),
    // a dropped descriptor leaves the one before it
    at("syntax: '*'; inherits: false; initial-value: 60; initial-value: 5)", '.a { z-index: var(--l, 5); }'),
    // a rule under a condition that never holds registers nothing
    `@media not all { ${at("syntax: '<integer>'; inherits: false; initial-value: 5", '')} } .a { z-index: var(--l, 60); }`,
    // an invalid value of an inheriting registration is its parent's — which another stylesheet may set to a rung
    at("syntax: '<integer>'; inherits: true; initial-value: 1", '.a { --l: foo; z-index: calc(var(--l) * 2); }'),
    // animated, it passes through every value between its keyframes
    at("syntax: '<integer>'; inherits: false; initial-value: 3", '@keyframes k { from { --l: -3 } to { --l: 3 } } .a { --l: 3; animation: k 10s; z-index: calc(10 / var(--l)); }')])
    assert.equal(counted(css), true, css)
  for (const css of [at(`${number}; initial-value: 60.5`, '.a { z-index: var(--l, 5); }'),
    at("syntax: '<int\\65ger>'; inherits: false; initial-value: 60", '.a { --l: 5; z-index: var(--l); }'),
    at("syntax: '<integer>'; inherits: maybe; initial-value: 60", '.a { z-index: var(--l, 5); }')])
    assert.equal(counted(css), false, css)
})

test('a broader selector, a pseudo-element and a nested rule reach what they cover (#762)', () => {
  for (const css of ['.a { --l: 5 } .a:hover { z-index: var(--l, 60); }', '.a { --l: 5 } div.a { z-index: var(--l, 60); }',
    '.a { --l: 5 } .x > .a { z-index: var(--l, 60); }', '.a { --l: 5 } .a::before { z-index: var(--l, 60); }',
    '.a { --l: 5; &:hover { z-index: var(--l, 60); } }', '.a { --l: 5; & .b { z-index: var(--l, 60); } }',
    '.a { --l: 5; .b { z-index: var(--l, 60); } }', '.a { --l: 5; .x & { z-index: var(--l, 60); } }',
    '.a { --l: "var(--missing)"; z-index: var(--l, 60); }'])
    assert.equal(counted(css), false, css)
  // a narrower rule, a sibling, a list it does not cover, a selector the browser drops
  for (const css of ['.a.b { --l: 5 } .a { z-index: var(--l, 60); }', '.a { --l: 5; & + .b { z-index: var(--l, 60); } }',
    '.a { --l: 5 } .a, .b { z-index: var(--l, 60); }', ':root, .x:unknown { --l: 5 } .a { z-index: var(--l, 60); }',
    // a registration that does not inherit reaches no pseudo-element
    "@property --l { syntax: '<integer>'; inherits: false; initial-value: 60 } .a { --l: 5 } .a::before { z-index: var(--l); }"])
    assert.equal(counted(css), true, css)
})

test('a chain too deep to follow is counted, never thrown (#762)', () => {
  const chain = (length) => Array.from({ length }, (_, i) => `--p${i}: var(--p${i + 1});`).join(' ') + ` --p${length}: 5;`
  // past the depth it follows — well inside any stack — it counts rather than assume the end is small
  assert.equal(counted(`.a { ${chain(300)} z-index: var(--p0); }`), true)
  assert.equal(counted(`.a { ${chain(100)} z-index: var(--p0); }`), false)
  assert.doesNotThrow(() => rawZIndexes(`.a { ${chain(20000)} z-index: var(--p0); }`))
  assert.doesNotThrow(() => rawZIndexes(`.a { z-index: ${'max('.repeat(20000)}var(--hd-z-x)${')'.repeat(20000)}; }`))
})

/* And from a second read of that answer, each case again computed in Chromium. */
test('inside a style rule or @scope a selector is relative, so a broader one proves nothing (#762)', () => {
  for (const css of ['.p { .a { --x: 5 } &.a { z-index: var(--x, 60); } }', '.p { .a { --x: 5 } + .a { z-index: var(--x, 60); } }',
    '.p { .a { --x: 5 } .b &.a { z-index: var(--x, 60); } }', '@scope (.p) { .a { --x: 5 } :scope.a { z-index: var(--x, 60); } }',
    '.p { @media all { .a { --x: 5 } &.a { z-index: var(--x, 60); } } }'])
    assert.equal(counted(css), true, css)
  // at the top of the sheet, or under conditions only, it still does
  assert.equal(counted('@media all { .a { --x: 5 } .a:hover { z-index: var(--x, 60); } }'), false)
})

test('the top of a sheet reads as the browser reads it (#762)', () => {
  // a `}` that closes nothing joins the next prelude, and drops that rule
  for (const css of ['} .a { --x: 5 } .a { z-index: var(--x, 60); }', '.q { } } :root { --x: 5 } .a { z-index: var(--x, 60); }',
    "} @property --x { syntax: '<integer>'; inherits: false; initial-value: 5 } .a { z-index: var(--x, 60); }"])
    assert.equal(counted(css), true, css)
  // a layer block names `ident('.'ident)*` or nothing
  for (const name of ['1', 'a.', '"a"', 'a..b', 'a.1', '-1', 'a!'])
    assert.equal(counted(`@layer ${name} { :root { --x: 5 } } .a { z-index: var(--x, 60); }`), true, name)
  for (const name of ['a.b.c', '\\31', 'initial', ''])
    assert.equal(counted(`@layer ${name} { :root { --x: 5 } } .a { z-index: var(--x, 60); }`), false, name)
  // `<!--` and `-->` are nothing there, and a token of their own in a value
  assert.equal(counted('<!-- :root { --x: 5 } --> .a { z-index: var(--x, 60); }'), false)
  assert.equal(counted('.a { --x: <!-- 5; z-index: var(--x, 60); }'), false)
})

test('a registered number substitutes as the browser writes it back out (#762)', () => {
  const number = (value, z = 'var(--x)') => `@property --x { syntax: '<number>'; inherits: false; initial-value: 0 } .a { --x: ${value}; z-index: ${z}; }`
  for (const css of [number('59.9999999'), number('-9.9999999'), number('60.0000001', 'calc(var(--x))'), number('1234567', 'calc(var(--x) / 100000)')])
    assert.equal(counted(css), true, css)
  // from a million up it has an exponent, which is no integer
  for (const css of [number('1234567'), number('1000000'), number('12345.67')]) assert.equal(counted(css), false, css)
})

test('a finite value against an infinite step is what CSS Values says (#762)', () => {
  for (const value of ['mod(60, infinity)', 'rem(-60, infinity)', 'mod(-60, -infinity)', 'rem(60, -infinity)',
    'round(up, 60, infinity)', 'round(down, -60, infinity)'])
    assert.equal(counted(`.a { z-index: ${value}; }`), true, value)
  for (const value of ['mod(60, -infinity)', 'mod(-60, infinity)', 'round(to-zero, 60, infinity)', 'round(60, infinity)'])
    assert.equal(counted(`.a { z-index: ${value}; }`), false, value)
})

test('a var() name is read decoded, and only where a token starts (#762)', () => {
  assert.equal(counted('.a { z-index: var(\\-\\-x, 60); }'), true)
  assert.equal(counted('.a { --x: 60; z-index: var(\\2d-x); }'), true)
  // `20var(` is a dimension and a bracket, not a call: substituted, this would be 20
  assert.equal(counted('.a { z-index: calc(20var(--x, * 1)); }'), false)
  assert.equal(counted('.a { z-index: calc(20 var(--x, * 1)); }'), true)
})

test('a URL is bad as the tokenizer says, and NUL is U+FFFD (#762)', () => {
  const nul = String.fromCharCode(0)
  assert.equal(counted('.a { --x: a url(a\\' + '\n' + 'b); z-index: var(--x, 60); }'), true)
  assert.equal(counted(`.a { --x: 60; z-index: var(--x, url(a${nul}b)); }`), true)
  assert.deepEqual(rawColours(`.a { background: url(a${nul}b) red; }`).map(({ property }) => property), ['background'])
})

test('deep nesting of rules does not throw (#762)', () => {
  assert.doesNotThrow(() => rawZIndexes(`${'.a{'.repeat(12000)}--x: 1`))
  assert.doesNotThrow(() => rawZIndexes(`${'@media all{'.repeat(12000)}.a { z-index: 60 }`))
})
