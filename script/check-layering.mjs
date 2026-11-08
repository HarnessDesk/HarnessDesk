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
/** Compare conservatively on every platform: macOS can resolve differently cased paths to the same module. */
const comparisonPath = path => resolve(path).toLowerCase()

/** The designated wiring point where runtimes are chosen. */
const EXEMPT = new Set([join('packages', 'server', 'src', 'bootstrap.ts')])
const LEAD_TRANSPORT_MODULES = ['net', 'process', 'readline', 'stream', 'events', 'timers/promises', 'crypto', 'url'].map(name => `node:${name}`)
const LEAD_ENTRIES = new Map([
  [comparisonPath(join(root, 'packages/lead/src/child.ts')), new Set([...LEAD_TRANSPORT_MODULES, 'ws'])],
  [comparisonPath(join(root, 'packages/lead/src/supervisor.ts')), new Set([...LEAD_TRANSPORT_MODULES, 'node:child_process', 'node:path'])],
])
// Allowlists govern direct entry imports only; allowed client/node retains its transitive Node authority.
// Static lint: aliasing (const p = process), non-literal computed keys, Reflect,
// Object.getPrototypeOf/getOwnPropertyDescriptor and indirect prototype walks are not caught;
// review must check these residual paths.
// Step 9's runtime permission model is the boundary; this rule is a lint, not a sandbox.
const LEAD_GLOBALS = new Set(['process', 'globalThis', 'global', 'require', 'module', 'eval', 'Function',
  'fetch', 'WebSocket', 'XMLHttpRequest', 'Buffer'])
const prototypeKeys = new Set(['constructor', '__proto__'])
const blockedProcessMembers = new Set(['binding', 'dlopen', '_linkedBinding', 'mainModule', 'moduleLoadList', ...prototypeKeys])
const unwrapParentheses = node => {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression
  return node
}
const propertyKey = node => {
  if (!node) return null
  if (ts.isComputedPropertyName(node)) {
    const expression = unwrapParentheses(node.expression)
    return ts.isStringLiteralLike(expression) ? expression.text : null
  }
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null
}
const isProcess = node => {
  node = unwrapParentheses(node)
  return node && ts.isIdentifier(node) && node.text === 'process'
}

/** Assignment patterns may be nested, array-wrapped, or used as a loop initializer. */
const inAssignmentPattern = node => {
  for (let at = node.parent; at; at = at.parent) {
    const parent = at.parent
    if (!parent) return false
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return parent.left === at
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === at
    if (!(ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent) ||
      ts.isPropertyAssignment(parent) || ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent) ||
      ts.isParenthesizedExpression(parent))) return false
  }
  return false
}

const typeOnlyIdentifier = node => {
  for (let at = node.parent; at; at = at.parent) {
    // The expression in a class's extends clause is evaluated; its type arguments are not.
    if (ts.isExpressionWithTypeArguments(at) && at.parent.token === ts.SyntaxKind.ExtendsKeyword &&
      (ts.isClassDeclaration(at.parent.parent) || ts.isClassExpression(at.parent.parent))) return false
    if (ts.isTypeNode(at) || ts.isTypeParameterDeclaration(at) || ts.isInterfaceDeclaration(at) || ts.isTypeAliasDeclaration(at)) return true
    if ((ts.isImportSpecifier(at) || ts.isImportClause(at) || ts.isImportEqualsDeclaration(at) || ts.isExportSpecifier(at) || ts.isExportDeclaration(at)) && at.isTypeOnly) return true
  }
  return false
}
const bindingIdentifier = node => {
  const parent = node.parent
  return parent.name === node && (ts.isVariableDeclaration(parent) || ts.isParameter(parent) ||
    ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isEnumDeclaration(parent) ||
    ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent))
}
const valueIdentifier = node => {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return false
  if ((ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) && parent.propertyName === node) return false
  if (ts.isExportSpecifier(parent)) {
    if (parent.parent.parent.moduleSpecifier) return false
    if (parent.propertyName && parent.name === node) return false
  }
  if ((ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false
  return true
}

/** Core code has injected ports, never ambient authority, including aliases. */
const leadAuthorityOffenders = (source, fileName) => {
  const entryModules = LEAD_ENTRIES.get(comparisonPath(resolve(root, fileName)))
  const forbidden = new Set(LEAD_GLOBALS)
  if (entryModules) for (const allowed of ['process', 'fetch', 'Buffer', 'WebSocket']) forbidden.delete(allowed)
  const file = ts.createSourceFile(fileName, withoutComments(source, fileName, { strict: true }), ts.ScriptTarget.Latest, true)
  const offenders = []
  const visit = node => {
    if (ts.isIdentifier(node) && !typeOnlyIdentifier(node) &&
      ((LEAD_GLOBALS.has(node.text) && bindingIdentifier(node)) || (forbidden.has(node.text) && valueIdentifier(node)))) offenders.push(node.text)
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) offenders.push('require')
    const element = ts.isElementAccessExpression(node) ? unwrapParentheses(node.argumentExpression) : null
    const member = ts.isPropertyAccessExpression(node) ? node.name.text
      : element && ts.isStringLiteralLike(element) ? element.text : null
    const key = ts.isBindingElement(node) ? node.propertyName ?? node.name
      : (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isPropertyDeclaration(node)) ? node.name : null
    if (prototypeKeys.has(member) || prototypeKeys.has(propertyKey(key))) offenders.push('prototype/constructor key')
    if (entryModules) {
      if (ts.isElementAccessExpression(node) && isProcess(node.expression) &&
        (!ts.isStringLiteral(element) || blockedProcessMembers.has(element.text))) offenders.push('computed process member')
      const patternSource = ts.isBindingElement(node) ? node.parent.parent.initializer
        : (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isBinaryExpression(node.parent.parent) &&
          node.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.parent.parent.right : null
      const computedKey = key && ts.isComputedPropertyName(key) ? unwrapParentheses(key.expression) : null
      if (computedKey && isProcess(patternSource) &&
        (!ts.isStringLiteral(computedKey) || blockedProcessMembers.has(computedKey.text) || computedKey.text === 'getBuiltinModule'))
        offenders.push('computed process binding')
      if (blockedProcessMembers.has(member)) offenders.push(member)
      if (member === 'getBuiltinModule') {
        const call = node.parent
        const argument = ts.isCallExpression(call) && call.expression === node ? call.arguments[0] : null
        if (!argument || !ts.isStringLiteral(argument) || !entryModules.has(argument.text)) offenders.push('getBuiltinModule')
      }
      // Loader handles cannot be extracted into aliases or imported as named bindings.
      const loaderKey = propertyKey(key)
      if ((ts.isBindingElement(node) || ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && inAssignmentPattern(node))) &&
        (loaderKey === 'getBuiltinModule' || blockedProcessMembers.has(loaderKey)))
        offenders.push('process loader binding')
      if (ts.isImportSpecifier(node) && (node.propertyName?.text === 'getBuiltinModule' || node.name.text === 'getBuiltinModule' ||
        blockedProcessMembers.has(node.propertyName?.text ?? node.name.text)) &&
        node.parent.parent.parent.moduleSpecifier?.text === 'node:process') offenders.push('process loader import')
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      (ts.isElementAccessExpression(node) || node.name.text === 'resolve')) offenders.push('import.meta.resolve')
    ts.forEachChild(node, visit)
  }
  visit(file)
  return offenders
}

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
  const src = comparisonPath(join(root, 'packages', pkg, 'src'))
  const file = comparisonPath(resolve(root, fileName))
  const views = join(src, 'views')
  const inViews = pkg === 'client' && !relative(views, file).startsWith(`..${sep}`) && relative(views, file) !== '..'
  const isNodeEntry = pkg === 'client' && file === join(src, 'node.ts')
  const leadEntries = ['child', 'supervisor'].map(name => join(src, name))
  const isLeadEntry = pkg === 'lead' && LEAD_ENTRIES.has(file)
  return importSpecifiers(source, fileName).filter((specifier) => {
    // A computed dependency cannot be held to a package boundary.
    if (specifier === null) return true
    if (specifier.startsWith('.')) {
      // Keep local module names literal rather than resolving ESM URL syntax.
      if (/[?#%\\]/.test(specifier)) return true
      const target = comparisonPath(resolve(dirname(file), specifier))
      const within = relative(inViews ? views : src, target)
      if (within === '..' || within.startsWith(`..${sep}`)) return true
      // No helper or barrel may smuggle process/transport authority into the loop.
      if (pkg === 'lead') {
        const module = target.replace(/\.[cm]?[jt]sx?$/, '')
        const entry = leadEntries.find(entry => module === entry || module === join(entry, 'index'))
        // The sole process-entry edge is supervisor -> child; helpers are always portable.
        if (entry) return !(file === join(src, 'supervisor.ts') && entry === join(src, 'child'))
      }
      // A core helper cannot re-export the Node transport into the core entry.
      return pkg === 'client' && !isNodeEntry && target.replace(/\.[cm]?[jt]sx?$/, '') === join(src, 'node')
    }
    if (specifier === '@harnessdesk/protocol') return false
    if (pkg === 'cli' && (specifier === '@harnessdesk/client' || specifier.startsWith('@harnessdesk/client/'))) return false
    if (pkg === 'lead' && specifier === '@harnessdesk/client') return false
    if (isLeadEntry && (specifier === '@harnessdesk/client/node' || LEAD_ENTRIES.get(file).has(specifier))) return false
    if (isNodeEntry && (specifier === 'ws' || specifier.startsWith('node:'))) return false
    return true
  })
}

/** What the cloud wire's two packages may import: their own source, and zod for contract. */
const cloudWireImports = (source, fileName) => {
  const file = resolve(root, fileName)
  const pkg = relative(join(root, 'packages'), file).split(sep)[0]
  const src = join(root, 'packages', pkg, 'src')
  return importSpecifiers(source, fileName).filter((specifier) => {
    if (specifier === null) return true
    if (specifier.startsWith('.')) {
      if (/[?#%]/.test(specifier)) return true
      const within = relative(src, resolve(dirname(file), specifier))
      return within === '..' || within.startsWith(`..${sep}`)
    }
    return !(specifier === 'zod' && pkg === 'contract')
  }).concat(nodeGlobals(source, fileName))
}

/**
 * Node's globals need no import, and the base tsconfig gives every package
 * Node's types, so the compiler would accept them in the cloud wire too. The
 * relay Worker and the phone have none of them.
 */
const NODE_GLOBALS = new Set(['Buffer', 'process', 'global', '__dirname', '__filename', 'setImmediate', 'clearImmediate', 'require', 'module', 'exports'])

const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'window'])

const nodeGlobals = (source, fileName) => {
  const code = withoutComments(source, fileName, { strict: true })
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true)
  const found = []
  const visit = (node) => {
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text)) {
      const parent = node.parent
      const isMemberName = (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) ||
          ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node)
      // require('x') is already reported by its specifier.
      const isRequireCall = node.text === 'require' && ts.isCallExpression(parent) && parent.expression === node
      if (!isMemberName && !isRequireCall) found.push(node.text)
    }
    // globalThis.Buffer, self.process and globalThis['Buffer'] reach the same globals by another road.
    const viaGlobalObject = (object) => {
      // (globalThis as any).Buffer, (globalThis).process and globalThis!.process are the same reach.
      let o = object
      while (ts.isParenthesizedExpression(o) || ts.isAsExpression(o) || ts.isNonNullExpression(o) || ts.isTypeAssertionExpression(o) ||
             ts.isSatisfiesExpression(o)) o = o.expression
      return ts.isIdentifier(o) && GLOBAL_OBJECTS.has(o.text)
    }
    if (ts.isPropertyAccessExpression(node) && viaGlobalObject(node.expression) && NODE_GLOBALS.has(node.name.text)) found.push(node.name.text)
    if (ts.isElementAccessExpression(node) && viaGlobalObject(node.expression) && ts.isStringLiteralLike(node.argumentExpression) &&
        NODE_GLOBALS.has(node.argumentExpression.text)) found.push(node.argumentExpression.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** What reaches the cloud wire from the renderer or the protocol, by name or by path. */
const cloudWireReach = (source, fileName) => {
  const file = resolve(root, fileName)
  return importSpecifiers(source, fileName).filter((specifier) => {
    if (specifier === null) return false
    if (/^@harnessdesk\/(?:contract|crypto)(?:\/|$)/.test(specifier)) return true
    if (!specifier.startsWith('.')) return false
    const target = resolve(dirname(file), specifier)
    return ['contract', 'crypto'].some((pkg) => {
      const within = relative(join(root, 'packages', pkg), target)
      return within !== '..' && !within.startsWith(`..${sep}`)
    })
  })
}

/**
 * Two planes, two rules. Codex must not leak above its adapter, and the
 * extension kernel must not leak above its host — and the protocol, which both
 * sit on, must not know about either.
 */
export const RULES = [
  {
    label: 'lead import boundary',
    packages: ['lead'],
    offenders: (source, file) => {
      const imports = importBoundary('lead', source, file)
      return imports.length ? imports : leadAuthorityOffenders(source, file)
    },
    remedy: 'Lead core uses injected ports, local portable modules, protocol and client core; ambient machine/network authority is forbidden. Rename local bindings that shadow banned globals. Only src/child.ts and src/supervisor.ts own allowlisted transport/process authority; loader/evaluator restrictions remain active there.',
  },
  {
    label: 'ui lead import boundary',
    packages: ['ui'],
    offenders: (source, fileName) => importSpecifiers(source, fileName).filter(specifier => {
      if (specifier === null) return true
      if (/^@harnessdesk\/lead(?:\/|$)/i.test(specifier)) return true
      if (/^(?:[\\/]|[A-Za-z]:[\\/]|file:)/i.test(specifier)) return true
      if (!specifier.startsWith('.')) return false
      let decoded
      try { decoded = decodeURIComponent(specifier.split(/[?#]/)[0]) } catch { return true }
      if (decoded.includes('\\')) return true
      const target = comparisonPath(resolve(dirname(resolve(root, fileName)), decoded))
      const within = relative(comparisonPath(join(root, 'packages', 'lead')), target)
      return within !== '..' && !within.startsWith(`..${sep}`)
    }),
    remedy: 'The renderer reads Lead projections from protocol over the host wire; it never imports the Lead package. Computed dependencies and absolute filesystem specifiers cannot prove this boundary; use literal package or local imports.',
  },
  {
    label: 'ui client import boundary',
    packages: ['ui'],
    offenders: (source, fileName) => importSpecifiers(source, fileName).filter((specifier) => {
      if (specifier === null) return true
      if (/^@harnessdesk\/client(?:\/|$)/i.test(specifier)) return specifier !== '@harnessdesk/client/views'
      if (!specifier.startsWith('.')) return false
      if (specifier.includes('\\')) return true
      const target = comparisonPath(resolve(dirname(resolve(root, fileName)), specifier))
      const within = relative(comparisonPath(join(root, 'packages', 'client')), target)
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
    // The cloud wire runs in three places: this desk, the hosted relay Worker
    // and the phone, which reimplements it from the test vectors. Any import
    // that is not its own file is a place one of the three cannot follow: a
    // Node builtin (with or without the node: prefix), a package, a workspace
    // neighbour, or a Node global such as Buffer or process. Contract may use
    // zod for its schemas; crypto uses nothing.
    label: 'cloud wire stands alone',
    packages: ['contract', 'crypto'],
    offenders: (source, fileName) => cloudWireImports(source, fileName),
    remedy: 'contract imports its own files and zod; crypto imports its own files only. Both otherwise use Web platform APIs, never Node globals such as Buffer or process.',
  },
  {
    // Keys are held by the host and the main process. The window reads state
    // over the wire; it never signs, seals or opens anything itself.
    label: 'cloud wire above the renderer',
    packages: ['ui', 'protocol'],
    offenders: (source, fileName) => cloudWireReach(source, fileName),
    remedy: 'The renderer and the protocol never import the cloud wire; the host holds the keys.',
  },
  {
    label: 'Codex above adapter-codex',
    packages: ['protocol', 'server', 'ui', 'cordis-host', 'adapter-testkit', 'extension-protocol', 'extension-host', 'transport-acp', 'adapter-acp', 'lead'],
    forbidden: /@harnessdesk\/codex|@harnessdesk\/adapter-codex/,
    remedy: 'These layers must speak only @harnessdesk/protocol.',
  },
  {
    label: 'Cordis above cordis-host',
    packages: ['protocol', 'server', 'ui', 'adapter-codex', 'adapter-testkit', 'extension-protocol', 'lead'],
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
    packages: ['protocol', 'server', 'ui', 'adapter-codex', 'cordis-host', 'extension-host', 'extension-protocol', 'plugins', 'adapter-testkit', 'codex', 'transport-acp', 'adapter-acp', 'responses-gateway', 'agent-inventory', 'lead'],
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

const walk = (dir, scanAll = false) => {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!scanAll && ['node_modules', 'dist', 'generated'].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, scanAll))
    else if ((scanAll ? /\.[cm]?[jt]sx?$/i : /\.tsx?$/).test(full)) out.push(full)
  }
  return out
}

/** Lead compiles generated sources too, so none may escape the same boundary. */
export const sourceFilesOf = (pkg, base = root) => walk(join(base, 'packages', pkg, 'src'), pkg === 'lead')

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
    for (const file of sourceFilesOf(pkg)) {
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
