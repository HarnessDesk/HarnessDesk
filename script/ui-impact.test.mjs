import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { IMPORT, SOURCE, suiteGraph, unobservedSpecs, walk } from './ci-imports.mjs'
import { MAP_VERSION, environmentAt, expectedCounts, exportsData, foldUnits, impactedSpecs, mergeRecords, readMap, repoPath, uiExternalImports, uiFiles, uiGlobbers, uiImporters } from './ui-impact.mjs'

const real = fileURLToPath(new URL('../', import.meta.url))

// A suite of three specs, a helper, and a UI of five files: `x` and `y` are
// components, `z.css` is a stylesheet only `x` imports, `types.ts` was never
// loaded, `shared.ts` is a constant both read.
const tree = {
  'e2e/ui-system/a.spec.ts': "import { helper } from './helper'\nhelper()\n",
  'e2e/ui-system/b.spec.ts': 'export {}\n',
  'e2e/ui-system/helper.ts': 'export const helper = () => 1\n',
  'packages/ui/src/x.tsx': "import './z.css'\nimport { LIMIT } from './shared'\nexport const X = () => LIMIT\n",
  'packages/ui/src/y.tsx': "import { LIMIT } from './shared'\nexport const Y = () => LIMIT\n",
  'packages/ui/src/z.css': '.x { color: red }\n',
  'packages/ui/src/shared.ts': 'export const LIMIT = 3\n',
  'packages/ui/src/types.ts': 'export type T = string\n',
}
const write = (root, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}
const fixture = (extra = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'ui-impact-'))
  write(root, { ...tree, ...extra })
  return root
}
const fixtureWithout = path => {
  const root = fixture()
  rmSync(join(root, 'e2e/ui-system/b.spec.ts'), { force: true })
  rmSync(join(root, path), { force: true })
  return root
}
const record = (file, { tests = 2, unclean = 0, loaded, ran }) => ({ [file]: { tests, unclean, loaded, ran } })
const everything = ['/src/x.tsx', '/src/y.tsx', '/src/z.css', '/src/shared.ts']
const recorded = root => mergeRecords(root, [
  record('e2e/ui-system/a.spec.ts', { loaded: everything, ran: ['/src/x.tsx', '/src/y.tsx'] }),
  record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: ['/src/y.tsx'] }),
], { commit: 'abc' })

// The base branch is what the map saw, unless a test says it has moved on.
const baseOf = (map, edit = () => {}) => {
  const files = Object.fromEntries(Object.entries(map.files).map(([path, entry]) => [path, entry.blob]))
  edit(files)
  return files
}
const context = (root, map, over = {}) => {
  const importers = uiImporters(root)
  return {
    allSpecs: ['a.spec.ts', 'b.spec.ts'],
    specHash: name => map.hashes[map.specs.indexOf(name)],
    baseFiles: () => baseOf(map),
    importers: path => importers.get(path),
    dataExports: path => !existsSync(join(root, path)) || exportsData(readFileSync(join(root, path), 'utf8')),
    ...over,
  }
}

test('a module of the preview is a file of the UI, and nothing else is', () => {
  assert.equal(repoPath('/src/components/Row.tsx'), 'packages/ui/src/components/Row.tsx')
  assert.equal(repoPath('/site-demo/scene.css'), 'packages/ui/site-demo/scene.css')
  assert.equal(repoPath('/src/a%20b.ts'), 'packages/ui/src/a b.ts')
  for (const other of ['/preview.html', '/@vite/client', '/@fs/work/packages/protocol/dist/src/index.js', '/node_modules/.vite/deps/react.js', '/src/../secret.ts', 'src/x.ts', '/%E0%A4%A']) {
    assert.equal(repoPath(other), null, other)
  }
})

test('a map names the specs that ran clean, the files they loaded and the ones in which a function ran', () => {
  const root = fixture()
  try {
    const map = recorded(root)
    assert.deepEqual([map.version, map.commit, map.specs], [MAP_VERSION, 'abc', ['a.spec.ts', 'b.spec.ts']])
    assert.equal(map.hashes.length, 2)
    assert.notEqual(map.hashes[0], map.hashes[1])
    assert.deepEqual(map.files['packages/ui/src/x.tsx'].ran, [0])
    assert.equal(map.files['packages/ui/src/y.tsx'].ran, 'all')
    assert.equal(map.files['packages/ui/src/z.css'].loaded, 'all')
    assert.deepEqual(map.files['packages/ui/src/z.css'].ran, [])
    assert.deepEqual(map.files['packages/ui/src/types.ts'], { blob: map.files['packages/ui/src/types.ts'].blob, loaded: [], ran: [] })
    assert.deepEqual(Object.keys(map.files).sort(), Object.keys(uiFiles(root)).sort(), 'every file of the UI is in it, loaded or not')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a spec with a test that did not pass, or none recorded, is not in the map', () => {
  const root = fixture()
  try {
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { unclean: 1, loaded: everything, ran: everything }),
      record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: ['/src/y.tsx'] }),
      record('e2e/ui-system/gone.spec.ts', { loaded: everything, ran: everything }),
    ])
    assert.deepEqual(map.specs, ['b.spec.ts'])
    assert.deepEqual(map.files['packages/ui/src/x.tsx'].ran, [], 'the spec that failed taught the map nothing')
    assert.deepEqual(mergeRecords(root, [record('e2e/ui-system/b.spec.ts', { tests: 0, loaded: everything, ran: everything })]).specs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('records of one spec from several workers are one spec', () => {
  const root = fixture()
  try {
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { tests: 1, loaded: ['/src/x.tsx'], ran: ['/src/x.tsx'] }),
      record('e2e/ui-system/a.spec.ts', { tests: 1, loaded: ['/src/y.tsx'], ran: ['/src/y.tsx'] }),
    ])
    assert.deepEqual(map.specs, ['a.spec.ts'])
    assert.equal(map.files['packages/ui/src/x.tsx'].ran, 'all')
    assert.equal(map.files['packages/ui/src/y.tsx'].ran, 'all')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a change reaches the specs in which its code ran', () => {
  const root = fixture()
  try {
    const map = recorded(root)
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/x.tsx'], context(root, map)), { specs: ['a.spec.ts'], reason: null })
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/y.tsx'], context(root, map)).specs, ['a.spec.ts', 'b.spec.ts'])
    assert.deepEqual(impactedSpecs(map, [], context(root, map)).specs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a stylesheet or a constant, in which no function ran, reaches whoever imports it', () => {
  const root = fixture()
  try {
    const map = recorded(root)
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/z.css'], context(root, map)).specs, ['a.spec.ts'], 'only x imports it, and x ran in a')
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/shared.ts'], context(root, map)).specs, ['a.spec.ts', 'b.spec.ts'], 'x and y both read it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file nobody imports reaches the specs that loaded it, and one nothing loaded reaches none', () => {
  const root = fixture({ 'packages/ui/src/entry.ts': 'export const entry = 1\n' })
  try {
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { loaded: [...everything, '/src/entry.ts'], ran: ['/src/x.tsx'] }),
      record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: ['/src/y.tsx'] }),
    ])
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/entry.ts'], context(root, map)).specs, ['a.spec.ts'])
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/types.ts'], context(root, map)).specs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file the map has not seen reaches whoever imports it, and the importers are in the change', () => {
  const root = fixture({ 'packages/ui/src/fresh.tsx': 'export const Fresh = () => 1\n' })
  try {
    const map = recorded(root)
    delete map.files['packages/ui/src/fresh.tsx']
    const result = impactedSpecs(map, ['packages/ui/src/fresh.tsx'], context(root, map))
    assert.deepEqual(result, { specs: [], reason: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file that has moved on since the map was recorded cannot be told, and runs everything', () => {
  const root = fixture()
  try {
    const map = recorded(root)
    const x = 'packages/ui/src/x.tsx'
    const moved = impactedSpecs(map, [x], context(root, map, { baseFiles: () => baseOf(map, files => { files[x] = 'f'.repeat(40) }) }))
    assert.equal(moved.specs, null)
    assert.match(moved.reason, /x\.tsx has changed on the base branch since the map/)
    const added = impactedSpecs(map, ['packages/ui/src/new-on-main.tsx'], context(root, map, { baseFiles: () => baseOf(map, files => { files['packages/ui/src/new-on-main.tsx'] = 'a'.repeat(40) }) }))
    assert.equal(added.specs, null)
    assert.match(added.reason, /on the base branch but not in the map/)
    const removed = impactedSpecs(map, [x], context(root, map, { baseFiles: () => baseOf(map, files => { delete files[x] }) }))
    assert.equal(removed.specs, null, 'it was on the base branch when the map was recorded and is not now')
    const unavailable = impactedSpecs(map, [x], context(root, map, { baseFiles: () => null }))
    assert.match(unavailable.reason, /base branch cannot be read/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('what main changed since the map was recorded is read as if this change had touched it', () => {
  const root = fixture()
  try {
    const map = recorded(root)
    const base = edit => () => baseOf(map, edit)
    // `main` rewrote x, which only a ran; this change touches a file nothing ran.
    const changed = impactedSpecs(map, ['packages/ui/src/types.ts'], context(root, map, { baseFiles: base(files => { files['packages/ui/src/x.tsx'] = 'f'.repeat(40) }) }))
    assert.deepEqual(changed.specs, ['a.spec.ts'])
    // `main` added a file the map never saw, or lost one a spec loaded: the map's picture is out of date.
    const added = impactedSpecs(map, ['packages/ui/src/types.ts'], context(root, map, { baseFiles: base(files => { files['packages/ui/src/added.tsx'] = 'a'.repeat(40) }) }))
    assert.match(added.reason, /added\.tsx was added to the base branch since the map/)
    const removed = impactedSpecs(map, ['packages/ui/src/types.ts'], context(root, map, { baseFiles: base(files => { delete files['packages/ui/src/y.tsx'] }) }))
    assert.match(removed.reason, /y\.tsx was removed from the base branch since the map/)
    // A test file that is new on main, and a file nothing loaded that is gone, do not matter to a browser.
    const quiet = impactedSpecs(map, ['packages/ui/src/types.ts'], context(root, map, { baseFiles: base(files => { files['packages/ui/src/x.test.tsx'] = 'a'.repeat(40) }) }))
    assert.deepEqual(quiet.specs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a spec the map has not seen run in its present form runs', () => {
  const root = fixture()
  try {
    const map = recorded(root)
    const grown = impactedSpecs(map, [], context(root, map, { allSpecs: ['a.spec.ts', 'b.spec.ts', 'c.spec.ts'], specHash: name => map.hashes[map.specs.indexOf(name)] }))
    assert.deepEqual(grown.specs, ['c.spec.ts'], 'a spec that is new')
    const edited = impactedSpecs(map, [], context(root, map, { specHash: name => (name === 'b.spec.ts' ? 'edited' : map.hashes[map.specs.indexOf(name)]) }))
    assert.deepEqual(edited.specs, ['b.spec.ts'], 'a spec, or something it loads, that is not what was recorded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a spec that names a file of the UI from its own code runs when it changes', () => {
  const root = fixture()
  try {
    const map = recorded(root)
    const result = impactedSpecs(map, ['packages/ui/src/types.ts'], context(root, map, { nodeSpecs: path => (path.endsWith('types.ts') ? ['b.spec.ts'] : []) }))
    assert.deepEqual(result.specs, ['b.spec.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file that does not read as a map is no map', () => {
  const root = fixture()
  try {
    const map = recorded(root)
    const save = (name, value) => {
      writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value))
      return join(root, name)
    }
    assert.deepEqual(readMap(save('ok.json', map)).specs, map.specs)
    for (const [name, value] of Object.entries({
      empty: '', garbage: '{', array: [], other: { ...map, version: MAP_VERSION + 1 }, lopsided: { ...map, hashes: [] }, none: { ...map, specs: [], hashes: [] }, bare: { version: MAP_VERSION },
    })) assert.equal(readMap(save(`${name}.json`, value)), null, name)
    assert.equal(readMap(join(root, 'missing.json')), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('merge writes a map from the workers of a run, and refuses a run that recorded too little', () => {
  const root = fixture()
  const out = mkdtempSync(join(tmpdir(), 'ui-impact-out-'))
  try {
    mkdirSync(join(out, 'ui-impact-1'), { recursive: true })
    writeFileSync(join(out, 'ui-impact-1', 'worker-1-0-1.json'), JSON.stringify(record('e2e/ui-system/a.spec.ts', { loaded: everything, ran: ['/src/x.tsx'] })))
    writeFileSync(join(out, 'ui-impact-1', 'not-a-record.json'), '{')
    const run = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./ui-impact.mjs', import.meta.url)), 'merge', join(out, 'ui-impact-1'), ...args], { encoding: 'utf8', cwd: root })
    // The script reads the repository it lives in, so only the refusal is run against it here: one spec of 189 is far too little.
    const refused = run('--out', join(out, 'map.json'))
    assert.equal(refused.status, 2, refused.stderr)
    assert.match(refused.stderr, /not writing a map/)
    assert.equal(existsSync(join(out, 'map.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

// What the scan cannot see, it cannot plan around. These two checks keep the
// scan honest about the repository it reads.
test('every import of the UI\'s own source names a file in the tree', () => {
  const missing = []
  const files = Object.keys(uiFiles(real)).filter(path => SOURCE.includes(extname(path)) && !/\.test\.[cm]?[jt]sx?$/.test(path))
  const importers = uiImporters(real)
  const reached = new Set([...importers.values()].flatMap(set => [...set]))
  for (const path of files) {
    for (const [, specifier] of readFileSync(join(real, path), 'utf8').matchAll(IMPORT)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('@/')) continue
      const clean = specifier.replace(/[?#].*$/, '')
      const base = clean.startsWith('@/') ? join(real, 'packages/ui/src', clean.slice(2)) : join(dirname(join(real, path)), clean)
      const found = [base, ...SOURCE.map(ext => `${base}${ext}`), base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), ...SOURCE.map(ext => join(base, `index${ext}`))].some(candidate => existsSync(candidate) && !candidate.endsWith('/'))
      if (!found) missing.push(`${path}: ${specifier}`)
    }
    assert.ok(path.length > 0)
  }
  assert.deepEqual(missing, [], 'an import the scan cannot follow is a path a change would not be followed along')
  assert.ok(reached.size > 300, 'the UI imports itself')
})

test('the modules of the UI that load files by a pattern are the ones the planner knows to ask', () => {
  assert.deepEqual(uiGlobbers(real), ['packages/ui/src/lib/avatars.ts', 'packages/ui/src/preview/coverage-registry.ts'],
    'a pattern picks up a file that no importer names; a new one is planned for by adding the file to a spec or to this list')
})

test('adding or deleting a file reaches the specs that ran a module which loads files by a pattern', () => {
  const root = fixture({ 'packages/ui/src/registry.ts': "export const all = import.meta.glob('./*.tsx')\n" })
  try {
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { loaded: [...everything, '/src/registry.ts'], ran: ['/src/x.tsx', '/src/registry.ts'] }),
      record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: ['/src/y.tsx'] }),
    ])
    const globbers = () => ['packages/ui/src/registry.ts']
    // A new component: the registry of `a` picks it up, whoever imports it.
    delete map.files['packages/ui/src/fresh.tsx']
    const added = impactedSpecs(map, ['packages/ui/src/fresh.tsx'], context(root, map, { globbers }))
    assert.deepEqual(added.specs, ['a.spec.ts'])
    // A deleted one: it was in the map, and is not on disk.
    const deleted = impactedSpecs(map, ['packages/ui/src/types.ts'], context(root, map, { exists: () => false, globbers }))
    assert.deepEqual(deleted.specs, ['a.spec.ts'])
    // An edit to a file that stays does not ask the registry.
    const edited = impactedSpecs(map, ['packages/ui/src/types.ts'], context(root, map, { globbers }))
    assert.deepEqual(edited.specs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a stylesheet the bundler took into another has no script of its own, and still reaches whoever imports the other', () => {
  const root = fixture({
    'packages/ui/src/z.css': "@import './inner.css';\n.x { background: url(./font.woff2) }\n",
    'packages/ui/src/inner.css': '.inner { color: red }\n',
    'packages/ui/src/font.woff2': 'binary',
  })
  try {
    const map = recorded(root)
    // The run saw `z.css` as a script and neither of the two files it names.
    for (const path of ['packages/ui/src/inner.css', 'packages/ui/src/font.woff2']) {
      assert.deepEqual(map.files[path].loaded, [], path)
      assert.deepEqual(impactedSpecs(map, [path], context(root, map)).specs, ['a.spec.ts'], path)
    }
    // A script nobody loaded still reaches no one.
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/types.ts'], context(root, map)).specs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a module that hands data to its importers reaches the specs in which they ran, not only the ones that called it', () => {
  const root = fixture()
  try {
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { loaded: everything, ran: ['/src/x.tsx', '/src/shared.ts'] }),
      record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: ['/src/y.tsx'] }),
    ])
    const shared = 'packages/ui/src/shared.ts'
    assert.deepEqual(impactedSpecs(map, [shared], context(root, map, { dataExports: () => false })).specs, ['a.spec.ts'], 'by its functions alone')
    assert.deepEqual(impactedSpecs(map, [shared], context(root, map)).specs, ['a.spec.ts', 'b.spec.ts'], 'and by what its importers read, as `export const LIMIT = 3` hands on')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a module hands data to its importers when it exports a value that is not a function', () => {
  for (const [text, expected] of [
    ['export function f() {}\nexport type T = string', false],
    ["const x = 1\nwindow.x = x", true],
    ["export const LABEL = 'Ready'", true],
    ['export const ITEMS = [1, 2]', true],
    ['export const limits: Limits = { max: 3 }', true],
    ['export default { a: 1 }', true],
    ['export enum Kind { A }', true],
    ['export const Foo = ({ a }) => a', false],
    ['export const Foo = (a: string) => a', false],
    ['export const Foo = async (a) => a', false],
    ['export const Foo = a => a', false],
    ['export const Foo = <T,>(a: T) => a', false],
    ['export const Foo = forwardRef<HTMLDivElement, Props>((props, ref) => null)', false],
    ['export const Foo = memo(function Foo() { return null })', false],
    ['export const variants = cva("a", { variants: {} })', false],
    ['export function foo() {}\nexport default function Foo() {}', false],
    ['export class Store {}', false],
    ['const hidden = [1]\nexport function read() { return hidden }', false],
    ["export const a = () => 1\nexport const B = 'two'", true],
    ["const LABEL = 'Broken'\nexport { LABEL }\nexport function unrelated() {}", true],
    ["export const LABEL = ('Broken')", true],
    ["export * from './a'", true],
    ["export { a } from './a'", true],
    ['export class Store { static limit = 3 }', true],
    ['export const Foo = (\n  a: string,\n) => a', false],
    ['export const Foo = ({\n  a,\n}) => a', false],
    ['export const FlowInputFields = ({ flow, scope, vars }: {\n  flow: string\n}) => null', false],
    ['export const Foo = (props: Props) => props.team ? 1 : 2', false],
  ]) assert.equal(exportsData(text), expected, text)
})

test('a spec is in the map only if every test it has was recorded, and it opens no page the recorder cannot see', () => {
  const root = fixture()
  try {
    const records = [
      record('e2e/ui-system/a.spec.ts', { tests: 2, loaded: everything, ran: everything }),
      record('e2e/ui-system/b.spec.ts', { tests: 2, loaded: everything, ran: everything }),
    ]
    assert.deepEqual(mergeRecords(root, records, { expected: { 'a.spec.ts': 2, 'b.spec.ts': 3 } }).specs, ['a.spec.ts'], 'b has a test that left no record')
    assert.deepEqual(mergeRecords(root, records, { expected: {} }).specs, [], 'nothing is known to be whole')
    assert.deepEqual(mergeRecords(root, records, { expected: { 'a.spec.ts': 2, 'b.spec.ts': 2 }, unobserved: ['a.spec.ts'] }).specs, ['b.spec.ts'])
    assert.deepEqual(mergeRecords(root, records, { environment: { 'package.json': 'abc' } }).environment, { 'package.json': 'abc' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the specs that open pages of their own are found through the helpers that open them', () => {
  const root = fixture({
    'e2e/ui-system/opens.ts': 'export const open = async browser => browser.newPage()\n',
    'e2e/ui-system/b.spec.ts': "import { open } from './opens'\nopen()\n",
  })
  const without = fixtureWithout('e2e/ui-system/opens.ts')
  try {
    assert.deepEqual(unobservedSpecs(root), ['b.spec.ts'])
    assert.deepEqual(unobservedSpecs(without), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(without, { recursive: true, force: true })
  }
})

test('a change to the setup the map was recorded in ends the map', () => {
  const root = fixture()
  try {
    const map = { ...recorded(root), environment: { 'package.json': 'a'.repeat(40), 'packages/protocol': 'b'.repeat(40) } }
    const same = impactedSpecs(map, ['packages/ui/src/x.tsx'], context(root, map, { baseEnvironment: () => ({ ...map.environment }) }))
    assert.deepEqual(same.specs, ['a.spec.ts'])
    const moved = impactedSpecs(map, ['packages/ui/src/x.tsx'], context(root, map, { baseEnvironment: () => ({ ...map.environment, 'packages/protocol': 'c'.repeat(40) }) }))
    assert.equal(moved.specs, null)
    assert.match(moved.reason, /packages\/protocol has changed on the base branch since the map/)
    assert.match(impactedSpecs(map, [], context(root, map, { baseEnvironment: () => null })).reason, /setup of the base branch cannot be read/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a test file is no input of a browser, wherever its version stands', () => {
  const root = fixture()
  try {
    const map = recorded(root)
    const moved = impactedSpecs(map, ['packages/ui/src/x.test.tsx'], context(root, map, { baseFiles: () => baseOf(map, files => { files['packages/ui/src/x.test.tsx'] = 'f'.repeat(40) }) }))
    assert.deepEqual(moved, { specs: [], reason: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the tests of each spec come from the listing of the run', () => {
  const listing = { suites: [{ file: 'e2e/ui-system/a.spec.ts', specs: [{ tests: [{}] }, { tests: [{}, {}] }], suites: [{ specs: [{ tests: [{}] }] }] }, { file: 'e2e/ui-system/b.spec.ts', specs: [] }] }
  assert.deepEqual(expectedCounts([listing, { suites: [{ file: 'e2e/ui-system/c.spec.ts', specs: [{ tests: [{}] }] }] }]), { 'a.spec.ts': 4, 'c.spec.ts': 1 })
})

test('every stylesheet of the UI names, by @import or url(), files that are in the tree', () => {
  const missing = []
  for (const path of Object.keys(uiFiles(real)).filter(path => path.endsWith('.css'))) {
    const text = readFileSync(join(real, path), 'utf8')
    for (const [, specifier] of [...text.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g), ...text.matchAll(/url\(\s*['"]?(\.[^'")\s]+)['"]?\s*\)/g)]) {
      if (!specifier.startsWith('.')) continue
      if (!existsSync(join(dirname(join(real, path)), specifier.replace(/[?#].*$/, '')))) missing.push(`${path}: ${specifier}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('a stylesheet that is not scoped to a module reaches everything that loaded it, wherever the bundler took it in', () => {
  const root = fixture({
    'packages/ui/src/z.css': "@import './inner.css';\n",
    'packages/ui/src/inner.css': '.node { visibility: hidden }\n',
    'packages/ui/src/scoped.module.css': '.a { color: red }\n',
    'packages/ui/src/leaky.module.css': ':global(.node) { color: red }\n',
  })
  try {
    // `x` ran in `a` only, `y` in both; the sheets were loaded by both specs, and x imports them all.
    const x = root + '/packages/ui/src/x.tsx'
    writeFileSync(x, "import './z.css'\nimport './scoped.module.css'\nimport './leaky.module.css'\nexport const X = () => 1\n")
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { loaded: [...everything, '/src/scoped.module.css', '/src/leaky.module.css'], ran: ['/src/x.tsx'] }),
      record('e2e/ui-system/b.spec.ts', { loaded: [...everything, '/src/scoped.module.css', '/src/leaky.module.css'], ran: ['/src/y.tsx'] }),
    ])
    const sheet = path => root + '/' + path
    const globalSheet = path => path.endsWith('.css') && (!path.endsWith('.module.css') || /:global\b/.test(readFileSync(sheet(path), 'utf8')))
    const specs = path => impactedSpecs(map, [path], context(root, map, { globalSheet })).specs
    assert.deepEqual(specs('packages/ui/src/scoped.module.css'), ['a.spec.ts'], 'a sheet of one module is that module\'s')
    assert.deepEqual(specs('packages/ui/src/leaky.module.css'), ['a.spec.ts', 'b.spec.ts'], ':global reaches whatever loaded the sheet')
    assert.deepEqual(specs('packages/ui/src/z.css'), ['a.spec.ts', 'b.spec.ts'], 'a plain sheet is global')
    assert.deepEqual(specs('packages/ui/src/inner.css'), ['a.spec.ts', 'b.spec.ts'], 'also when it has no script of its own and is taken in by another')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a unit test that imports a module says nothing of the specs that loaded it', () => {
  const root = fixture({ 'packages/ui/src/shared.test.ts': "import { LIMIT } from './shared'\nLIMIT\n" })
  try {
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { loaded: [...everything, '/src/shared.test.ts'], ran: ['/src/x.tsx'] }),
      record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: ['/src/y.tsx'] }),
    ])
    // `shared.ts` ran nowhere, and is imported by x, y and the test: x and y answer, the test does not.
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/shared.ts'], context(root, map)).specs, ['a.spec.ts', 'b.spec.ts'])
    // Imported by nothing but a test, it is what the specs that loaded it saw.
    writeFileSync(join(root, 'packages/ui/src/x.tsx'), 'export const X = () => 1\n')
    writeFileSync(join(root, 'packages/ui/src/y.tsx'), 'export const Y = () => 1\n')
    const alone = impactedSpecs(map, ['packages/ui/src/shared.ts'], context(root, map, { importers: path => uiImporters(root).get(path) }))
    assert.deepEqual(alone.specs, ['a.spec.ts', 'b.spec.ts'], 'by loaded coverage')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file outside the UI that its source imports is found, and one only its tests import is not', () => {
  const root = fixture({
    'shared-ui.ts': 'export const OUTSIDE = 1\n',
    'packages/ui/src/uses-outside.ts': "import { OUTSIDE } from '../../../shared-ui'\nexport const read = () => OUTSIDE\n",
    'tests-only.ts': 'export const T = 1\n',
    'packages/ui/src/only.test.ts': "import { T } from '../../../tests-only'\nT\n",
  })
  try {
    assert.deepEqual([...uiExternalImports(root)], ['shared-ui.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the setup a map was recorded in covers the pages and configuration of the UI, not only the ones named', () => {
  const environment = environmentAt(real)
  for (const path of ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'packages/ui/vite.config.ts', 'packages/ui/preview.html', 'packages/ui/narrow-overlay.html', 'packages/protocol', 'script/ui-impact']) {
    assert.match(environment[path] ?? '', /^[0-9a-f]{40}$/, path)
  }
  assert.ok(!('packages/ui/src' in environment) && !('packages/ui/site-demo' in environment), 'the source is tracked file by file')
})

test('the scan of the suite does not need the build: an import of build output that is not there is no file to follow', () => {
  const root = fixture({ 'e2e/ui-system/b.spec.ts': "import { rig } from '../../packages/server/dist/test/fixtures/rig.js'\nrig()\n" })
  const unresolved = fixture({ 'e2e/ui-system/b.spec.ts': "import { x } from './does-not-exist'\nx()\n" })
  try {
    const graph = suiteGraph(root)
    assert.ok(graph.sources.some(file => file.endsWith('b.spec.ts')))
    assert.throws(() => suiteGraph(unresolved), /Cannot resolve suite import/, 'any other import that names nothing is still an error')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(unresolved, { recursive: true, force: true })
  }
})

test('a spec recorded unit by unit is planned onto the units a change reaches', () => {
  const root = fixture()
  try {
    // `a` has two units: `one` ran x, `two` ran y. `b` has none.
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { loaded: everything, ran: ['/src/x.tsx', '/src/y.tsx'] }),
      record('e2e/ui-system/a.spec.ts#one', { tests: 1, loaded: everything, ran: ['/src/x.tsx'] }),
      record('e2e/ui-system/a.spec.ts#two', { tests: 1, loaded: everything, ran: ['/src/y.tsx'] }),
      record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: ['/src/y.tsx'] }),
    ], { commit: 'abc' })
    assert.deepEqual(map.specs, ['a.spec.ts', 'a.spec.ts#one', 'a.spec.ts#two', 'b.spec.ts'])
    assert.equal(map.hashes[1], map.hashes[0], 'a unit is its spec in its present form')
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/x.tsx'], context(root, map)).specs, ['a.spec.ts#one'])
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/y.tsx'], context(root, map)).specs, ['a.spec.ts#two', 'b.spec.ts'])
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/shared.ts'], context(root, map)).specs, ['a.spec.ts#one,two', 'b.spec.ts'])
    const edited = impactedSpecs(map, ['packages/ui/src/x.tsx'], context(root, map, { specHash: name => (name === 'a.spec.ts' ? 'edited' : map.hashes[map.specs.indexOf(name)]) }))
    assert.deepEqual(edited.specs, ['a.spec.ts'], 'an edited spec runs whole')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a unit is planned from only when its whole spec was recorded clean', () => {
  const root = fixture()
  try {
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { unclean: 1, loaded: everything, ran: everything }),
      record('e2e/ui-system/a.spec.ts#one', { tests: 1, loaded: everything, ran: ['/src/x.tsx'] }),
      record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: ['/src/y.tsx'] }),
      record('e2e/ui-system/b.spec.ts#two', { tests: 1, unclean: 1, loaded: everything, ran: ['/src/y.tsx'] }),
    ])
    assert.deepEqual(map.specs, ['b.spec.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('whole-spec coverage from any input survives another input reaching a unit', () => {
  const root = fixture()
  try {
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { loaded: everything, ran: ['/src/x.tsx', '/src/y.tsx'] }),
      record('e2e/ui-system/a.spec.ts#one', { tests: 1, loaded: everything, ran: ['/src/x.tsx'] }),
      record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: [] }),
    ])
    const x = 'packages/ui/src/x.tsx', y = 'packages/ui/src/y.tsx'
    assert.deepEqual(impactedSpecs(map, [x], context(root, map)).specs, ['a.spec.ts#one'])
    for (const paths of [[x, y], [y, x]]) {
      assert.deepEqual(impactedSpecs(map, paths, context(root, map)).specs, ['a.spec.ts'])
    }
    assert.deepEqual(impactedSpecs(map, [x], context(root, map, {
      baseFiles: () => baseOf(map, files => { files[y] = 'new-on-main' }),
    })).specs, ['a.spec.ts'], 'drift on main also keeps whole-spec coverage')
    assert.deepEqual(impactedSpecs(map, [x, 'packages/ui/src/new.ts'], context(root, map, {
      globbers: () => [y],
    })).specs, ['a.spec.ts'], 'a changed glob also keeps whole-spec coverage')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unit coverage through an importer cannot hide a module that ran outside a unit', () => {
  const root = fixture()
  try {
    const map = mergeRecords(root, [
      record('e2e/ui-system/a.spec.ts', { loaded: everything, ran: ['/src/x.tsx', '/src/shared.ts'] }),
      record('e2e/ui-system/a.spec.ts#one', { tests: 1, loaded: everything, ran: ['/src/x.tsx'] }),
      record('e2e/ui-system/b.spec.ts', { loaded: everything, ran: [] }),
    ])
    assert.deepEqual(impactedSpecs(map, ['packages/ui/src/shared.ts'], context(root, map)).specs, ['a.spec.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('one entry per spec: whole wins over its units, and units join', () => {
  assert.deepEqual(foldUnits(['a.spec.ts#two', 'b.spec.ts', 'a.spec.ts#one', 'c.spec.ts#x', 'c.spec.ts']), ['a.spec.ts#one,two', 'b.spec.ts', 'c.spec.ts'])
})
