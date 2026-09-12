#!/usr/bin/env node
/**
 * The layering rule, as a build check.
 *
 * Nothing above `adapter-codex` may import a Codex package. Documented rules
 * erode; this one is what keeps a second runtime an adapter rather than a
 * rewrite, so it is enforced. Split out from `verify.mjs` so CI can run it
 * without a Codex installation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The designated wiring point where runtimes are chosen. */
const EXEMPT = new Set([join('packages', 'server', 'src', 'bootstrap.ts')])

/**
 * Two planes, two rules. Codex must not leak above its adapter, and the
 * extension kernel must not leak above its host — and the protocol, which both
 * sit on, must not know about either.
 */
const RULES = [
  {
    // The spin-off seam (PLAN 35.2): the scanner must run without the desk.
    // The day this rule fires is the day the standalone tool stops being a
    // packaging exercise and becomes a rewrite.
    label: 'HarnessDesk inside agent-inventory',
    packages: ['agent-inventory'],
    forbidden: /@harnessdesk\/(?!protocol)|electron|@deepseek-ai\/cordis/,
    remedy: 'agent-inventory imports node builtins and @harnessdesk/protocol, nothing else.',
  },
  {
    label: 'Codex above adapter-codex',
    packages: ['protocol', 'server', 'ui', 'cordis-host', 'adapter-testkit', 'extension-protocol', 'extension-host', 'transport-acp', 'adapter-acp'],
    forbidden: /@harnessdesk\/codex|@harnessdesk\/adapter-codex/,
    remedy: 'These layers must speak only @harnessdesk/protocol.',
  },
  {
    label: 'Cordis above cordis-host',
    packages: ['protocol', 'server', 'ui', 'adapter-codex', 'adapter-testkit', 'extension-protocol'],
    forbidden: /@deepseek-ai\/cordis/,
    remedy: 'Only @harnessdesk/cordis-host may import Cordis; everything else reads CapabilityRegistry.',
  },
  {
    // The IPC contract is what makes the plugin host independently reviewable;
    // a kernel import would let implementation details leak into the contract.
    label: 'kernel inside extension-protocol',
    packages: ['extension-protocol'],
    forbidden: /@harnessdesk\/cordis-host|@harnessdesk\/extension-host/,
    remedy: 'The extension protocol depends on @harnessdesk/protocol and nothing else.',
  },
  {
    // Third-party plugin code must run in the plugin host child. The kernel
    // reaching the renderer or the server directly would put plugin-executed
    // code one import away from the window and the wire.
    label: 'kernel above extension-host',
    packages: ['ui'],
    forbidden: /@harnessdesk\/cordis-host|@harnessdesk\/extension-host|@harnessdesk\/extension-protocol/,
    remedy: 'The renderer reads plugin state over the wire; it never touches the extension plane.',
  },
  {
    // Adapters must not know each other. The moment one imports another, the
    // second backend stops being an adapter and becomes a dependency.
    label: 'adapter importing adapter',
    packages: ['adapter-codex'],
    forbidden: /@harnessdesk\/adapter-(?!codex|testkit)/,
    remedy: 'Adapters share code by lifting it into protocol or a shared package, never sideways.',
  },
  {
    label: 'adapter importing adapter (acp)',
    packages: ['adapter-acp', 'transport-acp'],
    forbidden: /@harnessdesk\/adapter-(?!acp|testkit)|@harnessdesk\/codex/,
    remedy: 'Adapters share code by lifting it into protocol or a shared package, never sideways.',
  },
  {
    // The renderer runs in a browser context. A node: import means someone is
    // about to reach for the filesystem or a child process from the window.
    label: 'node builtins in the renderer',
    packages: ['ui'],
    forbidden: /from 'node:|require\('node:/,
    remedy: 'The renderer talks to the host over the wire; the host touches the machine.',
  },
  {
    // Secrets live in the main process behind the credential broker.
    // Nothing else may reach a keystore API, and the renderer may never.
    label: 'keystore access outside the broker',
    packages: ['protocol', 'server', 'ui', 'adapter-codex', 'cordis-host', 'extension-host', 'extension-protocol', 'plugins', 'adapter-testkit', 'codex', 'transport-acp', 'adapter-acp', 'responses-gateway', 'agent-inventory'],
    forbidden: /safeStorage|keytar|node-keychain|security find-generic-password/,
    remedy: 'Only the credential broker in the Electron main process may touch a keystore.',
  },
]

/**
 * The renderer rule: no component may test a backend id. The moment
 * `runtime.id === 'codex'` works, the second backend renders wrong.
 */
const RUNTIME_ID_COMPARISON = /[rR]untime(?:\.id)?\s*(?:===|!==|==|!=)\s*['"`]|['"`](?:codex|acp)['"`]\s*(?:===|!==|==|!=)/

const idComparisonOffenders = () => {
  const out = []
  for (const file of walk(join(root, 'packages', 'ui', 'src'))) {
    if (file.includes('.test.')) continue
    if (DOCUMENTATION.test(relative(root, file))) continue
    const lines = codeOf(file).split('\n')
    lines.forEach((line, index) => {
      if (RUNTIME_ID_COMPARISON.test(line)) {
        out.push(`${relative(root, file)}:${index + 1}  ${line.trim().slice(0, 90)}`)
      }
    })
  }
  return out
}

const walk = (dir) => {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

/**
 * Runtime brand names must not appear in rendered UI text.
 *
 * The shell describes a runtime using `RuntimeInfo.presentation`, which the
 * runtime fills in. A literal brand name in a component is a string that becomes
 * wrong the moment a second runtime is selected, and those are exactly the bugs
 * nobody notices until someone switches.
 */
const BRANDS = /\b(Codex|DeepSeek|Claude Code|Gemini)\b/

/**
 * The one place a brand name is allowed to be a literal: the design explorer.
 *
 * The rule above governs the shell, where naming a runtime is a bug waiting for
 * someone to select a different one. A design board is the opposite case — its
 * job is to show four runtimes at once, side by side, so that a roster, an
 * avatar stack and a board of claimed work can be judged with the real spread
 * of name lengths and marks in them. There is no `RuntimeInfo` to read: nothing
 * is connected, and a mock populated with "Runtime A" through "Runtime D"
 * would prove nothing about the layouts it exists to prove.
 *
 * Narrow on purpose. These two directories are documentation: `design.html` is
 * a separate build input, the explorer is the only thing that imports the
 * showcase, and no product screen reaches into either — `design:audit`'s
 * cross-import rule is what keeps that true.
 */
const DOCUMENTATION = /packages\/ui\/src\/design\/(explorer|showcase)\//

/**
 * How the parser should read a file, from its name.
 *
 * `.ts` and `.tsx` differ, and the difference is not cosmetic: `<T>(x: T) => x`
 * is a generic arrow in one and a JSX tag in the other. A `.js`, `.mjs` or
 * `.cjs` is read as JavaScript, JSX allowed — as TypeScript, `</p> // note` was
 * a regex literal and the comment stayed (review of #228, round 1).
 *
 * `.jsx` rides the same branch rather than having one of its own. TypeScript
 * gives `ScriptKind.JS` and `ScriptKind.JSX` one language variant, so the two
 * parse identically, and the branch that named `JSX` separately was one no
 * gate could reach: `walk` below takes `/\.tsx?$/` and `check-reachable`'s
 * `filesUnder` takes `.ts`, `.tsx`, `.mjs`, `.cjs` and `.js`. Dead branches in
 * the thing that decides what a rule sees are the ones worth not keeping
 * (review of #228, round 2).
 */
const kindOf = (fileName) =>
  /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/.test(fileName)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS

/**
 * Strips comments so the rule governs what users see, not what authors explain.
 *
 * TypeScript's own parser finds them, because nothing short of a parser can,
 * and three versions of this learned it one at a time. The first was a pattern
 * that opened a comment at any `/*`, so the glob in `files: ['src/api/**']` in
 * a fixture swallowed the three hundred lines after it, and everything in that
 * stretch was silently exempt from every rule in this file — including a brand
 * name in rendered text that had been sitting there unflagged. The second
 * guessed from the character before `/*` whether a comment could open there,
 * from a short list, and so kept a comment right after `)` or `;` as code
 * (#123). The third skipped quoted strings instead of guessing and lost its
 * place in the first real file it read: `Items.tsx` splits on a regex literal
 * holding three backticks, a scanner that is not a parser takes the first for
 * the start of a template string, and three of that file's doc comments came
 * out as rendered text. An apostrophe in JSX text does the same to a quote.
 * The parser tells a regex literal, JSX text and a template string apart, so
 * what is stripped here is exactly what the compiler would drop.
 *
 * A block comment keeps its line breaks, so a line number read from the result
 * is the file's own. Pass the file's name — `kindOf` above reads the extension,
 * and a file parsed as the wrong language is a file whose comments are in the
 * wrong places.
 *
 * A gate reading a real file asks for `strict`, which refuses a file the parser
 * could not read, by name, rather than strip what it guessed: a recovered
 * parse can leave a comment inside a token, where nothing here reaches it.
 */
export const withoutComments = (source, fileName = 'source.ts', { strict = false } = {}) => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kindOf(fileName))
  const problem = strict ? file.parseDiagnostics?.[0] : undefined
  if (problem) {
    const { line } = file.getLineAndCharacterOfPosition(problem.start ?? 0)
    throw new Error(`${fileName}:${line + 1}: TypeScript could not parse this file (${ts.flattenDiagnosticMessageText(problem.messageText, ' ')}), so its comments can't be told from its code`)
  }
  const comments = new Map()
  const visit = (node) => {
    // A doc comment's own nodes sit inside the comment; the token it documents
    // reads it whole, as trivia, like any other comment.
    if (node.kind === ts.SyntaxKind.JSDoc) return
    const children = node.kind === ts.SyntaxKind.EndOfFileToken ? [] : node.getChildren(file)
    if (children.length > 0) {
      for (const child of children) visit(child)
      return
    }
    // A token. Only a token's position is where trivia starts — a list of JSX
    // children starts where its first text does — and JSX text is what the
    // reader sees, `//` and all: there is no comment in it.
    if (node.kind === ts.SyntaxKind.JsxText) return
    // The compiler splits the run before a token at its first line break: what
    // comes before the break is the previous token's trailing comment, what
    // comes after is this one's leading comment. Leading alone misses
    // `getValue()/* Codex */`, which is the whole of #123.
    const before = [
      ...(ts.getTrailingCommentRanges(source, node.pos) ?? []),
      ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
    ]
    for (const range of before) comments.set(range.pos, range.end)
  }
  visit(file)
  let out = ''
  let at = 0
  for (const [pos, end] of [...comments].sort(([a], [b]) => a - b)) {
    out += source.slice(at, pos) + source.slice(pos, end).replace(/[^\n]/g, '')
    at = end
  }
  return out + source.slice(at)
}

/** Each file is parsed once, however many rules read it. */
const stripped = new Map()
const codeOf = (file) => {
  if (!stripped.has(file)) stripped.set(file, withoutComments(readFileSync(file, 'utf8'), file, { strict: true }))
  return stripped.get(file)
}

const brandOffenders = () => {
  const out = []
  for (const file of walk(join(root, 'packages', 'ui', 'src'))) {
    if (!file.endsWith('.tsx')) continue
    if (file.includes('.test.')) continue
    if (DOCUMENTATION.test(relative(root, file))) continue
    const lines = codeOf(file).split('\n')
    lines.forEach((line, index) => {
      if (BRANDS.test(line)) out.push(`${relative(root, file)}:${index + 1}  ${line.trim().slice(0, 90)}`)
    })
  }
  return out
}

/* Everything below is the command; everything above is importable, so the
   stripper this gate depends on can be tested without running the gate. It
   was silently wrong for months and nothing could have said so. */
const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
let failed = false
for (const rule of RULES) {
  const offenders = []
  for (const pkg of rule.packages) {
    for (const file of walk(join(root, 'packages', pkg, 'src'))) {
      const relativePath = relative(root, file)
      if (EXEMPT.has(relativePath)) continue
      // Comments may *explain* a boundary; only code can cross one.
      if (rule.forbidden.test(codeOf(file))) {
        offenders.push(relativePath)
      }
    }
  }
  if (offenders.length > 0) {
    failed = true
    console.error(`Layering violation — ${rule.label}:\n`)
    for (const file of offenders) console.error(`  ${file}`)
    console.error(`\n${rule.remedy} See docs/architecture.md.\n`)
  }
}

const brands = brandOffenders()
if (brands.length > 0) {
  failed = true
  console.error('Runtime brand names in rendered UI text:\n')
  for (const line of brands) console.error(`  ${line}`)
  console.error(
    '\nUse RuntimeInfo.presentation instead — the runtime describes itself, the shell renders it.\n',
  )
}

const comparisons = idComparisonOffenders()
if (comparisons.length > 0) {
  failed = true
  console.error('Backend id comparisons in the renderer:\n')
  for (const line of comparisons) console.error(`  ${line}`)
  console.error(
    '\nGate on runtime.capabilities, never on which runtime it is — the Phase C rule.\n',
  )
}

if (failed) process.exit(1)
console.log(
  `Layering rules hold (${RULES.length} rules, runtime-neutral UI, no backend id comparisons).`,
)
}
