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

const fixture = run => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-reads-'))
  try {
    const put = (path, text = '') => {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    put('packages/ui/package.json', JSON.stringify({ name: '@harnessdesk/ui' }))
    put('packages/ui/src/plain.test.ts')
    const mode = path => unitPlan(dir, { event: 'pull_request', paths: [path] }).mode
    run({ dir, put, mode })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a URL passed to a UI helper names a data file without needing a local fs import', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/src/reads.test.ts', "import { read } from './helper'\nread(new URL('../../../script/data.json', import.meta.url))\n")
  put('packages/ui/src/helper.ts', "import { readFileSync } from 'node:fs'\nexport const read = path => readFileSync(path, 'utf8')\n")
  put('script/data.json', '{}')
  put('script/unused.json', '{}')
  assert.deepEqual(outsideReads(dir), ['script/data.json'])
  assert.equal(mode('script/data.json'), 'all')
  assert.equal(mode('script/unused.json'), 'none')
}))

for (const expression of [
  "['script', 'helper.mjs'].join('/')", 'join(root, "script", name)',
  'join(root, `script`, name)', '`/script/${name}`', '`script/${name}`',
  '`\nscript/${name}\n`', '"../../script/"', '"../../script"',
]) {
  test(`a tree reader constructing ${JSON.stringify(expression)} reads the whole script directory`, () => fixture(({ dir, put, mode }) => {
    put('packages/ui/src/reads.test.ts', `import { readFileSync } from 'node:fs'\nreadFileSync(${expression})\n`)
    assert.ok(outsideReads(dir).includes('script/'))
    assert.equal(mode('script/any/nested.mjs'), 'all')
    assert.equal(mode('docs/guide.md'), 'none')
    assert.equal(mode('e2e/ui-system/anything.spec.ts'), 'none')
  }))
}

test('a UI config alias into scripts covers a queried alias import', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/vitest.config.ts', "export default { resolve: { alias: { '@gates': '../../script' } } }\n")
  put('packages/ui/src/plain.test.ts', "import entry from '@gates/entry.mjs?raw'\n")
  put('script/entry.mjs')
  put('script/unmentioned.mjs')
  assert.ok(outsideReads(dir).includes('script/'))
  assert.equal(mode('script/entry.mjs'), 'all')
  assert.equal(mode('script/unmentioned.mjs'), 'all')
}))

for (const entry of ['vitest.config.ts', 'vitest.node-tests.ts', 'vitest.setup.ts', 'vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'package.json']) {
  for (const path of ['script', '/script', 'script/', '../script', '../../script', '../../script/entry.mjs']) {
    test(`UI config ${entry} naming ${JSON.stringify(path)} reads the whole script directory`, () => fixture(({ dir, put, mode }) => {
      put(`packages/ui/${entry}`, entry.endsWith('.json')
        ? JSON.stringify({ name: '@harnessdesk/ui', paths: [path] }) : `export const path = '${path}'\n`)
      put('script/unmentioned.mjs')
      assert.ok(outsideReads(dir).includes('script/'))
      assert.equal(mode('script/unmentioned.mjs'), 'all')
    }))
  }
}

test('a config dependency naming the script directory covers every script', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/vitest.config.ts', "import './config/hooks.ts'\n")
  put('packages/ui/config/hooks.ts', "export const alias = '../../script'\n")
  put('script/unmentioned.mjs')
  assert.ok(outsideReads(dir).includes('script/'))
  assert.equal(mode('script/unmentioned.mjs'), 'all')
}))

for (const text of [
  'export const scripts = "scripts"\n', 'export const path = "../../scripts"\n',
  'export const path = "../../scripts/"\n', '// The script directory holds gates.\n',
  '// An alias could point at "../../script".\n', '/* An alias could point at \'script\'. */\n',
]) {
  test(`config prose and scripts do not read the script directory: ${JSON.stringify(text)}`, () => fixture(({ dir, put, mode }) => {
    put('packages/ui/vitest.config.ts', text)
    put('script/unmentioned.mjs')
    assert.deepEqual(outsideReads(dir), [])
    assert.equal(mode('script/unmentioned.mjs'), 'none')
  }))
}

for (const entry of ['vitest.config.ts', 'vitest.node-tests.ts', 'vitest.setup.ts', 'vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'package.json']) {
  test(`UI root ${entry} naming a script also covers unrelated scripts`, () => fixture(({ put, mode }) => {
    put(`packages/ui/${entry}`, entry.endsWith('.json')
      ? '{"name":"@harnessdesk/ui","files":["../../script/config-helper.mjs"]}' : "import '../../script/config-helper.mjs'\n")
    put('script/config-helper.mjs')
    put('script/unused.mjs')
    assert.equal(mode('script/config-helper.mjs'), 'all')
    assert.equal(mode('script/unused.mjs'), 'all')
  }))
}

for (const last of ["import '../../script/config-helper.mjs'", '// script/config-helper.mjs']) {
  test(`UI config imports are followed anywhere in the repository: ${last}`, () => fixture(({ dir, put, mode }) => {
    put('packages/ui/vitest.config.ts', "import './config/hooks.ts'\n")
    put('packages/ui/config/hooks.ts', "export * from '../../../config/hop0.ts'\n")
    for (let i = 0; i < 32; i++) put(`config/hop${i}.ts`, `export * from './hop${i + 1}.ts'\n`)
    put('config/hop32.ts', "import './nested/last.ts'\n")
    put('config/nested/last.ts', `${last}\nimport '../hop0.ts'\n`)
    put('script/config-helper.mjs', "import './child.mjs'\n")
    put('script/child.mjs')
    put('script/unused.mjs')
    assert.deepEqual(outsideReads(dir).filter(path => path.startsWith('script/')), [
      ...(last.startsWith('import') ? ['script/'] : []), 'script/child.mjs', 'script/config-helper.mjs',
    ])
    assert.equal(mode('script/config-helper.mjs'), 'all')
    assert.equal(mode('script/child.mjs'), 'all')
    assert.equal(mode('script/unused.mjs'), last.startsWith('import') ? 'all' : 'none')
  }))
}

for (const module of ['node:fs', 'fs', 'node:fs/promises', 'fs/promises', 'node:child_process', 'child_process', 'execa', 'cross-spawn']) {
  test(`an imported script using ${module} covers constructed child paths`, () => fixture(({ dir, put, mode }) => {
    put('packages/ui/src/reads.test.ts', "import '../../../script/entry.mjs'\n")
    put('script/entry.mjs', "export * from './reader.mjs'\n")
    put('script/reader.mjs', `import reader from '${module}'\nimport { join } from 'node:path'\nreader(join(import.meta.dirname, 'child.json'))\n`)
    put('script/child.json', '{}')
    assert.ok(outsideReads(dir).includes('script/'))
    assert.equal(mode('script/child.json'), 'all')
    assert.equal(mode('script/unmentioned.mjs'), 'all')
  }))
  test(`a UI reader importing ${module} and naming a script covers the whole directory`, () => fixture(({ dir, put, mode }) => {
    put('packages/ui/src/reads.test.ts', `import reader from '${module}'\nreader('script/helper.mjs')\n`)
    put('script/helper.mjs')
    assert.ok(outsideReads(dir).includes('script/'))
    assert.equal(mode('script/unmentioned.mjs'), 'all')
  }))
}

test('an imported script with a glob reads the whole script directory', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/src/reads.test.ts', "import '../../../script/entry.mjs'\n")
  put('script/entry.mjs', "const files = import.meta.glob('./*.json')\n")
  put('script/child.json', '{}')
  assert.ok(outsideReads(dir).includes('script/'))
  assert.equal(mode('script/child.json'), 'all')
}))

test('an imported script reading a constructed child path selects the child', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/src/reads.test.ts', "import '../../../script/parent.mjs'\n")
  put('script/parent.mjs', "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\nreadFileSync(join(import.meta.dirname, 'child.json'))\n")
  put('script/child.json', '{}')
  assert.ok(outsideReads(dir).includes('script/'))
  assert.equal(mode('script/child.json'), 'all')
}))

for (const text of [
  '// script/foo.mjs is a gate.\nexport const label = "Ready"\n',
  '// Run script/foo.mjs.\n',
  'export const Example = () => <p>Run script/foo.mjs</p>\n',
  'export const Example = () => <Signal said="run script/foo.mjs" />\n',
  '/* script/foo.mjs generated this sheet. */\n',
]) {
  test(`ordinary UI text names a script and its static imports: ${JSON.stringify(text)}`, () => fixture(({ dir, put, mode }) => {
    put('packages/ui/src/Example.tsx', text)
    put('script/foo.mjs', "import { readFileSync } from 'node:fs'\nexport * from './helper.mjs'\nconst commands = ['script/other.mjs']\n")
    put('script/helper.mjs', "import { spawn } from 'node:child_process'\nimport './foo.mjs'\n")
    put('script/other.mjs')
    assert.deepEqual(outsideReads(dir), ['script/foo.mjs', 'script/helper.mjs'])
    assert.equal(mode('script/foo.mjs'), 'all')
    assert.equal(mode('script/helper.mjs'), 'all')
    assert.equal(mode('script/other.mjs'), 'none')
  }))
}

for (const file of ['packages/ui/src/sheet.css', 'packages/ui/src/notes.md', 'packages/ui/site-demo/index.html']) {
  test(`mentions in any UI file count: ${file}`, () => fixture(({ put, mode }) => {
    put(file, '/* script/named.mjs */\n')
    put('script/named.mjs')
    put('script/unused.mjs')
    assert.equal(mode('script/named.mjs'), 'all')
    assert.equal(mode('script/unused.mjs'), 'none')
  }))
}

test('a script named in a filesystem-reading test covers the whole directory', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/src/reads.test.ts', "import { readFileSync } from 'node:fs'\n// script/named.mjs\n")
  put('script/named.mjs')
  assert.ok(outsideReads(dir).includes('script/'))
  assert.equal(mode('script/unmentioned.mjs'), 'all')
}))

test('a quoted script word counts even among other quotes in a reader comment', () => fixture(({ put, mode }) => {
  put('packages/ui/src/reads.test.ts', "import { readFileSync } from 'node:fs'\n/* it's 'script' */\n")
  assert.equal(mode('script/unmentioned.mjs'), 'all')
}))

test('a named directory must contain a file; missing paths and constructed fragments are dropped', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/src/Example.tsx', '// script/tools, script/empty, script/Other, script/${f.file}\n')
  put('script/tools/nested/data.json', '{}')
  mkdirSync(join(dir, 'script/empty'), { recursive: true })
  assert.deepEqual(outsideReads(dir), ['script/tools'])
  assert.equal(mode('script/tools/nested/data.json'), 'all')
  for (const file of ['script/empty/new.mjs', 'script/Other', 'script/unmentioned.mjs']) assert.equal(mode(file), 'all', file)
}))

test('the scripts key in a manifest does not name the script directory', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/package.json', JSON.stringify({ name: '@harnessdesk/ui', scripts: { test: 'vitest run' } }))
  put('script/foo.mjs')
  assert.deepEqual(outsideReads(dir), [])
  assert.equal(mode('script/foo.mjs'), 'none')
}))

test('a script in the UI package command covers the script directory', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/package.json', JSON.stringify({ name: '@harnessdesk/ui', scripts: { test: 'node ../../script/verify.mjs && vitest run' } }))
  put('script/verify.mjs', "import { spawn } from 'node:child_process'\nimport './helper.mjs'\nconst commands = ['script/other.mjs', 'script/${f.file}', 'script/Other']\n")
  put('script/helper.mjs')
  put('script/other.mjs')
  assert.deepEqual(outsideReads(dir), ['script/', 'script/helper.mjs', 'script/verify.mjs'])
  assert.equal(mode('script/other.mjs'), 'all')
}))

for (const expression of [
  "import '../../../script/entry.mjs'",
  "import '../../../script/entry.mjs?raw'",
  "export { value } from '../../../script/entry.mjs?url'",
  "import('../../../script/entry.mjs')",
  'import(`../../../script/entry.mjs`)',
  "import.meta.glob(['./*.ts', '../../../script/entry.mjs'])",
]) {
  test(`a literal script import selects its closure: ${expression}`, () => fixture(({ put, mode }) => {
    put('packages/ui/src/reads.test.ts', `${expression}\n`)
    put('script/entry.mjs', "export { value } from './child.mjs'\n")
    put('script/child.mjs', 'export const value = 1\n')
    assert.equal(mode('script/child.mjs'), 'all')
  }))
}

test('an unresolved script import creates no read but still takes the deletion fallback', () => fixture(({ dir, put, mode }) => {
  put('packages/ui/src/plain.test.ts', "import '../../../script/missing.mjs'\n")
  assert.deepEqual(outsideReads(dir), [])
  assert.equal(mode('script/missing.mjs'), 'all')
}))

for (const text of ["import '../../../script/entry.mjs'\n", '// script/entry.mjs\n']) {
  test(`a deleted script still selects all when the UI retains ${JSON.stringify(text)}`, () => fixture(({ dir, put, mode }) => {
    put('packages/ui/src/plain.test.ts', text)
    put('script/entry.mjs')
    put('script/unused.mjs')
    assert.equal(mode('script/entry.mjs'), 'all')
    rmSync(join(dir, 'script/entry.mjs'))
    assert.deepEqual(outsideReads(dir), [])
    const deleted = unitPlan(dir, { event: 'pull_request', paths: ['script/entry.mjs'] })
    assert.equal(deleted.mode, 'all')
    assert.match(deleted.summary, /script\/entry\.mjs was deleted/)
    assert.equal(mode('script/unused.mjs'), 'none')
  }))
}

test('a script import example in test setup is a named read', () => fixture(({ put, mode }) => {
  put('packages/ui/src/setup-tests.ts', '// import "../../../script/example.mjs"\n')
  put('script/example.mjs')
  assert.equal(mode('script/example.mjs'), 'all')
}))

test('a quoted HTML script tag without a tree read leaves unread scripts unselected', () => fixture(({ put, mode }) => {
  put('packages/ui/src/plain.test.ts', "expect(element.tagName).toBe('script')\n")
  put('script/unused.mjs')
  assert.equal(mode('script/unused.mjs'), 'none')
}))

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

test('unread scripts select nothing, alone or alongside a related UI change', () => {
  assert.equal(plan(['script/cut-avatars.mjs']).mode, 'none')
  const changed = ['packages/ui/src/components/BringHome.tsx']
  assert.deepEqual(plan([...changed, 'script/cut-avatars.mjs']), plan(changed))
})

test('scripts read by imports, transitive scripts or setup still select all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-unit-scripts-'))
  try {
    const put = (path, text) => {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    put('packages/ui/package.json', JSON.stringify({ name: '@harnessdesk/ui' }))
    put('packages/ui/src/reads.test.ts', "import '../../../script/imported.mjs'\nimport '../../../script/extensionless'\n")
    put('packages/ui/src/sheet.css', '/* script/css-comment.mjs generated this sheet. */\n')
    put('script/imported.mjs', "export { value } from './second.mjs'\n")
    put('script/second.mjs', "export * from './third.mjs'\n")
    put('script/third.mjs', "import './fourth.mjs'\n")
    put('script/fourth.mjs', "import './imported.mjs'\n")
    for (const file of ['spawned', 'url', 'comment', 'css-comment', 'extensionless', 'unused', 'setup', 'setup-child']) put(`script/${file}.mjs`, '')
    put('packages/ui/src/setup-tests.ts', "import '../../../script/setup.mjs'\n")
    put('script/setup.mjs', "import './setup-child.mjs'\n")
    const reads = outsideReads(dir)
    for (const file of ['imported', 'second', 'third', 'fourth', 'extensionless', 'setup', 'setup-child']) {
      assert.ok(reads.includes(`script/${file}.mjs`), file)
      assert.equal(unitPlan(dir, { event: 'pull_request', paths: [`script/${file}.mjs`] }).mode, 'all', file)
    }
    assert.ok(setupFiles(dir).has('script/setup-child.mjs'))
    for (const path of ['script/vitest.config.ts', 'script/setup-tests.mjs', '.github/workflows/ci.yml', 'package.json']) {
      assert.equal(unitPlan(dir, { event: 'pull_request', paths: [path] }).mode, 'all', path)
    }
    assert.equal(unitPlan(dir, { event: 'pull_request', paths: ['script/unused.mjs'] }).mode, 'none')
    assert.equal(unitPlan(dir, { event: 'pull_request', paths: ['script/css-comment.mjs'] }).mode, 'all')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real-tree script reads include named gates and their static imports without selecting unrelated scripts', t => {
  const started = performance.now()
  const reads = outsideReads(root).filter(path => path.startsWith('script/'))
  assert.deepEqual(reads, [
    'script/check-reachable.mjs', 'script/check-ui-system.mjs', 'script/design-audit.mjs', 'script/design-doc.mjs',
    'script/design-sections.mjs', 'script/design-tokens.mjs', 'script/design-usage.mjs', 'script/flow-contest.sh',
    'script/lib/repository-files.mjs', 'script/lib/steps.mjs', 'script/lib/stylesheet-imports.mjs', 'script/lib/without-comments.mjs',
    'script/shots/cli-install.mjs', 'script/ui-architecture.mjs', 'script/ui-catalog.mjs', 'script/vendor-fonts.mjs', 'script/verify.mjs',
  ], 'update this list consciously when UI text or script imports change')
  for (const path of ['script/cli-doc.mjs', 'script/generate-codex-protocol.mjs', 'script/check-secrets.mjs', 'script/cut-avatars.mjs']) {
    assert.equal(plan([path]).mode, 'none', path)
  }
  for (const path of ['script/design-audit.mjs', 'script/verify.mjs', 'script/check-ui-system.mjs']) assert.equal(plan([path]).mode, 'all', path)
  assert.equal(plan(['script/cli-doc.mjs', 'docs/x.md', 'packages/cli/src/y.ts']).mode, 'none')
  const changed = ['packages/ui/src/components/BringHome.tsx']
  assert.deepEqual(plan(['script/cli-doc.mjs', ...changed]), plan(changed))
  const milliseconds = (performance.now() - started) / 11
  t.diagnostic(`Real-tree planner: ${milliseconds.toFixed(1)}ms average; ${reads.length} script reads`)
  assert.ok(milliseconds < 500, `planner took ${milliseconds.toFixed(1)}ms per call`)
})
