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
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from '@typescript/typescript6'

import { withoutComments } from './lib/without-comments.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The designated wiring point where runtimes are chosen. */
const EXEMPT = new Set([join('packages', 'server', 'src', 'bootstrap.ts')])

/** Only dependency syntax counts; descriptions of a package are not imports. */
const importSpecifiers = (source, fileName) => {
  const code = withoutComments(source, fileName, { strict: true })
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true)
  const specifiers = []
  const add = (node) => specifiers.push(node && ts.isStringLiteralLike(node) ? node.text : null)
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers
}

const importBoundary = (pkg, source, fileName) => {
  const src = join(root, 'packages', pkg, 'src')
  const file = resolve(root, fileName)
  const views = join(src, 'views')
  const inViews = pkg === 'client' && !relative(views, file).startsWith(`..${sep}`) && relative(views, file) !== '..'
  const isNodeEntry = pkg === 'client' && file === join(src, 'node.ts')
  return importSpecifiers(source, fileName).filter((specifier) => {
    // A computed dependency cannot be held to a package boundary.
    if (specifier === null) return true
    if (specifier.startsWith('.')) {
      // Keep local module names literal rather than resolving ESM URL syntax.
      if (/[?#%]/.test(specifier)) return true
      const target = resolve(dirname(file), specifier)
      const within = relative(inViews ? views : src, target)
      if (within === '..' || within.startsWith(`..${sep}`)) return true
      // A core helper cannot re-export the Node transport into the core entry.
      return pkg === 'client' && !isNodeEntry && target.replace(/\.[cm]?[jt]sx?$/, '') === join(src, 'node')
    }
    if (specifier === '@harnessdesk/protocol') return false
    if (pkg === 'cli' && (specifier === '@harnessdesk/client' || specifier.startsWith('@harnessdesk/client/'))) return false
    if (isNodeEntry && (specifier === 'ws' || specifier.startsWith('node:'))) return false
    return true
  })
}

/**
 * Two planes, two rules. Codex must not leak above its adapter, and the
 * extension kernel must not leak above its host — and the protocol, which both
 * sit on, must not know about either.
 */
export const RULES = [
  {
    label: 'ui client import boundary',
    packages: ['ui'],
    offenders: (source, fileName) => importSpecifiers(source, fileName).filter((specifier) => {
      if (specifier === null) return true
      if (/^@harnessdesk\/client(?:\/|$)/.test(specifier)) return specifier !== '@harnessdesk/client/views'
      if (!specifier.startsWith('.')) return false
      const target = resolve(dirname(resolve(root, fileName)), specifier)
      const within = relative(join(root, 'packages', 'client'), target)
      return within !== '..' && !within.startsWith(`..${sep}`)
    }),
    remedy: 'The window imports @harnessdesk/client/views only; transports remain outside the renderer.',
  },
  {
    label: 'client import boundary',
    packages: ['client'],
    offenders: (source, file) => importBoundary('client', source, file),
    remedy: 'client imports protocol and its own core; views imports only protocol and its own files; only src/node.ts imports ws and node builtins.',
  },
  {
    label: 'cli import boundary',
    packages: ['cli'],
    offenders: (source, file) => importBoundary('cli', source, file),
    remedy: 'cli imports @harnessdesk/client, @harnessdesk/protocol and its own command modules.',
  },
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
    forbidden: /(?:from|require|import)\s*(?:\(\s*)?['"`]node:/,
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
export const DOCUMENTATION = /packages[/\\]ui[/\\]src[/\\]design[/\\](explorer|showcase)[/\\]/

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
      if (rule.offenders ? rule.offenders(codeOf(file), file).length > 0 : rule.forbidden.test(codeOf(file))) {
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
