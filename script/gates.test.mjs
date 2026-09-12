import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withoutComments } from './check-layering.mjs'
import { prose } from './design-doc.mjs'
import * as usage from './design-usage.mjs'
import { sheetsOf, squaresOf } from './design-audit.mjs'
import { brandsIn } from './brands.mjs'
import { ciCommands, gateCommands, missingFromCI } from './check-verify-drift.mjs'
import { DESCRIBED_AS, problemsWith, sectionOf, stepNames } from './check-verify-steps.mjs'
import { ALLOWED, pathsIn, problemsWith as docPathProblems } from './check-doc-paths.mjs'
import { offendersIn } from './check-secrets.mjs'
import { methodsIn, reachedBy } from './check-reachable.mjs'
import { TEST_GLOB, distSegments, globToRegExp } from './prune-dist.mjs'
import { createSteps } from './lib/steps.mjs'
import { leadComment } from './design-doc.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  assert.deepEqual(usage.slotOffenders('<Dialog footer={<Btn variant="ghost">Save</Btn>} />', 'F.tsx'), [
    "F.tsx: <Btn variant=\"ghost\"> in a dialog's footer",
  ])
  assert.deepEqual(usage.slotOffenders('<Dialog footer={<Btn variant="secondary">Cancel</Btn>} />', 'F.tsx'), [])
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

test('two ink actions is two primaries, and a conditional slot is left alone', () => {
  assert.deepEqual(
    usage.slotOffenders('<Dialog footer={<><Btn variant="default">A</Btn><Btn variant="primary">B</Btn></>} />', 'F.tsx'),
    ["F.tsx: 2 ink actions in a dialog's footer, which holds one"],
  )
  // Both of these are correct code that earlier versions of this rule
  // reported. The library's apply dialog writes two ink buttons in two
  // branches and shows one; a conditional label nested in a fragment is the
  // ordinary way to write "Save or Create". Deciding which branch renders is
  // a JSX parser's job, so where there is a conditional this says nothing.
  const branched =
    '<Dialog footer={r ? (<Btn variant="primary">Close</Btn>) : (<><Btn variant="primary">Apply</Btn><Btn>Cancel</Btn></>)} />'
  assert.deepEqual(usage.slotOffenders(branched, 'F.tsx'), [])
  const nested =
    '<Dialog footer={<><Btn variant="secondary">Cancel</Btn>{e ? <Btn variant="default">Save</Btn> : <Btn variant="default">Create</Btn>}</>} />'
  assert.deepEqual(usage.slotOffenders(nested, 'F.tsx'), [])
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

test("a comment's divider becomes a heading rather than a rule and a stray line", () => {
  const comment = ['/**', ' * Title.', ' *', ' * ' + '-'.repeat(20), ' * Why this is data', ' *', ' * Because.', ' */'].join('\n')
  const out = leadComment(comment)
  assert.match(out, /^### Why this is data$/m)
  assert.doesNotMatch(out, /^-{10,}$/m)
})


test('a slot this cannot see into is reported, not skipped', () => {
  // Hoisting the action out of the tag emptied the region of JSX, so every
  // rule passed it in silence — a bypass an ordinary refactor opens without
  // meaning to.
  assert.deepEqual(usage.slotOffenders('<PageHead t="x" actions={headerAction} />', 'F.tsx'), [
    "F.tsx: a page head's action is held in `headerAction`, which this cannot read",
  ])
  assert.deepEqual(usage.slotOffenders('<Dialog footer={renderFooter()} />', 'F.tsx'), [
    "F.tsx: a dialog's footer is held in `renderFooter()`, which this cannot read",
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
    "  'team/room/join': shape({",
    "    'not/a/method': isString,",
    "    runtime: isString,",
    "  }),",
    "}",
  ].join('\n')
  assert.deepEqual(methodsIn(source), ['session/list', 'team/room/join'])
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
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  for (const file of ['package.json', 'script/verify.mjs', '.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8')
    assert.ok(text.includes(TEST_GLOB), `${file} runs the tests by the glob prune-dist.mjs writes`)
  }
})

test('the step that reads what the build writes says that it needs it (#208)', () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
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
  const named = new Map([[value, new Set(['docs/agents.md'])]])
  const allowed = new Map([[value, "DeepSeek Harness's own Rust source"]])
  // The control: a named path that resolves nowhere is exactly what the entry is for.
  assert.deepEqual(docPathProblems(named, () => false, allowed), [])
  /* An exception that outlives its reason is a hole nobody decided to leave
     open, so both ways it can go stale are reported. Same idiom as a
     DESCRIBED_AS entry for a step the gate no longer runs. */
  assert.match(docPathProblems(named, () => true, allowed)[0], /it resolves now/)
  assert.match(docPathProblems(new Map(), () => false, allowed)[0], /no document names it/)
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
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  for (const [value, reason] of ALLOWED) {
    assert.equal(fs.existsSync(path.join(repo, value)), false, `${value} is in this tree now: drop the entry`)
    assert.ok(reason.length > 20, `${value} needs a reason, not a label`)
  }
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
  ]) {
    assert.deepEqual(offendersIn('a.ts', line), [], line)
  }
  // Somebody's actual home directory is the leak this catches, under either root.
  const mac = offendersIn('a.ts', "const root = '/Users/jroe/code/HarnessDesk'") // hd-secrets-ok
  assert.equal(mac.length, 1)
  assert.match(mac[0], /rule 13/)
  assert.match(offendersIn('a.ts', "const root = '/home/jroe/code'")[0], /rule 13/) // hd-secrets-ok
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
