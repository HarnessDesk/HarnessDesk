#!/usr/bin/env node
// Which of the UI's unit tests does a pull request need? `vitest related` answers
// for a change to the UI's own source: it runs the tests whose modules depend on
// the files that changed. Anything that cannot be followed that way (a change
// outside the UI's source, a deleted file, the test setup) runs every test, and so
// does `main`.
//
//   node script/ci-unit-tests.mjs <changed paths, NUL separated>
//   → mode=all | related | none, files=<paths relative to packages/ui>, summary=…
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SOURCE, walk } from './ci-imports.mjs'

const UI = 'packages/ui/'
const TRACKED = /^packages\/ui\/(?:src|site-demo)\//
// Nothing here is read by a unit test of the UI.
const IGNORED = [/^docs\//, /^[^/]+\.md$/, /^e2e\/ui-system\//]
// Tests of the UI that are not run again by every change they depend on.
const SETUP = /(?:^|\/)(?:setup-tests\.[cm]?[jt]s|vitest[^/]*\.[cm]?[jt]s)$/
const TEST = /\.test\.[cm]?[jt]sx?$/
const MOST = 300

// The tests that read the tree by themselves, from the file system or by a
// pattern: a new or deleted file changes what they see without being a dependency
// of anything, so they run with every selection.
export function treeReaders(root) {
  const source = join(root, 'packages/ui/src')
  if (!existsSync(source)) return []
  return walk(source).filter(file => TEST.test(file) && SOURCE.includes(extname(file))).filter(file => {
    const text = readFileSync(file, 'utf8')
    return /\bfrom\s+['"](?:node:)?fs(?:\/promises)?['"]|import\.meta\.glob\s*[<(]/.test(text)
  }).map(file => relative(join(root, UI), file)).sort()
}

export function unitPlan(root, { event, paths }) {
  const all = reason => ({ mode: 'all', files: [], summary: `UI unit tests: all, ${reason}.` })
  if (event !== 'pull_request') return all('this is not a pull request')
  // The paths go to a command line: one that cannot be quoted plainly is not worth the risk.
  if (!paths || paths.length === 0 || paths.some(path => path.length === 0 || path.startsWith('/') || path.split('/').includes('..') || /[^\w./@+-]/.test(path))) return all('the changed files are unknown')
  const files = []
  for (const path of paths) {
    if (IGNORED.some(pattern => pattern.test(path))) continue
    if (!TRACKED.test(path)) return all(`${path} is read outside the UI's own source`)
    if (SETUP.test(path)) return all(`${path} sets up every test`)
    if (!existsSync(join(root, path))) return all(`${path} was deleted`)
    files.push(path.slice(UI.length))
  }
  if (files.length === 0) return { mode: 'none', files: [], summary: 'UI unit tests: none, the change is not read by one.' }
  if (files.length > MOST) return all(`${files.length} files changed`)
  const readers = treeReaders(root)
  const run = [...new Set([...files, ...readers])].sort()
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
