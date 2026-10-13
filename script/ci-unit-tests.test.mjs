import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { walk } from './ci-imports.mjs'
import { outsideReads, setupFiles, treeReaders, unitPlan } from './ci-unit-tests.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const plan = (paths, event = 'pull_request') => unitPlan(root, { event, paths })

test('a change to a component runs the tests that depend on it, and the ones that read the tree', () => {
  const run = plan(['packages/ui/src/components/BringHome.tsx'])
  assert.equal(run.mode, 'related')
  assert.ok(run.files.includes('src/components/BringHome.tsx'))
  for (const reader of treeReaders(root)) assert.ok(run.files.includes(reader), reader)
  assert.ok(run.files.every(file => file.startsWith('src/') || file.startsWith('site-demo/')), 'paths are relative to packages/ui, where vitest runs')
})

test('the tests that read the tree themselves are the ones that glob or use the file system', () => {
  const readers = treeReaders(root)
  assert.ok(readers.includes('src/app/settings-routes.test.ts'))
  assert.ok(readers.includes('src/design/faces.census.test.ts'), 'a pattern over the source')
  assert.ok(!readers.includes('src/lib/avatars.test.ts'), 'the images of assets/ already run everything')
  assert.ok(readers.every(file => file.endsWith('.test.ts') || file.endsWith('.test.tsx')))
})

test('main, a manual run and an unknown change list run every test', () => {
  for (const event of ['push', 'workflow_dispatch']) assert.equal(plan(['packages/ui/src/components/BringHome.tsx'], event).mode, 'all', event)
  for (const paths of [null, [], [''], ['/etc/passwd'], ['packages/ui/../server/x.ts'], ['packages/ui/src/a b.ts'], ['packages/ui/src/$(x).ts']]) assert.equal(plan(paths).mode, 'all', JSON.stringify(paths))
})

test('a change the unit tests may read from outside the UI source runs every test', () => {
  for (const path of [
    'package.json', 'pnpm-lock.yaml', 'packages/protocol/src/wire.ts', 'packages/server/flows/review.yml', 'assets/avatars/128/blue.png',
    'e2e/fixtures/client-views-stream.json', 'packages/ui/package.json', 'packages/ui/vitest.config.ts', 'packages/ui/vite.config.ts', '.github/workflows/ci.yml',
    'packages/ui/src/setup-tests.ts', 'packages/ui/vitest.node-tests.ts',
  ]) assert.equal(plan(['packages/ui/src/components/BringHome.tsx', path]).mode, 'all', path)
})

test('a deleted source file runs every test', () => {
  const run = plan(['packages/ui/src/components/Gone.tsx'])
  assert.equal(run.mode, 'all')
  assert.match(run.summary, /Gone\.tsx was deleted/)
})

test('a change only to documents or to the browser suite opens no unit test', () => {
  for (const paths of [['docs/architecture.md'], ['README.md'], ['e2e/ui-system/rules.spec.ts'], ['docs/design.md', 'e2e/ui-system/durations.json']]) {
    assert.deepEqual([plan(paths).mode, plan(paths).files], ['none', []], paths.join(' '))
  }
})

test('a very large change runs every test', () => {
  const tree = walk(join(root, 'packages/ui/src')).map(file => relative(root, file)).filter(file => /\.tsx?$/.test(file) && !/setup-tests/.test(file))
  assert.ok(tree.length > 400)
  assert.equal(plan(tree.slice(0, 300)).mode, 'related')
  assert.equal(plan(tree.slice(0, 301)).mode, 'all')
})

test('the command line reads a list of paths separated by NUL and prints the plan', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-unit-'))
  try {
    const list = join(directory, 'paths')
    writeFileSync(list, 'packages/ui/src/components/BringHome.tsx\0')
    const run = (file, event = 'pull_request') => spawnSync(process.execPath, [fileURLToPath(new URL('./ci-unit-tests.mjs', import.meta.url)), file], { encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event } })
    const output = Object.fromEntries(run(list).stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
    assert.equal(output.mode, 'related')
    assert.match(output.files, /^src\/.* src\/.*|src\/components\/BringHome\.tsx/)
    assert.equal(Object.fromEntries(run(join(directory, 'missing')).stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2))).mode, 'all')
    assert.equal(Object.fromEntries(run(list, 'push').stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2))).mode, 'all')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a file imported with a query reaches its importers, which Vitest does not follow', () => {
  // `Approvals.css.test.ts` reads `ApprovalDialog.module.css?raw`, and `BrandIcons.tsx` reads `mark.svg?raw`.
  const sheet = plan(['packages/ui/src/design/patterns/ApprovalDialog.module.css'])
  assert.equal(sheet.mode, 'related')
  assert.ok(sheet.files.includes('src/components/Approvals.css.test.ts'), sheet.files.join(' '))
  const mark = plan(['packages/ui/src/assets/brand/mark.svg'])
  assert.ok(mark.files.includes('src/components/BrandIcons.tsx'), 'the module is asked about, and Vitest finds the tests that depend on it')
  // The review's own example: a colour taken out of the editor's stylesheet is checked by a test that reads it with `?raw`.
  const editor = plan(['packages/ui/src/styles/editor.css'])
  assert.ok(editor.files.some(file => /editor-tokens\.test\.ts$/.test(file)), editor.files.join(' '))
})

test('a test that reads the tree through a helper is a reader, and so is one that imports the setup\'s helpers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-readers-'))
  try {
    const put = (path, text) => {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    put('packages/ui/package.json', JSON.stringify({ name: '@harnessdesk/ui' }))
    put('packages/ui/src/sheet.test.ts', "import { readSheet } from './test-support/read-sheet'\nreadSheet()\n")
    put('packages/ui/src/test-support/read-sheet.ts', "import { readFileSync } from 'node:fs'\nexport const readSheet = () => readFileSync('x.css', 'utf8')\n")
    put('packages/ui/src/plain.test.ts', "import { x } from './plain'\nx()\n")
    put('packages/ui/src/plain.ts', 'export const x = () => 1\n')
    put('packages/ui/src/setup-tests.ts', "import './test-support/pointer'\n")
    put('packages/ui/src/test-support/pointer.ts', 'export {}\n')
    assert.deepEqual(treeReaders(dir), ['src/sheet.test.ts'])
    assert.deepEqual([...setupFiles(dir)].sort(), ['packages/ui/src/setup-tests.ts', 'packages/ui/src/test-support/pointer.ts'])
    // Vitest does not follow the setup's imports: an edit to one of them is an edit to every test.
    assert.equal(unitPlan(dir, { event: 'pull_request', paths: ['packages/ui/src/test-support/pointer.ts'] }).mode, 'all')
    assert.equal(unitPlan(dir, { event: 'pull_request', paths: ['packages/ui/src/plain.ts'] }).mode, 'related')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a package the UI is not built from is nothing to its unit tests, unless a file of the UI reads it', () => {
  assert.ok(outsideReads(root).includes('packages/server/flows'), 'two tests read the shipped flows by a pattern')
  // `server` is not a dependency of the UI: its source is, to the UI's tests, nothing.
  assert.equal(plan(['packages/server/src/host.ts']).mode, 'none')
  assert.equal(plan(['packages/server/src/host.ts', 'packages/ui/src/components/BringHome.tsx']).mode, 'related')
  assert.equal(plan(['packages/server/flows/review.yml']).mode, 'all', 'read by a pattern')
  assert.equal(plan(['packages/protocol/src/wire.ts']).mode, 'all', 'the UI is built from it')
  assert.equal(plan(['packages/adapter-codex/src/index.ts']).mode, 'none')
})
