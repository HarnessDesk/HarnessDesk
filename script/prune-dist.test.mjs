import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { copyFixtures } from './copy-fixtures.mjs'
import { audit, filesUnder, globToRegExp, main, projectsOf, prune, remove, TEST_GLOB } from './prune-dist.mjs'

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

/** What `prune` answers for a one-package checkout it finds nothing wrong with. */
const CLEAN = { projects: 1, removed: [], missing: [], rebuild: [], unowned: [] }

/** A directory entry the way `readdirSync(…, { withFileTypes: true })` hands one back. */
const dirent = (name, kind) => ({ name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir' })

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

test('a test rewritten by hand from .ts to .js does not keep its stale compiled output alive', (t) => {
  // Outside the fixtures a same-path twin is a source, not the original of a
  // copy: the hand-written test/foo.test.js does not make the compiled
  // dist/test/foo.test.js, built from a foo.test.ts that is gone, its copy.
  // The fixture copy beside it is the control.
  const repo = checkout(t, [
    'test/kept.test.ts',
    ...outputs('dist/test/kept.test'),
    'test/foo.test.js',
    ...outputs('dist/test/foo.test'),
    'test/fixtures/agent.mjs',
    'dist/test/fixtures/agent.mjs',
  ])
  assert.deepEqual(inDemo(repo, prune(repo).removed), outputs('dist/test/foo.test').sort())
  assert.ok(has(repo, 'dist/test/fixtures/agent.mjs'))
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
  // but the root's reference list keeps it out. And with no compiled tests in
  // it, it is nothing the test glob runs either, so it is not refused.
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index')])
  write(join(repo, 'packages/ui/tsconfig.json'), JSON.stringify(PACKAGE))
  write(join(repo, 'packages/ui/src/main.ts'))
  write(join(repo, 'packages/ui/dist/assets/index-3f2a1c.js'))
  assert.deepEqual(prune(repo).unowned, [])
  assert.ok(existsSync(join(repo, 'packages/ui/dist/assets/index-3f2a1c.js')))
})

test('what only the compiler knows it writes stays: a JavaScript source under allowJs', (t) => {
  // No suffix rule reads `legacy.d.ts` back to `legacy.js`, so the compiler's
  // own list of outputs is the one thing that keeps it.
  const repo = checkout(t, ['src/legacy.js', ...outputs('dist/src/legacy')])
  const allowJs = { ...PACKAGE, compilerOptions: { ...PACKAGE.compilerOptions, allowJs: true }, include: ['src/**/*.js'] }
  write(join(repo, 'packages/demo/tsconfig.json'), JSON.stringify(allowJs))
  assert.deepEqual(prune(repo), CLEAN)
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
  // A compiled test is among what is missing, so the failure says what that
  // costs, and the way back names the one project to rebuild.
  assert.match(err.text, /the test\s+glob just stops matching it/)
  assert.match(err.text, /`pnpm exec tsc -b --force packages\/demo`/)
  // It still prunes, and says so, when it is about to fail.
  assert.match(out.text, /packages\/demo\/dist\/test\/orphan\.test\.js\n/)

  const whole = checkout(t, ['test/kept.test.ts', ...outputs('dist/test/kept.test')])
  const quiet = sink()
  assert.equal(main(whole, sink(), quiet), 0)
  assert.equal(quiet.text, '')
})

test('the failure explains a skipped test only when a compiled test is among what is missing', (t) => {
  // A missing map or declaration is not a test the glob will skip, and the
  // failure should not say it is.
  const repo = checkout(t, ['test/kept.test.ts', 'dist/test/kept.test.js', 'dist/test/kept.test.d.ts', 'dist/test/kept.test.d.ts.map'])
  const err = sink()
  assert.equal(main(repo, sink(), err), 1)
  assert.match(err.text, /^ {2}packages\/demo\/dist\/test\/kept\.test\.js\.map$/m)
  assert.doesNotMatch(err.text, /test\s+glob/)
})

test('among many missing outputs, the compiled tests are the ones named first', (t) => {
  // The list is cut at twenty, and dist/src sorts before dist/test. Without
  // the ordering, the sentence about a skipped test would stand under twenty
  // paths, none of which is a test.
  const repo = checkout(t, [...Array.from({ length: 8 }, (_, n) => `src/m${n}.ts`), 'test/only.test.ts'])
  const err = sink()
  assert.equal(main(repo, sink(), err), 1)
  assert.equal(err.text.split('\n').find((line) => line.startsWith('  packages/')), '  packages/demo/dist/test/only.test.js')
  assert.match(err.text, /the test\s+glob just stops matching it/)
  assert.match(err.text, /^ {2}… and 16 more$/m)
})

test('a source that arrived after the build is not said to be one the compiler will never rebuild', (t) => {
  // Measured: build, then add a source, then prune. Its output is missing, and
  // a plain `tsc -b` compiles it, so the failure must not claim that only
  // --force can. It names both routes, and the command that covers both.
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index'), 'test/fresh.test.ts'])
  const err = sink()
  assert.equal(main(repo, sink(), err), 1)
  assert.match(err.text, /A source that arrived after the build\s+started is compiled by the next one/)
  assert.match(err.text, /`pnpm exec tsc -b --force packages\/demo` rebuilds them either way/)
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

test('a directory another build removes while this one lists dist is read as empty, and any other error is not', () => {
  // Listing dist names a directory, and reading it comes after. A second
  // build's prune can remove it in between: with real files that is a coin
  // toss, so the listing is played here. `retired` is named, then gone.
  const failing = (code) => Object.assign(new Error(code), { code })
  const listing = (then) => (at) => {
    if (at === join('/d')) return [dirent('kept.js', 'file'), dirent('retired', 'dir')]
    if (at === join('/d', 'retired')) throw then
    throw new Error(`nothing else is read: ${at}`)
  }
  assert.deepEqual(filesUnder('/d', listing(failing('ENOENT'))), [join('/d', 'kept.js')])
  // The control: a directory that is there and cannot be read is a real
  // failure, and still says so.
  assert.throws(() => filesUnder('/d', listing(failing('EACCES'))), /EACCES/)
})

test('what another build has already removed is not an error when this one comes to remove it', (t) => {
  // The other half of the same race: both builds listed the same orphans, and
  // the other got to them first.
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index'), ...outputs('dist/src/retired/old')])
  const [project] = projectsOf(repo)
  const { orphans } = audit(project)
  assert.equal(orphans.length, 4)
  rmSync(join(repo, 'packages/demo/dist/src/retired'), { recursive: true })
  assert.doesNotThrow(() => remove(orphans, join(repo, 'packages/demo/dist')))
  assert.ok(has(repo, 'dist/src/index.js'))
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

test('compiled tests in a package the build no longer compiles are refused, and left where they are', (t) => {
  // The runners glob every package's dist/test, and this step reads only the
  // reference graph, so a package dropped from the references, or deleted
  // with its ignored dist left behind, would run its compiled tests for ever.
  // Nothing here wrote them, so they are named rather than deleted.
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index')])
  write(join(repo, 'packages/retired/dist/test/old.test.js'))
  const err = sink()
  assert.equal(main(repo, sink(), err), 1)
  assert.match(err.text, /^ {2}packages\/retired\/dist$/m)
  assert.ok(existsSync(join(repo, 'packages/retired/dist/test/old.test.js')))
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

test('a refusal reaches the build as a sentence, not a stack trace', (t) => {
  const repo = checkout(t, ['src/index.ts', ...outputs('dist/src/index')])
  write(join(repo, 'packages/demo/tsconfig.json'), JSON.stringify({ ...PACKAGE, compilerOptions: { ...PACKAGE.compilerOptions, notAnOption: true } }))
  const run = command(SCRIPT, repo)
  assert.equal(run.status, 1, run.stderr)
  assert.match(run.stderr, /^packages\/demo\/tsconfig\.json does not parse:$/m)
  assert.doesNotMatch(run.stderr, /^\s+at /m)
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
  assert.deepEqual(prune(repo), CLEAN)

  /* And both halves of the scope that failure's sentence now carries (review
     of #191). A source that arrived after a build is compiled by the next
     one, so it is never one this step calls unbuildable: */
  write(join(demo, 'test/late.test.ts'), "import { answer } from '../src/index.js'\nexport const late = answer\n")
  tsc()
  assert.ok(has(repo, 'dist/test/late.test.js'), 'a source written after the build is compiled by the next one')
  /* and an output whose source was already built does come back, when
     something it imports changes what it declares, which is what rebuilds the
     files that import it. */
  rmSync(join(demo, 'dist/test/late.test.js'))
  write(join(demo, 'src/index.ts'), 'export const answer = 42\nexport const named = \'two\'\n')
  tsc()
  assert.ok(has(repo, 'dist/test/late.test.js'), 'a change in what an import declares rebuilds the files that import it')
})

test('the copy step and the prune agree on where a fixture goes (#222)', (t) => {
  // A source of its own as well: a package with nothing to compile is a config the compiler refuses.
  const repo = checkout(t, ['test/fixtures/harness.ts', ...outputs('dist/test/fixtures/harness'), 'test/fixtures/fake.mjs', 'test/fixtures/deep/data.json'])
  assert.equal(copyFixtures(repo), 1, 'the package had fixtures to copy')
  for (const file of ['dist/test/fixtures/fake.mjs', 'dist/test/fixtures/deep/data.json']) assert.ok(has(repo, file), file)
  assert.deepEqual(prune(repo), CLEAN, 'a copy whose original is still there is not an orphan')
  // The control: the copy of a fixture that is gone is one.
  rmSync(join(repo, 'packages/demo/test/fixtures/fake.mjs'))
  assert.deepEqual(inDemo(repo, prune(repo).removed), ['dist/test/fixtures/fake.mjs'])
})

test('an output whose source another build deleted between the two is not called missing (review of #191)', (t) => {
  const repo = checkout(t, ['src/kept.ts', 'src/gone.ts', ...outputs('dist/src/kept'), ...outputs('dist/src/gone')])
  // The compiler's answer, taken before the other build moved.
  const [project] = projectsOf(repo)
  rmSync(join(repo, 'packages/demo/src/gone.ts'))
  for (const file of outputs('dist/src/gone')) rmSync(join(repo, 'packages/demo', file))
  assert.deepEqual(audit(project).missing, [], 'nothing on disk compiles to it any more')
  // The control: one whose source is still there is missing, and named.
  rmSync(join(repo, 'packages/demo/dist/src/kept.js'))
  assert.deepEqual(inDemo(repo, audit(project).missing), ['dist/src/kept.js'])
})

test('the test glob reads the same as the paths it is written for (#256)', () => {
  const runs = (path) => globToRegExp(TEST_GLOB).test(join(...path.split('/')))
  assert.equal(runs('packages/server/dist/test/wire.test.js'), true)
  assert.equal(runs('packages/server/dist/test/deep/nested/wire.test.js'), true, 'at any depth under test')
  assert.equal(runs('packages/server/dist/src/wire.test.js'), false, 'not outside test')
  assert.equal(runs('packages/server/test/wire.test.js'), false, 'not the source')
  assert.equal(runs('packages/a/b/dist/test/x.test.js'), false, 'one package deep')
  assert.equal(runs('packages/server/dist/test/helper.js'), false, 'only a .test.js')
})
