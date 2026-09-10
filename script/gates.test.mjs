import assert from 'node:assert/strict'
import { test } from 'node:test'

import { withoutComments } from './check-layering.mjs'
import { prose } from './design-doc.mjs'
import * as usage from './design-usage.mjs'
import { squaresOf } from './design-audit.mjs'
import { brandsIn } from './brands.mjs'
import { ciCommands, gateCommands } from './check-verify-drift.mjs'
import { methodsIn, reachedBy } from './check-reachable.mjs'
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
  assert.match(read, /pnpm run build/)
  // A folded scalar is one command, not one command per line.
  assert.match(read, /node script\/check-secrets\.mjs --strict/)
})

test('quoting style does not change what CI is seen to run', () => {
  const yaml = ['    steps:', '      - run: node --test "script/*.test.mjs"'].join('\n')
  // The comparison strips quotes on both sides; a formatter must not be able
  // to make a step disappear by rewriting them.
  assert.match(ciCommands(yaml), /node --test script\/\*\.test\.mjs/)
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

  // The controls: both shapes a real call is written in.
  assert.deepEqual([...reachedBy(methods, ["await request('team/inbound', { mode })"])], ['team/inbound'])
  assert.deepEqual(
    [...reachedBy(methods, ["await this.transport.request(\n  'team/inbound',\n  { mode },\n)"])],
    ['team/inbound'],
  )
})
