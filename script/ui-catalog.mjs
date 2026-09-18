#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { repositoryFiles } from './lib/repository-files.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const seedNames = (source, declarationName) => {
  const ast = ts.createSourceFile('manifest.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = []
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declarationName
    ) {
      let expression = node.initializer
      while (expression && (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))) {
        expression = expression.expression
      }
      if (expression && ts.isArrayLiteralExpression(expression)) {
        for (const item of expression.elements) {
          if (!ts.isArrayLiteralExpression(item)) continue
          const first = item.elements[0]
          if (first && ts.isStringLiteral(first)) names.push(first.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return names
}

export const declarationStrings = (source, declarationName) => {
  const ast = ts.createSourceFile('catalog-example.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let values = null
  const visit = (node) => {
    if (values || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== declarationName) {
      ts.forEachChild(node, visit)
      return
    }
    let expression = node.initializer
    while (expression && (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))) expression = expression.expression
    if (expression && ts.isArrayLiteralExpression(expression)) {
      values = expression.elements.filter(ts.isStringLiteral).map((item) => item.text)
    }
  }
  visit(ast)
  return values
}

/**
 * A coverage declaration is evidence only when the board actually iterates it
 * and stamps the current case onto the rendered component. This prevents an
 * accurate-looking array (or a data attribute made with `.join`) from claiming
 * cases that the catalog never mounts.
 */
export const renderedDeclarationStrings = (source, declarationName, axis) => {
  const ast = ts.createSourceFile('catalog-example.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const evidenceAttribute = `data-catalog-${axis}`
  let rendered = false
  const visit = (node) => {
    if (
      !rendered
      && ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'map'
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === declarationName
    ) {
      const callback = node.arguments[0]
      const parameter = callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        && callback.parameters[0]?.name
      if (parameter && ts.isIdentifier(parameter)) {
        const inspect = (child) => {
          if (rendered) return
          if (ts.isJsxAttribute(child) && child.name.text === evidenceAttribute) {
            const expression = child.initializer && ts.isJsxExpression(child.initializer)
              ? child.initializer.expression
              : null
            if (expression && ts.isIdentifier(expression) && expression.text === parameter.text) rendered = true
          }
          ts.forEachChild(child, inspect)
        }
        inspect(callback.body)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return rendered ? declarationStrings(source, declarationName) : null
}

const declarationIds = (source, declarationName) => {
  const ast = ts.createSourceFile('catalog-source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const ids = []
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === declarationName) {
      const walk = (current) => {
        if (ts.isObjectLiteralExpression(current)) {
          const property = current.properties.find((one) =>
            ts.isPropertyAssignment(one)
            && ((ts.isIdentifier(one.name) && one.name.text === 'id') || (ts.isStringLiteral(one.name) && one.name.text === 'id')))
          if (property && ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) ids.push(property.initializer.text)
        }
        ts.forEachChild(current, walk)
      }
      if (node.initializer) walk(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return ids
}

const propertyName = (property) => {
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) return property.name.text
  return null
}

export const cvaContract = (source) => {
  const ast = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let contract = null
  const visit = (node) => {
    if (contract || !ts.isCallExpression(node) || node.expression.getText(ast) !== 'cva') {
      ts.forEachChild(node, visit)
      return
    }
    const options = node.arguments[1]
    if (!options || !ts.isObjectLiteralExpression(options)) return
    const variantsProperty = options.properties.find((property) =>
      ts.isPropertyAssignment(property) && propertyName(property) === 'variants')
    if (!variantsProperty || !ts.isPropertyAssignment(variantsProperty) || !ts.isObjectLiteralExpression(variantsProperty.initializer)) return
    const axes = {}
    for (const axis of variantsProperty.initializer.properties) {
      if (!ts.isPropertyAssignment(axis) || !ts.isObjectLiteralExpression(axis.initializer)) continue
      const name = propertyName(axis)
      if (!name) continue
      axes[name] = axis.initializer.properties.map(propertyName).filter(Boolean)
    }
    contract = axes
  }
  visit(ast)
  return contract
}

export const catalogCoverage = ({ uiModules, patternModules, registeredUi, registeredPatterns }) => ({
  missingUi: uiModules.filter((name) => !registeredUi.includes(name)),
  staleUi: registeredUi.filter((name) => !uiModules.includes(name)),
  missingPatterns: patternModules.filter((name) => !registeredPatterns.includes(name)),
  stalePatterns: registeredPatterns.filter((name) => !patternModules.includes(name)),
})

const resolveSpecifier = (from, specifier, paths) => {
  const clean = specifier.replace(/\?.*$/, '')
  let base
  if (clean.startsWith('@/')) base = `packages/ui/src/${clean.slice(2)}`
  else if (clean.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean))
  else return null
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.css`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (paths.has(candidate)) return candidate
  }
  return null
}

/**
 * The exports a dynamic `import()` takes, when its shape says so; `null` when
 * it could take any — see the graph's dynamic edges below for why the line is
 * drawn where it is.
 */
export const exportsTaken = (call) => {
  const access = call.parent
  if (!access || !ts.isPropertyAccessExpression(access) || access.name.text !== 'then') return null
  const invoke = access.parent
  if (!invoke || !ts.isCallExpression(invoke) || invoke.expression !== access) return null
  const callback = invoke.arguments[0]
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return null
  const param = callback.parameters[0]?.name
  if (!param) return null
  if (ts.isObjectBindingPattern(param)) {
    if (param.elements.some((element) => element.dotDotDotToken)) return null
    const names = param.elements.map((element) => {
      const key = element.propertyName ?? element.name
      return ts.isIdentifier(key) ? key.text : null
    })
    return names.every((name) => name !== null) ? names : null
  }
  if (!ts.isIdentifier(param)) return null
  const names = []
  let whole = false
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === param.text && node !== param) {
      const parent = node.parent
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) names.push(parent.name.text)
      else whole = true
    }
    ts.forEachChild(node, visit)
  }
  visit(callback.body)
  return whole ? null : [...new Set(names)]
}

export const importGraph = (files) => {
  const paths = new Set(files.map((file) => file.path))
  return new Map(files.map((file) => {
    const info = { fileTargets: new Set(), symbols: new Map(), exportAll: new Set(), exports: new Set(), exportDependencies: new Map(), dynamicSymbols: [] }
    if (file.path.endsWith('.css')) {
      for (const match of file.source.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) {
        const target = resolveSpecifier(file.path, match[1], paths)
        if (target) info.fileTargets.add(target)
      }
      return [file.path, info]
    }
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) return [file.path, info]
    const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const exported = (node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    const identifiersUnder = (node) => {
      const names = new Set()
      const visit = (current) => {
        if (ts.isIdentifier(current)) names.add(current.text)
        ts.forEachChild(current, visit)
      }
      visit(node)
      return names
    }
    const localDependencies = new Map()

    /*
     * A lazily-loaded module is still a dependency — and, when the code says
     * which of its exports it takes, only those.
     *
     * `import('./surfaces')` behind a `React.lazy` used to be invisible to
     * this graph. Then it was recorded whole-file, which over-reached the
     * other way: every lazy handle reached every export of `surfaces.tsx`, so
     * a surface that stopped mounting its screen was still "reachable"
     * through a sibling that mounted the same one (#762 review).
     *
     * So the shape decides. `import(x).then((m) => … m.Name …)`, where the
     * parameter is only ever read as `m.Name`, and `import(x).then(({ Name })
     * => …)` without a rest element, name exactly the exports taken, and are
     * recorded as symbol edges. Anything else — an awaited import, `m` passed
     * on whole, a rest element, a helper that returns the import — could take
     * any export, and stays a whole-file edge: over-reaching is the safe
     * direction for "reachable", and the precise shape is one line to write.
     */
    const dynamicTargets = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const target = resolveSpecifier(file.path, node.arguments[0].text, paths)
        if (target) {
          const taken = exportsTaken(node)
          if (taken) for (const symbol of taken) info.dynamicSymbols.push({ target, symbol })
          else info.fileTargets.add(target)
        }
      }
      ts.forEachChild(node, dynamicTargets)
    }
    dynamicTargets(ast)

    for (const statement of ast.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        localDependencies.set(statement.name.text, identifiersUnder(statement))
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) localDependencies.set(declaration.name.text, identifiersUnder(declaration))
        }
      }
    }
    for (const statement of ast.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveSpecifier(file.path, statement.moduleSpecifier.text, paths)
        if (!target) continue
        const clause = statement.importClause
        if (!clause) {
          info.fileTargets.add(target)
          continue
        }
        if (clause.name) info.symbols.set(clause.name.text, { target, symbol: 'default' })
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            info.symbols.set(element.name.text, { target, symbol: element.propertyName?.text ?? element.name.text })
          }
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          info.symbols.set(clause.namedBindings.name.text, { target, symbol: '*' })
        }
        continue
      }
      if (ts.isExportDeclaration(statement)) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? resolveSpecifier(file.path, statement.moduleSpecifier.text, paths)
          : null
        if (!statement.exportClause) {
          if (target) info.exportAll.add(target)
          continue
        }
        if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const name = element.name.text
            info.exports.add(name)
            if (target) info.symbols.set(name, { target, symbol: element.propertyName?.text ?? name })
            else info.exportDependencies.set(name, localDependencies.get(element.propertyName?.text ?? name) ?? new Set())
          }
        }
        continue
      }
      if (exported(statement)) {
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
          info.exports.add(statement.name.text)
          info.exportDependencies.set(statement.name.text, localDependencies.get(statement.name.text) ?? new Set())
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              info.exports.add(declaration.name.text)
              info.exportDependencies.set(declaration.name.text, localDependencies.get(declaration.name.text) ?? new Set())
            }
          }
        }
      }
    }
    return [file.path, info]
  }))
}

/**
 * Whether `from` reaches `target` through the import graph.
 *
 * `from` is a file, or one export of it — `surfaces.tsx#RailSurface` — when
 * the question is what that export alone depends on. A file's whole closure
 * answers "is this code in the bundle", not "does this surface mount that
 * screen": the second needs the walk to start at the export (#762 review).
 * An anchor naming something the file does not export reaches nothing.
 */
export const isReachable = (graph, from, target) => {
  const [fromPath, anchor] = from.split('#')
  if (anchor === undefined && fromPath === target) return true
  const start = graph.get(fromPath)
  if (!start) return false
  if (anchor !== undefined && !start.exports.has(anchor)) return false
  const pending = anchor !== undefined
    ? [{ path: fromPath, symbol: anchor }]
    : [
      ...[...start.fileTargets].map((path) => ({ path, symbol: null })),
      ...[...start.symbols.values()].map((edge) => ({ path: edge.target, symbol: edge.symbol })),
      ...[...start.exportAll].map((path) => ({ path, symbol: '*' })),
      ...start.dynamicSymbols.map((edge) => ({ path: edge.target, symbol: edge.symbol })),
    ]
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) continue
    const key = `${current.path}\0${current.symbol ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const info = graph.get(current.path)
    if (!info) continue
    if (
      current.path === target
      && (current.symbol === null || current.symbol === '*' || info.exports.has(current.symbol))
    ) return true
    if (current.symbol === null) {
      /*
       * A whole-file edge reaches everything that file reaches.
       *
       * This followed `fileTargets` alone, so a file depended on without a
       * named symbol — a side-effect import, or a dynamic one — was a dead
       * end: whatever it imported *by name* was invisible from here. That is
       * how the surface boards could mount `components/Sidebar` through a
       * lazily-loaded module and still be reported unreachable. There is no
       * symbol to narrow by on this kind of edge, so the honest walk is the
       * whole closure.
       */
      for (const next of info.fileTargets) pending.push({ path: next, symbol: null })
      for (const edge of info.symbols.values()) pending.push({ path: edge.target, symbol: edge.symbol })
      for (const next of info.exportAll) pending.push({ path: next, symbol: '*' })
      for (const edge of info.dynamicSymbols) pending.push({ path: edge.target, symbol: edge.symbol })
      continue
    }
    const direct = info.symbols.get(current.symbol)
    if (direct) pending.push({ path: direct.target, symbol: direct.symbol })
    for (const next of info.exportAll) pending.push({ path: next, symbol: current.symbol })
    if (info.exports.has(current.symbol)) {
      for (const dependency of info.exportDependencies.get(current.symbol) ?? []) {
        const edge = info.symbols.get(dependency)
        if (edge) pending.push({ path: edge.target, symbol: edge.symbol })
      }
    }
  }
  return false
}

/**
 * For each tab in the explorer's `SURFACES`, the exports its handle loads.
 *
 * A surface row is anchored to one export (`surfaces.tsx#RailSurface`), and
 * the anchor is only worth something if the tab for that row is the thing
 * that loads it: two handles swapped between two tabs would leave every
 * anchor reachable and every tab showing the wrong screen. So each entry's
 * `render` is followed to the `const` that holds its `lazy(...)`, and the
 * exports that handle's `import(...).then(...)` takes are read the same way
 * the graph reads them.
 */
export const surfaceLoads = (source, filePath, paths) => {
  const ast = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const handles = new Map()
  const renders = new Map()
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const name = declaration.name.text
      let init = declaration.initializer
      if (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init)) init = init.expression
      if (name === 'SURFACES' && ts.isArrayLiteralExpression(init)) {
        for (const element of init.elements) {
          if (!ts.isObjectLiteralExpression(element)) continue
          const field = (key) => element.properties.find(
            (property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === key,
          )?.initializer
          const id = field('id')
          const render = field('render')
          if (id && ts.isStringLiteral(id) && render && ts.isIdentifier(render)) renders.set(id.text, render.text)
        }
        continue
      }
      const loads = []
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length > 0 &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const target = resolveSpecifier(filePath, node.arguments[0].text, paths)
          for (const symbol of (target && exportsTaken(node)) || []) loads.push({ target, symbol })
        }
        ts.forEachChild(node, visit)
      }
      visit(declaration.initializer)
      if (loads.length > 0) handles.set(name, loads)
    }
  }
  return new Map([...renders].map(([id, render]) => [id, handles.get(render) ?? []]))
}

export const catalogIntegrity = ({ entries, existingPaths, exampleIds, requiredSurfaces, reachablePairs = null, reachableExamplePairs = null, contracts = new Map(), exampleCoverage = new Map(), surfaceLoadsByView = null }) => {
  const productEntries = entries.filter((entry) => entry.category === 'Product Surfaces')
  const requiredSurfaceIds = requiredSurfaces.map((surface) => surface.id)
  const hasCompleteCoverage = (entry) => {
    const coverage = exampleCoverage.get(entry.implementationPath)
    return coverage && Array.isArray(coverage.variants) && Array.isArray(coverage.sizes) && Array.isArray(coverage.states)
  }
  const exemptionIsEntrySpecific = (entry) => {
    if (typeof entry.coverageExemption !== 'string' || entry.coverageExemption.trim().length < 40) return false
    const reason = entry.coverageExemption.toLowerCase()
    const basename = path.posix.basename(entry.implementationPath).replace(/\.[^.]+$/, '').toLowerCase()
    return [entry.id, entry.exampleId, basename].some((needle) => needle && reason.includes(needle.toLowerCase()))
  }
  return {
    danglingPaths: entries.filter((entry) => !existingPaths.has(entry.implementationPath)).map((entry) => entry.id),
    danglingExamples: entries.filter((entry) => !exampleIds.has(entry.exampleId)).map((entry) => entry.id),
    missingConsumers: entries.filter((entry) => !entry.catalogOnly && (!Array.isArray(entry.consumers) || entry.consumers.length === 0)).map((entry) => entry.id),
    missingExamples: entries.filter((entry) => !Array.isArray(entry.examples) || entry.examples.length === 0).map((entry) => entry.id),
    missingVariants: entries.filter((entry) => !Array.isArray(entry.variants) || entry.variants.length === 0).map((entry) => entry.id),
    missingSizes: entries.filter((entry) => !Array.isArray(entry.sizes) || entry.sizes.length === 0).map((entry) => entry.id),
    missingStates: entries.filter((entry) => !Array.isArray(entry.states) || entry.states.length === 0).map((entry) => entry.id),
    missingExampleCoverage: entries.filter((entry) => entry.visual && !hasCompleteCoverage(entry) && !(typeof entry.coverageExemption === 'string' && entry.coverageExemption.trim().length > 0)).map((entry) => entry.id),
    invalidCoverageExemptions: entries.filter((entry) => {
      if (typeof entry.coverageExemption !== 'string' || entry.coverageExemption.trim().length === 0) return false
      const contract = contracts.get(entry.implementationPath)
      return (contract && Object.keys(contract).length > 0) || !exemptionIsEntrySpecific(entry)
    }).map((entry) => entry.id),
    uncoveredCvaAxes: entries.flatMap((entry) => {
      if (!entry.visual) return []
      const contract = contracts.get(entry.implementationPath)
      if (!contract) return []
      const coverage = exampleCoverage.get(entry.implementationPath)
      return Object.entries(contract)
        .filter(([axis, values]) => coverage?.axes?.[axis]?.join('\0') !== values.join('\0'))
        .map(([axis]) => `${entry.id}:${axis}`)
    }),
    unrenderedCvaAxes: entries.flatMap((entry) => {
      if (!entry.visual) return []
      const contract = contracts.get(entry.implementationPath)
      if (!contract) return []
      const coverage = exampleCoverage.get(entry.implementationPath)
      return Object.entries(contract)
        .filter(([axis, values]) => coverage?.renderedAxes?.[axis]?.join('\0') !== values.join('\0'))
        .map(([axis]) => `${entry.id}:${axis}`)
    }),
    danglingConsumers: entries.flatMap((entry) => entry.consumers.filter((consumer) => !existingPaths.has(consumer)).map(() => entry.id)),
    danglingExamplePaths: entries.flatMap((entry) => (entry.examples ?? []).filter((example) => !existingPaths.has(example.split('#')[0])).map(() => entry.id)),
    /* An example anchored to an export must be the export the row's tab loads. */
    unloadedAnchors: surfaceLoadsByView === null
      ? []
      : entries.filter((entry) => (entry.examples ?? []).some((example) => {
        const [path, symbol] = example.split('#')
        if (symbol === undefined) return false
        return !(surfaceLoadsByView.get(entry.exampleId) ?? []).some((load) => load.target === path && load.symbol === symbol)
      })).map((entry) => entry.id),
    unreachableConsumers: reachablePairs === null
      ? []
      : entries.flatMap((entry) => entry.consumers
        .filter((consumer) => !reachablePairs.has(`${consumer}\0${entry.implementationPath}`))
        .map(() => entry.id)),
    unreachableExamples: reachableExamplePairs === null
      ? []
      : entries.flatMap((entry) => (entry.examples ?? [])
        .filter((example) => !reachableExamplePairs.has(`${example}\0${entry.implementationPath}`))
        .map(() => entry.id)),
    mismatchedVariants: entries.filter((entry) => {
      const contract = contracts.get(entry.implementationPath)
      return contract?.variant && contract.variant.join('\0') !== entry.variants.join('\0')
    }).map((entry) => entry.id),
    mismatchedSizes: entries.filter((entry) => {
      const contract = contracts.get(entry.implementationPath)
      return contract?.size && contract.size.join('\0') !== entry.sizes.join('\0')
    }).map((entry) => entry.id),
    uncoveredExampleVariants: entries.filter((entry) => {
      const coverage = exampleCoverage.get(entry.implementationPath)
      return coverage?.variants && coverage.variants.join('\0') !== entry.variants.join('\0')
    }).map((entry) => entry.id),
    uncoveredExampleSizes: entries.filter((entry) => {
      const coverage = exampleCoverage.get(entry.implementationPath)
      return coverage?.sizes && coverage.sizes.join('\0') !== entry.sizes.join('\0')
    }).map((entry) => entry.id),
    uncoveredExampleStates: entries.filter((entry) => {
      const coverage = exampleCoverage.get(entry.implementationPath)
      return coverage?.states && coverage.states.join('\0') !== entry.states.join('\0')
    }).map((entry) => entry.id),
    missingSurfaces: requiredSurfaceIds.filter((id) => !productEntries.some((entry) => entry.id === id)),
    staleSurfaces: productEntries.filter((entry) => !requiredSurfaceIds.includes(entry.id)).map((entry) => entry.id),
    mismatchedSurfacePaths: requiredSurfaces
      .filter((surface) => productEntries.find((entry) => entry.id === surface.id)?.implementationPath !== surface.implementationPath)
      .map((surface) => surface.id),
  }
}

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

/** Public module coverage must not depend on the spelling of its re-export. */
export const exportedModules = (source) => {
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  return [...new Set(ast.statements.flatMap(statement =>
    ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.startsWith('./')
      ? [statement.moduleSpecifier.text.slice(2)] : [],
  ))]
}

if (isMain) {
  const existingPathList = repositoryFiles(root)
  const uiIndex = fs.readFileSync(path.join(root, 'packages/ui/src/design/ui/index.ts'), 'utf8')
  const uiModules = exportedModules(uiIndex)
  const patternModules = existingPathList
    .filter((file) => file.startsWith('packages/ui/src/design/patterns/') && /\.tsx?$/.test(file))
    .filter((file) => file && !/\.(?:test|spec)\.tsx?$/.test(file))
    .map((file) => path.basename(file).replace(/\.tsx?$/, ''))
  const manifest = fs.readFileSync(path.join(root, 'packages/ui/src/design/catalog/manifest.ts'), 'utf8')
  const coverage = catalogCoverage({
    uiModules,
    patternModules,
    registeredUi: seedNames(manifest, 'CANONICAL_UI_MODULES'),
    registeredPatterns: seedNames(manifest, 'CANONICAL_PATTERN_MODULES'),
  })
  const transpiled = ts.transpileModule(manifest, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
  const explorer = fs.readFileSync(path.join(root, 'packages/ui/src/design/explorer/Explorer.tsx'), 'utf8')
  const boards = fs.readFileSync(path.join(root, 'packages/ui/src/design/explorer/boards.tsx'), 'utf8')
  const compositions = fs.readFileSync(path.join(root, 'packages/ui/src/design/explorer/boards-compositions.tsx'), 'utf8')
  const exampleIds = new Set([
    'foundation',
    'coverage',
    ...declarationIds(explorer, 'SURFACES'),
    ...declarationIds(boards, 'BOARDS'),
    ...declarationIds(compositions, 'COMPOSITION_BOARDS'),
  ])
  const sourceFiles = existingPathList
    .filter((file) => /\.(?:[cm]?[jt]sx?|css)$/.test(file))
    .map((file) => ({ path: file, source: fs.readFileSync(path.join(root, file), 'utf8') }))
  const graph = importGraph(sourceFiles)
  const contracts = new Map(sourceFiles
    .map((file) => [file.path, cvaContract(file.source)])
    .filter(([, contract]) => contract))
  const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file.source]))
  const exampleCoverage = new Map(loaded.CATALOG_ENTRIES.flatMap((entry) => {
    const prefix = path.posix.basename(entry.implementationPath).replace(/\.[^.]+$/, '').replace(/-/g, '_').toUpperCase()
    const source = (entry.examples ?? []).map((example) => sourceByPath.get(example.split('#')[0]) ?? '').join('\n')
    const contract = contracts.get(entry.implementationPath) ?? {}
    const declarationForAxis = (axis) => axis === 'variant'
      ? `${prefix}_CATALOG_VARIANTS`
      : axis === 'size'
        ? `${prefix}_CATALOG_SIZES`
        : `${prefix}_CATALOG_${axis.replace(/-/g, '_').toUpperCase()}`
    return [[entry.implementationPath, {
      variants: declarationStrings(source, `${prefix}_CATALOG_VARIANTS`),
      sizes: declarationStrings(source, `${prefix}_CATALOG_SIZES`),
      states: declarationStrings(source, `${prefix}_CATALOG_STATES`),
      axes: Object.fromEntries(Object.keys(contract).map((axis) => [axis, declarationStrings(source, declarationForAxis(axis))])),
      renderedAxes: Object.fromEntries(Object.keys(contract).map((axis) => {
        const declaration = declarationForAxis(axis)
        return [axis, renderedDeclarationStrings(source, declaration, axis)]
      })),
    }]]
  }))
  const reachablePairs = new Set(loaded.CATALOG_ENTRIES.flatMap((entry) => entry.consumers
    .filter((consumer) => isReachable(graph, consumer, entry.implementationPath))
    .map((consumer) => `${consumer}\0${entry.implementationPath}`)))
  const reachableExamplePairs = new Set(loaded.CATALOG_ENTRIES.flatMap((entry) => (entry.examples ?? [])
    .filter((example) => isReachable(graph, example, entry.implementationPath))
    .map((example) => `${example}\0${entry.implementationPath}`)))
  if (process.env.HD_CATALOG_CONSUMERS === '1') {
    for (const entry of loaded.CATALOG_ENTRIES.filter((candidate) => candidate.category === 'Primitives')) {
      const candidates = sourceFiles
        .filter((file) => /packages\/ui\/src\/(?:app|components|panels|slots)\//.test(file.path))
        .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file.path))
        .filter((file) => isReachable(graph, file.path, entry.implementationPath))
        .map((file) => file.path)
        .slice(0, 5)
      console.log(`${entry.id}: ${candidates.join(', ') || '(catalog only)'}`)
    }
    process.exit(0)
  }
  const integrity = catalogIntegrity({
    entries: loaded.CATALOG_ENTRIES,
    existingPaths: new Set(existingPathList),
    exampleIds,
    requiredSurfaces: JSON.parse(fs.readFileSync(path.join(root, 'script/ui-catalog-surfaces.json'), 'utf8')).surfaces,
    reachablePairs,
    reachableExamplePairs,
    contracts,
    exampleCoverage,
    surfaceLoadsByView: surfaceLoads(
      explorer,
      'packages/ui/src/design/explorer/Explorer.tsx',
      new Set(existingPathList),
    ),
  })
  const findings = [...Object.entries(coverage), ...Object.entries(integrity)]
    .flatMap(([kind, names]) => names.map((name) => `${kind}: ${name}`))
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding)
    for (const id of new Set(integrity.unreachableConsumers)) {
      const entry = loaded.CATALOG_ENTRIES.find((candidate) => candidate.id === id)
      if (!entry) continue
      const candidates = sourceFiles
        .filter((file) => !file.path.includes('/design/ui/') && isReachable(graph, file.path, entry.implementationPath))
        .map((file) => file.path)
        .slice(0, 8)
      if (candidates.length > 0) console.error(`  reachable ${id}: ${candidates.join(', ')}`)
    }
    process.exit(1)
  }
  console.log(`Catalog covers ${uiModules.length} canonical UI modules and ${patternModules.length} pattern modules.`)
}
