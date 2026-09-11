#!/usr/bin/env node
/**
 * Takes out of `dist` what the compiler built from a source that is gone, and
 * refuses a build whose `dist` is missing something the compiler writes.
 *
 * `tsc -b` only ever writes. Delete or rename a source and its `.js`, its
 * `.d.ts` and both maps stay in `dist` for as long as the checkout does — and
 * `tsc -b --clean`, which is what `pnpm clean` runs, removes the outputs of
 * the sources that *exist*, so it leaves exactly the orphans behind. In `src`
 * that is dead code. In `test` it is a test: every runner here globs the
 * compiled tests under each package's `dist/test`, which is what was built
 * rather than what exists, so a test deleted upstream goes on running from
 * `dist` in any checkout built before the deletion reached it, against code
 * that has moved on. CI builds from a fresh checkout and never sees it.
 *
 * Measured 2026-09-10: #136 deleted `packages/server/test/attribution-room.test.ts`,
 * and a worktree built before it and rebased after went on failing "a post
 * to a room carries the desk's attribution to the member once" — a red test,
 * on a branch that never touched it, for code that no longer existed.
 *
 * So this runs at the end of `build:node` and holds each package's `dist` to
 * what a build from a fresh checkout writes. A file there is removed only
 * when all of these are true:
 *
 * - the compiler, asked about every source it was given, does not list it as
 *   an output;
 * - no source that compiles to it is on disk — `x.js` from `x.ts` or `x.tsx`,
 *   `x.mjs` from `x.mts` — which is the net under the first, for a file the
 *   compiler reaches by an import rather than through `include`;
 * - nothing sits at the same path in the package, which is how a copied
 *   fixture is known: `copy-fixtures.mjs` copies each one to its own path;
 * - it is something this build writes at all: a kind of file `tsc` emits, or
 *   a copy under `test/fixtures`. Anything else in `dist` belongs to someone
 *   else and is left where it is, `.tsbuildinfo` included. (A copied fixture
 *   that still exists is kept by the rule before this one, whatever its kind;
 *   this one only says which of the files nothing keeps are this build's.)
 *
 * And the other direction, because a gap there is silent too. A glob that
 * matches less still passes — `node --test` over a glob that matches nothing
 * says "tests 0" and exits 0 — and `tsc -b` does not put back an output that
 * went missing: it reads the project as up to date from its `.tsbuildinfo`,
 * and touching the source does not help while its content is unchanged. A
 * test output deleted by hand, or by a mistake in this file, would stop
 * running without a word and stay stopped. So every output the compiler lists
 * for the sources it was given has to be on disk, or this fails and names it.
 * It never repairs one instead: a prune that rebuilt what it found missing
 * would be a second build hidden inside the first, erasing the one trace of
 * its own mistakes. This check is what makes a build step that deletes files
 * acceptable at all.
 *
 * One thing more reaches the test glob than the reference graph: a package
 * dropped from the references, or deleted with its `dist` left behind (`dist`
 * is ignored, so deleting a package leaves it), keeps compiled tests that the
 * glob runs and nothing rebuilds. Nothing here wrote them, so this does not
 * delete them either. It fails, and names the directory.
 *
 * The build runs it as `node script/prune-dist.mjs`. Handed a path, it prunes
 * that checkout instead of its own, which is how to put right one whose
 * `build:node` predates this step.
 */

import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * What `tsc` writes and what it writes it from, turned round so an output can
 * ask after its source. None of these suffixes ends another, so the first one
 * a name ends with is the only one it ends with.
 */
const EMITS = [
  [['.ts', '.tsx'], ['.js', '.js.map', '.d.ts', '.d.ts.map']],
  [['.tsx'], ['.jsx', '.jsx.map']],
  [['.mts'], ['.mjs', '.mjs.map', '.d.mts', '.d.mts.map']],
  [['.cts'], ['.cjs', '.cjs.map', '.d.cts', '.d.cts.map']],
].flatMap(([sources, outputs]) => outputs.map((output) => [output, sources]))

/** Where `copy-fixtures.mjs` copies to: the same path under `dist` as under the package. */
const COPIED = join('test', 'fixtures') + sep

/** A path, relative to the repo, that the test runners' glob runs: a `.test.js` under a package's `dist/test`. */
const runByTheGlob = (path) => /^packages[\\/][^\\/]+[\\/]dist[\\/]test[\\/].+\.test\.js$/.test(path)

/**
 * Something this cannot decide, said as a sentence for whoever runs the
 * build. Anything else thrown from here is a bug, and keeps its stack.
 */
class Refusal extends Error {}

const host = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    throw new Refusal(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  },
}

const configOf = (path) => (path.endsWith('.json') ? path : join(path, 'tsconfig.json'))

/**
 * TypeScript hands back every path with forward slashes, on every platform,
 * and the paths it is compared with here are built by Node with the
 * platform's own separator. `resolve` puts the compiler's into Node's form,
 * and changes nothing where the two already agree.
 */
const native = (path) => resolve(path)

/**
 * Every project `tsc -b` builds from the repo's `tsconfig.json`, its
 * references followed all the way down and each parsed the way the compiler
 * parses it.
 *
 * That reference list is the only thing trusted to say which packages the
 * compiler owns, and it matters which: `packages/ui` is not on it, and its
 * `dist` is a Vite bundle of hashed `.js` with no source of the same name
 * anywhere — every file of which the rule above would call an orphan.
 */
export function projectsOf(repo) {
  const parsed = new Map()
  const queue = [configOf(repo)]
  while (queue.length > 0) {
    const file = queue.shift()
    if (parsed.has(file)) continue
    const project = ts.getParsedCommandLineOfConfigFile(file, undefined, host)
    if (project.errors.length > 0) {
      const detail = project.errors.map((one) => ts.flattenDiagnosticMessageText(one.messageText, '\n'))
      throw new Refusal(`${relative(repo, file)} does not parse:\n${detail.join('\n')}`)
    }
    parsed.set(file, project)
    for (const reference of project.projectReferences ?? []) queue.push(configOf(reference.path))
  }
  const built = [...parsed].filter(([, project]) => project.options.outDir != null && !project.options.noEmit)
  for (const [file, project] of built) {
    if (project.options.rootDir == null) {
      throw new Refusal(`${relative(repo, file)} sets outDir and not rootDir, and dist is read back to its sources through both`)
    }
  }
  return built.map(([, project]) => project)
}

const filesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))

/** What one project's `dist` holds that nothing accounts for, and what the compiler writes there that it does not hold. */
export function audit(project) {
  const outDir = native(project.options.outDir)
  const rootDir = native(project.options.rootDir)
  const ignoreCase = !ts.sys.useCaseSensitiveFileNames
  const expected = new Set(project.fileNames.flatMap((file) => ts.getOutputFileNames(project, file, ignoreCase)).map(native))
  const missing = [...expected].filter((file) => !existsSync(file)).sort()
  if (!existsSync(outDir)) return { orphans: [], missing }

  const orphans = filesUnder(outDir).filter((file) => {
    if (expected.has(file)) return false
    const path = relative(outDir, file)
    if (existsSync(join(rootDir, path))) return false
    const emitted = EMITS.find(([output]) => path.endsWith(output))
    if (emitted == null) return path.startsWith(COPIED)
    const [output, sources] = emitted
    const stem = path.slice(0, -output.length)
    return !sources.some((source) => existsSync(join(rootDir, stem + source)))
  })
  return { orphans: orphans.sort(), missing }
}

/** Walks up from a directory the prune emptied, removing each one left empty, and stops below `dist`. */
const removeEmpty = (dir, outDir) => {
  for (let at = dir; at.startsWith(outDir + sep); at = dirname(at)) {
    try {
      if (readdirSync(at).length > 0) return
      rmdirSync(at)
    } catch {
      // Gone already, or filled again: another build has this walk.
      return
    }
  }
}

/**
 * Removes what `audit` found, and the directories that leaves empty. A file
 * or directory that is already gone is not an error: several agents build in
 * one checkout here, and two builds pruning the same `dist` at once find the
 * same orphans. Whichever gets to one first has done the job.
 */
export function remove(files, outDir) {
  for (const file of files) {
    rmSync(file, { force: true })
    removeEmpty(dirname(file), outDir)
  }
}

/**
 * Every package `dist` the test runners' glob reaches into: one whose `test`
 * holds a compiled test. The glob runs over every package directory, which
 * is wider than the reference graph this step trusts for everything else.
 */
const distsTheGlobReaches = (repo) => {
  const packages = join(repo, 'packages')
  if (!existsSync(packages)) return []
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packages, entry.name, 'dist'))
    .filter((dist) => existsSync(join(dist, 'test')) && filesUnder(join(dist, 'test')).some((file) => file.endsWith('.test.js')))
    .sort()
}

export function prune(repo) {
  const projects = projectsOf(repo)
  const removed = []
  const missing = []
  const rebuild = []
  for (const project of projects) {
    const found = audit(project)
    remove(found.orphans, native(project.options.outDir))
    removed.push(...found.orphans)
    missing.push(...found.missing)
    if (found.missing.length > 0) rebuild.push(relative(repo, dirname(project.options.configFilePath)))
  }
  const owned = new Set(projects.map((project) => native(project.options.outDir)))
  const unowned = distsTheGlobReaches(repo).filter((dist) => !owned.has(dist))
  return { projects: projects.length, removed, missing, rebuild, unowned }
}

const listed = (repo, files, cap = 20) =>
  files
    .slice(0, cap)
    .map((file) => `  ${relative(repo, file)}\n`)
    .join('') + (files.length > cap ? `  … and ${files.length - cap} more\n` : '')

/** The build step: prune, say what went, and fail on anything missing or unowned. Returns the exit code. */
export function main(repo, out = process.stdout, err = process.stderr) {
  const { projects, removed, missing, rebuild, unowned } = prune(repo)
  if (removed.length === 0) {
    out.write(`Pruned dist for ${projects} package(s): nothing had outlived its source.\n`)
  } else {
    out.write(`Pruned dist for ${projects} package(s), removing what no source builds any more:\n`)
    out.write(listed(repo, removed, Infinity))
  }
  if (missing.length > 0) {
    const tests = missing.some((file) => runByTheGlob(relative(repo, file)))
    err.write(
      'The compiler writes these for sources that exist, and they are not in dist:\n\n' +
        listed(repo, missing) +
        '\n`tsc -b` will not put them back: it reads each project as up to date from its\n' +
        (tests
          ? '.tsbuildinfo. And a compiled test that is not there fails nothing: the test\nglob just stops matching it. '
          : '.tsbuildinfo. ') +
        `Rebuild with \`pnpm exec tsc -b --force ${rebuild.join(' ')}\`.\n`,
    )
  }
  if (unowned.length > 0) {
    err.write(
      'These hold compiled tests the test glob runs, and no project the build compiles\nwrites them:\n\n' +
        listed(repo, unowned, Infinity) +
        '\nNothing rebuilds them, so their tests run against code that has moved on. If the\n' +
        'package is gone, delete its dist; if it should still be built, add it back to the\n' +
        'references in tsconfig.json.\n',
    )
  }
  return missing.length > 0 || unowned.length > 0 ? 1 : 0
}

/* Imported by its test, so importing it must not prune the checkout — the
   guard `check-layering.mjs` has, but compared as real paths. Node resolves
   this module's own URL through every symlink and leaves argv[1] as it was
   typed, so compared as they come the two differ whenever the command is
   reached through a link, and the step does nothing at all and exits 0. */
const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const isMain = process.argv[1] != null && real(resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    process.exitCode = main(process.argv[2] == null ? root : resolve(process.argv[2]))
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
