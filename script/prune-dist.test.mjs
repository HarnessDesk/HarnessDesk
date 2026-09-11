import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { main, prune } from './prune-dist.mjs'

/**
 * `prune-dist` deletes files, which makes it the one build step whose bugs
 * are quiet in the wrong direction. A gate that misreads its input fails
 * loudly; a prune that misreads its input removes a test, and the glob that
 * runs the tests passes on whatever is left. So every case here that removes
 * something also holds something that must stay, and the last one uses the
 * real compiler instead of a tree laid out by hand — a hand layout is only
 * what this file believes `tsc` writes, and that belief is part of what is
 * under test.
 */

const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc')
const SCRIPT = fileURLToPath(new URL('./prune-dist.mjs', import.meta.url))

/** A package the way every Node package here is configured, near enough to compile. */
const PACKAGE = {
  compilerOptions: {
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    declaration: true,
    declarationMap: true,
    sourceMap: true,
    composite: true,
    types: [],
    rootDir: '.',
    outDir: 'dist',
    tsBuildInfoFile: 'dist/.tsbuildinfo',
  },
  include: ['src/**/*.ts', 'test/**/*.ts'],
}

const write = (at, text = '') => {
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at, text)
}

/**
 * A checkout whose root `tsconfig.json` references one package, `demo`, laid
 * out from a list of paths inside it. The root file carries a comment because
 * the real one does, and a parser that chokes on it reads no packages at all.
 */
const checkout = (t, files = []) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'hd-prune-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  write(join(repo, 'tsconfig.json'), `// The solution file.\n${JSON.stringify({ files: [], references: [{ path: 'packages/demo' }] })}\n`)
  write(join(repo, 'packages/demo/tsconfig.json'), JSON.stringify(PACKAGE))
  for (const file of files) write(join(repo, 'packages/demo', file))
  return repo
}

/** The four files `tsc` writes for one `.ts` source under these options. */
const outputs = (stem) => ['.js', '.js.map', '.d.ts', '.d.ts.map'].map((suffix) => stem + suffix)

const inDemo = (repo, files) => files.map((file) => relative(join(repo, 'packages/demo'), file)).sort()
const has = (repo, path) => existsSync(join(repo, 'packages/demo', path))

const sink = () => ({ text: '', write(chunk) { this.text += chunk; return true } })

/** The step run the way the build runs it: its own process, handed a checkout. */
const command = (script, repo) => spawnSync(process.execPath, [script, repo], { encoding: 'utf8' })

test('a compiled test whose source is gone goes, with its map and declarations', (t) => {
  const repo = checkout(t, [
    'test/kept.test.ts',
    ...outputs('dist/test/kept.test'),
    ...outputs('dist/test/gone.test'),
  ])
  const { removed, missing } = prune(repo)
  assert.deepEqual(inDemo(repo, removed), outputs('dist/test/gone.test').sort())
  assert.deepEqual(missing, [])
  // The control: the test whose source is still there is untouched.
  for (const file of outputs('dist/test/kept.test')) assert.ok(has(repo, file), file)
})

test('a module whose source is gone goes too, and so does the directory it empties', (t) => {
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index'), ...outputs('dist/src/retired/old')])
  const { removed } = prune(repo)
  assert.deepEqual(inDemo(repo, removed), outputs('dist/src/retired/old').sort())
  assert.equal(has(repo, 'dist/src/retired'), false)
  assert.ok(has(repo, 'dist/src/index.js'))
})

test('a copied fixture stays while its original does, and goes when it does not', (t) => {
  const repo = checkout(t, [
    // Copied by copy-fixtures.mjs, to the same path under dist.
    'test/fixtures/fake-agent.mjs',
    'dist/test/fixtures/fake-agent.mjs',
    'test/fixtures/plugin/manifest.json',
    'dist/test/fixtures/plugin/manifest.json',
    // Compiled by tsc like any other source.
    'test/fixtures/harness.ts',
    ...outputs('dist/test/fixtures/harness'),
    // Copied once; the originals have since been deleted.
    'dist/test/fixtures/retired-agent.mjs',
    'dist/test/fixtures/retired-plugin/manifest.json',
  ])
  const { removed } = prune(repo)
  assert.deepEqual(inDemo(repo, removed), [
    'dist/test/fixtures/retired-agent.mjs',
    'dist/test/fixtures/retired-plugin/manifest.json',
  ])
  assert.equal(has(repo, 'dist/test/fixtures/retired-plugin'), false)
  for (const kept of ['dist/test/fixtures/fake-agent.mjs', 'dist/test/fixtures/plugin/manifest.json', 'dist/test/fixtures/harness.js']) {
    assert.ok(has(repo, kept), kept)
  }
})

test('a source the compiler reaches without `include` still keeps what it compiles to', (t) => {
  // `include` names `.ts` only, so the compiler's own list holds neither of
  // these; an import would still compile them. The net is the source on disk.
  // (`index.ts` is there because a package with no inputs at all does not
  // parse — for `tsc -b` either.)
  const repo = checkout(t, [
    'src/index.ts',
    ...outputs('dist/src/index'),
    'src/view.tsx',
    'dist/src/view.js',
    'dist/src/view.d.ts',
    'src/worker.mts',
    'dist/src/worker.mjs',
    'dist/src/worker.d.mts',
  ])
  assert.deepEqual(prune(repo).removed, [])
})

test('what this build does not write is not its business', (t) => {
  const repo = checkout(t, [
    'src/index.ts',
    ...outputs('dist/src/index'),
    'dist/.tsbuildinfo',
    'dist/notes.txt',
    'dist/src/catalog.json',
  ])
  assert.deepEqual(prune(repo).removed, [])
})

test('a package the compiler does not build is never read, whatever its dist holds', (t) => {
  // The shape of packages/ui: a Vite bundle, hashed `.js` with no source of
  // that name. Reading it the way a compiled package is read removes all of
  // it. This one is even configured like a compiled package, so that nothing
  // but the root's reference list keeps it out.
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index')])
  write(join(repo, 'packages/ui/tsconfig.json'), JSON.stringify(PACKAGE))
  write(join(repo, 'packages/ui/src/main.ts'))
  write(join(repo, 'packages/ui/dist/assets/index-3f2a1c.js'))
  prune(repo)
  assert.ok(existsSync(join(repo, 'packages/ui/dist/assets/index-3f2a1c.js')))
})

test('what only the compiler knows it writes stays: a JavaScript source under allowJs', (t) => {
  // No suffix rule reads `legacy.d.ts` back to `legacy.js`, so the compiler's
  // own list of outputs is the one thing that keeps it.
  const repo = checkout(t, ['src/legacy.js', ...outputs('dist/src/legacy')])
  const allowJs = { ...PACKAGE, compilerOptions: { ...PACKAGE.compilerOptions, allowJs: true }, include: ['src/**/*.js'] }
  write(join(repo, 'packages/demo/tsconfig.json'), JSON.stringify(allowJs))
  assert.deepEqual(prune(repo), { projects: 1, removed: [], missing: [] })
})

test('a package reached only through another package’s references is pruned too', (t) => {
  // `tsc -b` builds the whole graph, so its orphans are the build's orphans.
  // This reference names the file, the other form tsc takes; the root's
  // names a directory.
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index')])
  write(join(repo, 'packages/demo/tsconfig.json'), JSON.stringify({ ...PACKAGE, references: [{ path: '../lib/tsconfig.json' }] }))
  write(join(repo, 'packages/lib/tsconfig.json'), JSON.stringify(PACKAGE))
  write(join(repo, 'packages/lib/src/index.ts'))
  for (const file of [...outputs('dist/src/index'), ...outputs('dist/src/gone')]) write(join(repo, 'packages/lib', file))
  const { removed } = prune(repo)
  assert.deepEqual(removed.map((file) => relative(repo, file)).sort(), outputs('packages/lib/dist/src/gone').sort())
})

test('an output the compiler writes and dist does not hold is reported', (t) => {
  const repo = checkout(t, ['test/lost.test.ts', 'dist/test/lost.test.js.map', 'dist/test/lost.test.d.ts', 'dist/test/lost.test.d.ts.map'])
  assert.deepEqual(inDemo(repo, prune(repo).missing), ['dist/test/lost.test.js'])
})

test('the step fails on a missing output and names the way back; it passes on a whole dist', (t) => {
  const lost = checkout(t, ['test/lost.test.ts', ...outputs('dist/test/orphan.test')])
  const out = sink()
  const err = sink()
  assert.equal(main(lost, out, err), 1)
  assert.match(err.text, /packages\/demo\/dist\/test\/lost\.test\.js\n/)
  assert.match(err.text, /pnpm exec tsc -b --force/)
  // It still prunes, and says so, when it is about to fail.
  assert.match(out.text, /packages\/demo\/dist\/test\/orphan\.test\.js\n/)

  const whole = checkout(t, ['test/kept.test.ts', ...outputs('dist/test/kept.test')])
  const quiet = sink()
  assert.equal(main(whole, sink(), quiet), 0)
  assert.equal(quiet.text, '')
})

test('a package that has never been built has everything missing and nothing to remove', (t) => {
  const repo = checkout(t, ['src/index.ts'])
  const { removed, missing } = prune(repo)
  assert.deepEqual(removed, [])
  assert.deepEqual(inDemo(repo, missing), outputs('dist/src/index').sort())
})

test('dist itself stays when the last thing in it goes', (t) => {
  // The walk up from an emptied directory stops below dist. Without that
  // bound it keeps going for as long as it finds nothing, and dist is next.
  const repo = checkout(t, ['src/index.ts', 'dist/test/gone.test.js'])
  assert.deepEqual(inDemo(repo, prune(repo).removed), ['dist/test/gone.test.js'])
  assert.equal(has(repo, 'dist/test'), false)
  assert.ok(has(repo, 'dist'))
})

test('every removal is named; a long list of missing outputs is cut at twenty and counted', (t) => {
  // What was deleted is always said in full. What is missing can be a whole
  // package's worth, where twenty names and a count say as much.
  const repo = checkout(t, Array.from({ length: 6 }, (_, n) => [`src/m${n}.ts`, ...outputs(`dist/src/gone${n}`)]).flat())
  const out = sink()
  const err = sink()
  assert.equal(main(repo, out, err), 1)
  assert.equal((out.text.match(/^ {2}packages\/demo\/dist\/src\/gone\d/gm) ?? []).length, 24)
  assert.equal((err.text.match(/^ {2}packages\/demo\/dist\/src\/m\d/gm) ?? []).length, 20)
  assert.match(err.text, /^ {2}… and 4 more$/m)
})

test('a project that sets outDir and not rootDir is refused, not guessed at', (t) => {
  // dist is read back to its sources through both, and a guessed rootDir is
  // how a live output would come to be read as an orphan.
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index')])
  const { rootDir: _rootDir, ...options } = PACKAGE.compilerOptions
  write(join(repo, 'packages/demo/tsconfig.json'), JSON.stringify({ ...PACKAGE, compilerOptions: options }))
  assert.throws(() => prune(repo), /packages\/demo\/tsconfig\.json sets outDir and not rootDir/)
})

test('a config the compiler cannot parse is refused, naming it', (t) => {
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index')])
  write(join(repo, 'packages/demo/tsconfig.json'), JSON.stringify({ ...PACKAGE, compilerOptions: { ...PACKAGE.compilerOptions, notAnOption: true } }))
  assert.throws(() => prune(repo), /packages\/demo\/tsconfig\.json does not parse:\n.*notAnOption/)
})

test('run as a command, it prunes the checkout it is handed and exits 1 on what is missing', (t) => {
  const repo = checkout(t, ['test/lost.test.ts', ...outputs('dist/test/orphan.test')])
  const run = command(SCRIPT, repo)
  assert.equal(run.status, 1, run.stderr)
  assert.match(run.stdout, /^ {2}packages\/demo\/dist\/test\/orphan\.test\.js$/m)
  assert.match(run.stderr, /^ {2}packages\/demo\/dist\/test\/lost\.test\.js$/m)
})

test('reached through a symlink, the command still runs rather than exiting 0 having done nothing', (t) => {
  // Node resolves this module's own URL through the link and leaves argv[1]
  // as it was typed. A guard comparing the two as they come is false, and the
  // build step turns into a no-op that reports success. A copy under /tmp is
  // the same case on macOS, where /tmp is itself a link.
  const repo = checkout(t, ['test/lost.test.ts', ...outputs('dist/test/orphan.test')])
  const link = join(repo, 'prune-dist-link.mjs')
  symlinkSync(SCRIPT, link)
  const run = command(link, repo)
  assert.equal(run.status, 1, run.stderr)
  assert.match(run.stdout, /^ {2}packages\/demo\/dist\/test\/orphan\.test\.js$/m)
})

test('every script that builds for the tests runs this, after the compiler', () => {
  // Nothing else calls it, so a merge that rewrites `build:node` without it
  // takes the whole guard out with every other test here still green. Before
  // the compiler it would be worse: each new source would read as missing.
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const steps = scripts['build:node'].split('&&').map((step) => step.trim())
  assert.ok(steps.includes('tsc -b'), scripts['build:node'])
  assert.ok(steps.indexOf('node script/prune-dist.mjs') > steps.indexOf('tsc -b'), scripts['build:node'])
  for (const name of ['build', 'test']) assert.match(scripts[name], /^pnpm run build:node && /, name)
})

test('against the real compiler: what tsc -b leaves behind goes, and what it will not put back is reported', (t) => {
  const repo = checkout(t)
  const demo = join(repo, 'packages/demo')
  const tsc = () => execFileSync(process.execPath, [TSC, '-b', repo], { stdio: 'pipe' })
  write(join(demo, 'src/index.ts'), 'export const answer = 42\n')
  write(join(demo, 'test/kept.test.ts'), "import { answer } from '../src/index.js'\nexport const kept = answer\n")
  write(join(demo, 'test/gone.test.ts'), "import { answer } from '../src/index.js'\nexport const gone = answer\n")
  tsc()
  rmSync(join(demo, 'test/gone.test.ts'))
  tsc()
  // The premise, measured here rather than assumed: the compiler rebuilt the
  // project without the deleted test and left its output where it was.
  assert.ok(has(repo, 'dist/test/gone.test.js'), 'tsc -b now removes an orphan itself; this step may have outlived its reason')

  const first = prune(repo)
  assert.deepEqual(inDemo(repo, first.removed), outputs('dist/test/gone.test').sort())
  assert.deepEqual(first.missing, [])
  for (const file of [...outputs('dist/test/kept.test'), ...outputs('dist/src/index')]) assert.ok(has(repo, file), file)

  // The other premise: an output that goes missing is not rebuilt, so it has
  // to be reported, and the message's `--force` is the way back.
  rmSync(join(demo, 'dist/test/kept.test.js'))
  tsc()
  assert.equal(has(repo, 'dist/test/kept.test.js'), false, 'tsc -b now re-emits a missing output; the failure message can say less')
  assert.deepEqual(inDemo(repo, prune(repo).missing), ['dist/test/kept.test.js'])
  execFileSync(process.execPath, [TSC, '-b', '--force', repo], { stdio: 'pipe' })
  assert.deepEqual(prune(repo), { projects: 1, removed: [], missing: [] })
})
