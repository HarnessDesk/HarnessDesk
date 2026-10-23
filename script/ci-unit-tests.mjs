#!/usr/bin/env node
// Which of the UI's unit tests does a pull request need? `vitest related` answers
// for a change to the UI's own source: it runs the tests whose modules depend on
// the files that changed. Anything that cannot be followed that way (a change
// outside the UI's source, a deleted file, the test setup) runs every test, and so
// does `main`, and so does a change that reaches more than a third of them: that
// many run one after another outlast the four shards of the whole suite.
//
//   node script/ci-unit-tests.mjs <changed paths, NUL separated>
//   → mode=all | related | none, files=<paths relative to packages/ui>, summary=…
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IMPORT, SOURCE, uiPackages, walk } from './ci-imports.mjs'
import { testFiles } from './ci-unit-shards.mjs'
import { queriedImporters, uiImporters, uiSource } from './ui-impact.mjs'

const UI = 'packages/ui/'
const TRACKED = /^packages\/ui\/(?:src|site-demo)\//
// Nothing here is read by a unit test of the UI.
const IGNORED = [/^docs\//, /^[^/]+\.md$/, /^e2e\/ui-system\//]
// Tests of the UI that are not run again by every change they depend on.
const SETUP = /(?:^|\/)(?:setup-tests\.[cm]?[jt]s|vitest[^/]*\.[cm]?[jt]s)$/
const TEST = /\.test\.[cm]?[jt]sx?$/
const MOST = 300
// A related run may reach at most one test file in this many of the suite. One serial run takes about 2 s a file
// on a runner (PR #1842 got through 448 files before the job's 15 minutes ran out), so a third of the suite is
// about 8 minutes of tests, well inside the 15; past it the four shards of the full deal finish first.
const RELATED_ONE_IN = 3

// Include literal template dynamic imports as well as the ordinary import forms.
const imports = text => [...text.matchAll(IMPORT)].map(([, specifier]) => specifier)
  .concat([...text.matchAll(/\bimport\s*\(\s*`([^`$\n]+)`\s*\)/g)].map(([, specifier]) => specifier))
const sourceAt = base => [base, ...SOURCE.map(ext => `${base}${ext}`), ...SOURCE.map(ext => join(base, `index${ext}`))]
  .find(candidate => {
    try { return existsSync(candidate) && statSync(candidate).isFile() } catch { return false }
  })

// The file system, or a pattern over files that are not the images of `assets/` (which every change to them
// already runs the whole suite for).
const readsTree = text => /\bfrom\s+['"](?:node:)?fs(?:\/promises)?['"]/.test(text)
  || [...text.matchAll(/import\.meta\.glob\s*[<(]([\s\S]{0,240})/g)].some(([, pattern]) => !/assets\//.test(pattern) || /(?:components|panels|src)\//.test(pattern))

const STRING = /'((?:\\.|[^'\\\r\n])*)'|"((?:\\.|[^"\\\r\n])*)"|`((?:\\.|[^`\\])*)`/g
const literals = text => [...text.matchAll(STRING)]
  .map(([, single, double, template]) => single ?? double ?? template)
// Config strings can define aliases without reading the filesystem themselves.
// Consume comments as separate tokens so their prose cannot define an alias.
const CONFIG_STRING = new RegExp(`//[^\\r\\n]*|/\\*[^]*?\\*/|${STRING.source}`, 'g')
const configNamesScriptDirectory = text => [...text.matchAll(CONFIG_STRING)]
  .some(([, single, double, template]) => /\bscript\/|(?:^|\/)script$/.test(single ?? double ?? template ?? ''))

// These scans deliberately include comments, fixtures and displayed examples.
// A stray mention costs a suite; missing a possible read costs coverage.
const staticImports = text => [...text.matchAll(/\b(?:from\s*|import\s*)['"]([^'"\n]+)['"]/g)].map(([, specifier]) => specifier)
const fsOrProcessReader = (text, specifiers = imports(text)) => specifiers.some(path => /^(?:(?:node:)?(?:fs(?:\/promises)?|child_process)|execa|cross-spawn)$/.test(path))
  || /\bimport\.meta\.glob\s*(?:<[^>]*>)?\(/.test(text)
const scriptGlobs = text => [...text.matchAll(/\bimport\.meta\.glob\s*(?:<[^>]*>)?\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/g)]
  .flatMap(([, argument]) => literals(argument)).filter(path => !path.includes('${'))
const scriptPath = path => path === 'script' || path.startsWith('script/')
const inRepository = path => path !== '..' && !path.startsWith('../')
const relativeTargets = (root, file, specifiers, inside = inRepository) => specifiers.filter(specifier => specifier.startsWith('.'))
  .map(specifier => resolve(dirname(file), specifier.replace(/[?#].*$/, '')))
  .filter(base => inside(relative(root, base))).map(sourceAt).filter(Boolean)

// D: a quoted word or path segment plus filesystem/process access can build any
// sibling's path. The manifest's "scripts" key is neither of those mentions.
const namesScriptDirectory = text => /\bscript\/|(['"`])script\1|\/script['"`]/.test(text)
export const readsScriptDirectory = text => fsOrProcessReader(text) && namesScriptDirectory(text)

const outsideReadFiles = root => {
  const ui = join(root, 'packages/ui')
  const sources = ['src', 'site-demo'].flatMap(prefix => existsSync(join(ui, prefix)) ? walk(join(ui, prefix)) : [])
  const configs = existsSync(ui) ? readdirSync(ui).filter(name => /^(?:vitest.*\.ts|vite\.config\.ts|package\.json|tsconfig.*\.json)$/.test(name))
    .map(name => join(ui, name)) : []
  const reached = new Set()
  const queue = [...configs]
  while (queue.length) {
    const file = queue.pop()
    if (reached.has(file)) continue
    reached.add(file)
    queue.push(...relativeTargets(root, file, imports(readFileSync(file, 'utf8'))))
  }
  return { files: new Set([...sources, ...reached]), uiFiles: new Set([...sources, ...configs]), configFiles: reached }
}

// What a file of the UI imports from its source or from scripts, to the end of the chain.
const closure = (root, start, edges = new Map()) => {
  const seen = new Set()
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(join(root, file))) continue
    seen.add(file)
    if (!edges.has(file)) {
      const from = join(root, file)
      const text = readFileSync(from, 'utf8')
      const found = []
      for (const specifier of imports(text)) {
        const clean = specifier.replace(/[?#].*$/, '')
        const base = clean.startsWith('@/') ? join(root, 'packages/ui/src', clean.slice(2)) : clean.startsWith('.') ? resolve(dirname(from), clean) : null
        const target = base && sourceAt(base)
        if (!target) continue
        const path = relative(root, target)
        if (path.startsWith('script/') || uiSource(path)) found.push(path)
      }
      edges.set(file, found)
    }
    queue.push(...edges.get(file))
  }
  return seen
}

// The tests that read the tree by themselves, from the file system or by a pattern, in their own text or in
// a helper's: a new or deleted file changes what they see without being a dependency of anything, so they run
// with every selection.
export function treeReaders(root) {
  const source = join(root, 'packages/ui/src')
  if (!existsSync(source)) return []
  const edges = new Map()
  const reads = new Map()
  const reading = file => {
    if (!reads.has(file)) reads.set(file, readsTree(readFileSync(join(root, file), 'utf8')))
    return reads.get(file)
  }
  return walk(source).map(file => relative(root, file)).filter(file => TEST.test(file) && SOURCE.includes(extname(file)))
    .filter(file => [...closure(root, file, edges)].some(reading)).map(file => relative(join(root, UI), join(root, file))).sort()
}

// Every file the test setup imports, to the end of the chain: Vitest does not follow these edges, and a test
// may lean on any of them without importing it.
export function setupFiles(root) {
  const found = new Set()
  for (const entry of ['packages/ui/src/setup-tests.ts']) {
    if (existsSync(join(root, entry))) for (const file of closure(root, entry)) found.add(file)
  }
  return found
}

// What the UI's files read from outside the UI package, by an import or a pattern: the folders and files a change
// to which can change a test (`packages/server/flows/*.yml` is read by two). Keyed by what a changed path starts
// with.
export function outsideReads(root) {
  const reads = new Set()
  // The flag follows the seed's static closure: imports (B) may execute a
  // reader; a name in ordinary UI text (A) only reads the named closure.
  const scripts = new Map()
  const queue = []
  const addScript = (base, reader) => {
    const path = relative(root, base)
    if (!scriptPath(path)) return
    let files
    try {
      const stat = statSync(base)
      if (stat.isFile()) files = [base]
      else if (stat.isDirectory()) files = walk(base)
    } catch { /* Missing paths and constructed fragments are not named reads. */ }
    if (!files?.length) return
    reads.add(path === 'script' ? 'script/' : path)
    for (const file of files.filter(file => SOURCE.includes(extname(file)))) {
      const target = relative(root, file)
      if (!scripts.has(target) || (reader && !scripts.get(target))) {
        scripts.set(target, reader)
        queue.push([target, reader])
      }
    }
  }
  const { files, uiFiles, configFiles } = outsideReadFiles(root)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const specifiers = imports(text)
    const reader = fsOrProcessReader(text, specifiers)
    // A: names anywhere in the text, resolved against real files/directories.
    for (const [path] of text.matchAll(/\bscript\/[\w./@+-]*[\w/@+-]/g)) addScript(join(root, path), reader)
    // D: no path has to resolve when a reader can construct it.
    if (reader && namesScriptDirectory(text)) reads.add('script/')
    if (configFiles.has(file) && configNamesScriptDirectory(text)) reads.add('script/')
    // B: relative imports and globs can name scripts without a script/ string.
    for (const target of relativeTargets(root, file, specifiers, scriptPath)) addScript(target, true)
    for (const pattern of scriptGlobs(text)) {
      if (pattern.startsWith('.')) addScript(resolve(dirname(file), pattern.split(/[*{[]/)[0]), true)
    }
    // Keep the existing non-script read rules, including their source boundary.
    if (!uiFiles.has(file) || !SOURCE.includes(extname(file))) continue
    const outside = target => {
      const path = relative(root, target)
      return path.startsWith('..') || path.startsWith('packages/ui/') || scriptPath(path) ? null : path
    }
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue
      const path = outside(resolve(dirname(file), specifier.replace(/[?#].*$/, '')))
      if (path) {
        reads.add(path)
        const target = sourceAt(join(root, path))
        if (target) reads.add(relative(root, target))
      }
    }
    for (const [, pattern] of text.matchAll(/import\.meta\.glob\s*(?:<[^>]*>)?\(\s*\[?\s*['"]([^'"]+)['"]/g)) {
      if (!pattern.startsWith('.')) continue
      const path = outside(resolve(dirname(file), pattern.split(/[*{[]/)[0]))
      if (path) reads.add(path)
    }
  }
  // Static imports/re-exports only: no chasing a script's command strings,
  // URL literals or individual read calls. Cycles and stronger seeds terminate.
  while (queue.length) {
    const [path, reader] = queue.pop()
    const file = join(root, path)
    const text = readFileSync(file, 'utf8')
    reads.add(path)
    // C applies to B's closure and reader seeds, but not to A-only names in
    // ordinary UI text. Gate names in comments must not read every script.
    if (reader && fsOrProcessReader(text)) reads.add('script/')
    for (const target of relativeTargets(root, file, staticImports(text), scriptPath)) addScript(target, reader)
  }
  return [...reads].sort()
}

// The files that import one of `start`, and the files that import those, to the end of the chain: the modules a
// change reaches, which is what `vitest related` follows at run time (it is not installed yet when this runs).
const dependents = (root, start) => {
  const importers = uiImporters(root)
  const seen = new Set(start)
  const queue = [...seen]
  while (queue.length > 0) {
    for (const importer of importers.get(queue.pop()) ?? []) {
      if (!seen.has(importer)) {
        seen.add(importer)
        queue.push(importer)
      }
    }
  }
  return seen
}

export function unitPlan(root, { event, paths }) {
  const all = reason => ({ mode: 'all', files: [], summary: `UI unit tests: all, ${reason}.` })
  if (event !== 'pull_request') return all('this is not a pull request')
  // The paths go to a command line: one that cannot be quoted plainly is not worth the risk.
  if (!paths || paths.length === 0 || paths.some(path => path.length === 0 || path.startsWith('/') || path.split('/').includes('..') || /[^\w./@+-]/.test(path))) return all('the changed files are unknown')
  const setup = setupFiles(root)
  const reads = outsideReads(root)
  // Another package that the UI is not built from, and that no file of the UI reads, is nothing to a unit test of it:
  // its own tests (the Node jobs) say what it does.
  const uiPackagesOf = uiPackages(root)
  const isRead = path => reads.some(read => path === read || path.startsWith(`${read.replace(/\/?$/, '/')}`))
  const unrelatedPackage = path => /^packages\/[^/]+\//.test(path) && !uiPackagesOf.has(path.split('/')[1]) && !isRead(path)
  const files = []
  for (const path of paths) {
    if (path.startsWith('script/') && !existsSync(join(root, path))) return all(`${path} was deleted`)
    if (setup.has(path)) return all(`${path} is part of the test setup`)
    // The shared design facade belongs to the full suite's balanced deal.
    if (path === 'packages/ui/src/design/index.ts') return all(`${path} is the shared design entrypoint`)
    const unrelatedScript = path.startsWith('script/') && !isRead(path) && !SETUP.test(path)
    if (IGNORED.some(pattern => pattern.test(path)) || unrelatedPackage(path) || unrelatedScript) continue
    if (!TRACKED.test(path)) return all(`${path} is read outside the UI's own source`)
    if (SETUP.test(path)) return all(`${path} sets up every test`)
    if (!existsSync(join(root, path))) return all(`${path} was deleted`)
    files.push(path.slice(UI.length))
  }
  if (files.length === 0) return { mode: 'none', files: [], summary: 'UI unit tests: none, the change is not read by one.' }
  if (files.length > MOST) return all(`${files.length} files changed`)
  const readers = treeReaders(root)
  // A file imported with a query reaches its importers, which Vitest does not follow itself.
  const queried = queriedImporters(root)
  const reached = new Set(files.map(file => `packages/ui/${file}`))
  for (const path of reached) {
    for (const importer of queried.get(path) ?? []) reached.add(importer)
  }
  const run = [...new Set([...[...reached].map(path => path.slice(UI.length)), ...readers])].sort()
  // What the one serial run will hold: the tests that depend on the change, and the readers.
  const suite = existsSync(join(root, UI, 'src')) ? testFiles(root) : []
  const depending = dependents(root, reached)
  const selected = suite.filter(file => readers.includes(file) || depending.has(`${UI}${file}`))
  if (selected.length > Math.floor(suite.length / RELATED_ONE_IN)) return all(`${selected.length} of ${suite.length} test files depend on the change`)
  return { mode: 'related', files: run, summary: `UI unit tests: those that depend on ${files.length} changed file${files.length === 1 ? '' : 's'}, and ${readers.length} that read the tree.` }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  let paths = null
  try {
    const raw = readFileSync(process.argv[2], 'utf8')
    paths = raw.endsWith('\0') ? raw.slice(0, -1).split('\0') : null
  } catch {
    // No readable list: every test.
  }
  const plan = unitPlan(root, { event: process.env.GITHUB_EVENT_NAME, paths })
  process.stdout.write(`mode=${plan.mode}\nfiles=${plan.files.join(' ')}\nsummary=${plan.summary}\n`)
}
