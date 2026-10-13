#!/usr/bin/env node
// Which of the UI's unit tests does a pull request need? `vitest related` answers
// for a change to the UI's own source: it runs the tests whose modules depend on
// the files that changed. Anything that cannot be followed that way (a change
// outside the UI's source, a deleted file, the test setup) runs every test, and so
// does `main`.
//
//   node script/ci-unit-tests.mjs <changed paths, NUL separated>
//   → mode=all | related | none, files=<paths relative to packages/ui>, summary=…
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IMPORT, SOURCE, uiPackages, walk } from './ci-imports.mjs'
import { queriedImporters, uiSource } from './ui-impact.mjs'

const UI = 'packages/ui/'
const TRACKED = /^packages\/ui\/(?:src|site-demo)\//
// Nothing here is read by a unit test of the UI.
const IGNORED = [/^docs\//, /^[^/]+\.md$/, /^e2e\/ui-system\//]
// Tests of the UI that are not run again by every change they depend on.
const SETUP = /(?:^|\/)(?:setup-tests\.[cm]?[jt]s|vitest[^/]*\.[cm]?[jt]s)$/
const TEST = /\.test\.[cm]?[jt]sx?$/
const MOST = 300

// The file system, or a pattern over files that are not the images of `assets/` (which every change to them
// already runs the whole suite for).
const readsTree = text => /\bfrom\s+['"](?:node:)?fs(?:\/promises)?['"]/.test(text)
  || [...text.matchAll(/import\.meta\.glob\s*[<(]([\s\S]{0,240})/g)].some(([, pattern]) => !/assets\//.test(pattern) || /(?:components|panels|src)\//.test(pattern))

// What a file of the UI imports from the UI's own source, to the end of the chain.
const closure = (root, start, edges = new Map()) => {
  const seen = new Set()
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(join(root, file))) continue
    seen.add(file)
    if (!edges.has(file)) {
      const from = join(root, file)
      const found = []
      for (const [, specifier] of readFileSync(from, 'utf8').matchAll(IMPORT)) {
        const clean = specifier.replace(/[?#].*$/, '')
        const base = clean.startsWith('@/') ? join(root, 'packages/ui/src', clean.slice(2)) : clean.startsWith('.') ? resolve(dirname(from), clean) : null
        const target = base && [base, ...SOURCE.map(ext => `${base}${ext}`), ...SOURCE.map(ext => join(base, `index${ext}`))].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
        if (target && uiSource(relative(root, target))) found.push(relative(root, target))
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
  for (const prefix of ['packages/ui/src', 'packages/ui/site-demo']) {
    const directory = join(root, prefix)
    if (!existsSync(directory)) continue
    for (const file of walk(directory)) {
      if (!SOURCE.includes(extname(file))) continue
      const text = readFileSync(file, 'utf8')
      const outside = target => {
        const path = relative(root, target)
        return path.startsWith('..') || path.startsWith('packages/ui/') ? null : path
      }
      for (const [, specifier] of text.matchAll(IMPORT)) {
        if (!specifier.startsWith('.')) continue
        const path = outside(resolve(dirname(file), specifier.replace(/[?#].*$/, '')))
        if (path) reads.add(path)
      }
      for (const [, pattern] of text.matchAll(/import\.meta\.glob\s*(?:<[^>]*>)?\(\s*\[?\s*['"]([^'"]+)['"]/g)) {
        if (!pattern.startsWith('.')) continue
        const path = outside(resolve(dirname(file), pattern.split(/[*{[]/)[0]))
        if (path) reads.add(path)
      }
    }
  }
  return [...reads]
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
  const unrelatedPackage = path => /^packages\/[^/]+\//.test(path) && !uiPackagesOf.has(path.split('/')[1]) && !reads.some(read => path === read || path.startsWith(`${read.replace(/\/?$/, '/')}`))
  const files = []
  for (const path of paths) {
    if (setup.has(path)) return all(`${path} is part of the test setup`)
    if (IGNORED.some(pattern => pattern.test(path)) || unrelatedPackage(path)) continue
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
