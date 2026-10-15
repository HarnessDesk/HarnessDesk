// Server classification uses the compiler parser after dependencies are installed.
// The CI planners keep using the dependency-free suite graph in ci-imports.mjs.
import { readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import ts from '@typescript/typescript6'

import { E2E_PAGES, IMPORT, SOURCE, SPEC, URL_IMPORT, findFile, resolveHelper, suiteGraph, walk } from './ci-imports.mjs'

const builtRoute = value => value === 'about:blank' || E2E_PAGES.some(page =>
  new RegExp(`^(?:https?://[^/]+)?/?${page.replaceAll('.', '\\.')}(?:[?#]|$)`).test(value))

const literalValue = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
const bindingNames = node => ts.isIdentifier(node) ? [node.text]
  : ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node) ? node.elements.flatMap(element => element.name ? bindingNames(element.name) : []) : []

// Resolve a literal const in the nearest lexical scope. A parameter or another
// declaration shadows an outer const; concatenation and calls remain unknown.
function constantValue(expression) {
  if (!expression || !ts.isIdentifier(expression)) return null
  for (let scope = expression.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => bindingNames(parameter.name).includes(expression.text))) return null
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingNames(scope.variableDeclaration.name).includes(expression.text)) return null
    if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)
      && scope.initializer.declarations.some(declaration => bindingNames(declaration.name).includes(expression.text))) return null
    for (const statement of scope.statements ?? []) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!bindingNames(declaration.name).includes(expression.text)) continue
        if (!ts.isIdentifier(declaration.name)) return null
        return statement.declarationList.flags & ts.NodeFlags.Const ? literalValue(declaration.initializer) : null
      }
    }
  }
  return null
}

function builtNavigation(expression) {
  const literal = literalValue(expression) ?? constantValue(expression)
  if (literal !== null) return builtRoute(literal)
  if (!expression || !ts.isTemplateExpression(expression)) return false
  let head = expression.head.text
  // The suite's absolute navigation uses the configured base URL as origin.
  // Other interpolations may vary the query, but may never choose a pathname.
  if (head === '' && expression.templateSpans[0].expression.getText() === 'origin') head = expression.templateSpans[0].literal.text
  return /[?#]/.test(head) && builtRoute(head)
}

function staticRoute(expression) {
  const literal = literalValue(expression)
  // Only API routes and bounded non-source assets are known safe. A computed
  // pattern or a broad wildcard could intercept a transformed source module.
  if (literal !== null) return /^(?:\*\*)?\/api\//.test(literal)
    || /\.(?:json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|html)$/.test(literal)
  if (!expression || !ts.isRegularExpressionLiteral(expression)) return false
  const pattern = expression.text.slice(1, expression.text.lastIndexOf('/'))
  if (pattern.includes('|')) return false
  return /\\\.(?:json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|html)\$$/.test(pattern)
    // A fixed extensionless path followed by a literal query delimiter, with
    // an end anchor, cannot match a source filename. The preview-frame rig uses this.
    || /^(?:\^)?(?:\\\/)?[\w-]+(?:\\\/[\w-]+)*\\\?.*\$$/.test(pattern)
}

function browserDependency(text) {
  if (/\bserviceWorkers\s*:|\bnavigator\.serviceWorker\b|\bregisterServiceWorker\b|\.serviceWorkers\s*\(/.test(text)) return 'service worker dependency'
  const source = ts.createSourceFile('suite.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let reason = null
  const visit = node => {
    if (reason) return
    if (ts.isPropertyAssignment(node) && (literalValue(node.name) ?? node.name.getText(source)) === 'serviceWorkers') reason = 'service worker dependency'
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'navigator' && node.name.text === 'serviceWorker') reason = 'service worker dependency'
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const receiver = node.expression.expression.getText(source)
      const first = node.arguments[0]
      if (method === 'goto' && !builtNavigation(first)) reason = 'unbuilt or unknown page route'
      if (method === 'route' && (receiver !== 'page' || !staticRoute(first))) reason = 'source or unknown route interception'
      if (method === 'routeFromHAR') reason = 'HAR route interception'
      if (method === 'addScriptTag' || method === 'addStyleTag') {
        if (!first || !ts.isObjectLiteralExpression(first)) reason = 'unknown script or stylesheet options'
        else for (const property of first.properties) {
          const key = property.name && (literalValue(property.name) ?? property.name.getText(source))
          if (ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name)) || key === 'url') reason = 'unbuilt script or stylesheet URL'
          if (key === 'path' && (literalValue(property.initializer) === null || /^\/?src\//.test(literalValue(property.initializer)))) reason = 'source or unknown script path'
        }
      }
      if (method === 'addInitScript') {
        if (!first || !(ts.isArrowFunction(first) || ts.isFunctionExpression(first) || literalValue(first) !== null || ts.isObjectLiteralExpression(first))) reason = 'unknown init script'
        else if (ts.isObjectLiteralExpression(first) && (first.properties.length !== 1 || first.properties.some(property => !ts.isPropertyAssignment(property)
          || (literalValue(property.name) ?? property.name.getText(source)) !== 'content' || literalValue(property.initializer) === null))) reason = 'unknown init script'
        else if (/\bimport\s*\(/.test(first.getText(source))) reason = 'init script module import'
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return reason
}

function devServerReason(text) {
  for (const match of text.matchAll(/(?<![\w.])\/(?:src\/|@fs\/|@vite\/|@id\/|node_modules\/\.vite(?:\/|\b)|site-demo\/)/g)) {
    const rest = text.slice(match.index)
    if (!E2E_PAGES.some(page => rest.startsWith(`/${page}`) && /^[?#'"`]/.test(rest.slice(page.length + 1)))) return 'dev module URL'
  }
  if (/\bimport\.meta\.hot\b/.test(text)) return 'hot module API'
  for (const [, specifier] of text.matchAll(IMPORT)) {
    if (specifier.startsWith('/')) return 'absolute module import'
  }
  if (/\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(?!['"\s/])/.test(text)) return 'unknown dynamic import'
  // Rewrites also occur with shortened globs (`**/lib/flow-model.ts` and
  // `**/run-shapes-fixture.ts`), without a /src/ prefix.
  if (/\.route\s*\(\s*['"`][^'"`\n]*\.[cm]?[jt]sx?\b/.test(text)) return 'source response rewrite'
  if (/\bfetch\s*\(|\brequest\.(?:get|post|put|patch|delete|head|fetch)\s*\(/.test(text)) return 'server request or response rewrite'
  return browserDependency(text)
}

// A spec is static only when every source in its suite closure can be read and
// none needs the dev server. Broken graphs stay on dev rather than losing an edge.
export function devServerReasons(root, graph) {
  let sources
  try {
    sources = graph?.sources ?? walk(join(root, 'e2e/ui-system')).filter(file => SOURCE.includes(extname(file)))
    graph ??= suiteGraph(root)
  } catch {
    return Object.fromEntries((sources ?? []).filter(file => SPEC.test(file))
      .map(file => [relative(join(root, 'e2e/ui-system'), file), 'unreadable suite graph']))
  }
  const reasons = {}
  const cache = new Map()
  for (const spec of sources.filter(file => SPEC.test(file))) {
    const seen = new Set()
    const queue = [spec]
    while (queue.length) {
      const file = queue.pop()
      if (seen.has(file)) continue
      seen.add(file)
      if (!cache.has(file)) {
        const entry = { reason: null, helpers: [...(graph.forward.get(file) ?? [])] }
        try {
          const text = readFileSync(file, 'utf8')
          entry.reason = devServerReason(text)
          // The selector treats files outside the suite as leaves. Server
          // classification must also read any helper those leaves import.
          if (!entry.reason && !file.startsWith(`${graph.suite}/`)) {
            for (const [, specifier] of text.matchAll(IMPORT)) {
              if (!specifier.startsWith('.')) continue
              const helper = resolveHelper(file, specifier)
              if (helper) entry.helpers.push(helper)
              else if (SOURCE.includes(extname(specifier))) entry.reason = 'unreadable helper graph'
            }
            for (const [, specifier] of text.matchAll(URL_IMPORT)) {
              const helper = findFile(file, specifier)
              if (helper) entry.helpers.push(helper)
              else entry.reason = 'unreadable helper graph'
            }
          }
        } catch { entry.reason = 'unreadable source or helper graph' }
        cache.set(file, entry)
      }
      const { reason, helpers } = cache.get(file)
      if (reason) {
        reasons[relative(graph.suite, spec)] = `${reason} (${relative(root, file)})`
        break
      }
      queue.push(...helpers)
    }
  }
  return reasons
}

export const devServerSpecs = (root, graph) => Object.keys(devServerReasons(root, graph)).sort()

// Preserve the caller's paths and order, including unknown paths, which must
// never be sent to preview on the strength of a graph that does not contain them.
export function splitServerSpecs(root, specs, graph) {
  try { graph ??= suiteGraph(root) }
  catch { return { static: [], dev: [...specs] } }
  const dev = new Set(devServerSpecs(root, graph))
  const known = new Set(graph.sources.filter(file => SPEC.test(file)))
  const split = { static: [], dev: [] }
  for (const spec of specs) {
    const file = resolve(spec.startsWith('e2e/') || spec.startsWith('/') ? root : graph.suite, spec)
    split[!known.has(file) || dev.has(relative(graph.suite, file)) ? 'dev' : 'static'].push(spec)
  }
  return split
}
