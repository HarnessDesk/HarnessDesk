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
 *   else and is left where it is, `.tsbuildinfo` included.
 *
 * And the other direction, because a gap there is silent too. A glob that
 * matches less still passes — `node --test` over a glob that matches nothing
 * says "tests 0" and exits 0 — and `tsc -b` does not put back an output that
 * went missing: it reads the project as up to date from its `.tsbuildinfo`,
 * and touching the source does not help while its content is unchanged. A
 * test output deleted by hand, or by a mistake in this file, would stop
 * running without a word and stay stopped. So every output the compiler lists
 * for the sources it was given has to be on disk, or this fails and names it.
 */

import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
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

const host = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  },
}

const configOf = (path) => (path.endsWith('.json') ? path : join(path, 'tsconfig.json'))

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
      throw new Error(`${relative(repo, file)} does not parse:\n${detail.join('\n')}`)
    }
    parsed.set(file, project)
    for (const reference of project.projectReferences ?? []) queue.push(configOf(reference.path))
  }
  const built = [...parsed].filter(([, project]) => project.options.outDir != null && !project.options.noEmit)
  for (const [file, project] of built) {
    if (project.options.rootDir == null) {
      throw new Error(`${relative(repo, file)} sets outDir and not rootDir, and dist is read back to its sources through both`)
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
  const { outDir, rootDir } = project.options
  const ignoreCase = !ts.sys.useCaseSensitiveFileNames
  const expected = new Set(project.fileNames.flatMap((file) => ts.getOutputFileNames(project, file, ignoreCase)))
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

/** A directory the prune emptied goes too, up to `dist` itself. */
const removeEmpty = (dir, outDir) => {
  for (let at = dir; at.startsWith(outDir + sep) && readdirSync(at).length === 0; at = dirname(at)) rmdirSync(at)
}

export function prune(repo) {
  const projects = projectsOf(repo)
  const removed = []
  const missing = []
  for (const project of projects) {
    const found = audit(project)
    for (const file of found.orphans) {
      rmSync(file)
      removeEmpty(dirname(file), project.options.outDir)
      removed.push(file)
    }
    missing.push(...found.missing)
  }
  return { projects: projects.length, removed, missing }
}

const listed = (repo, files, cap = 20) =>
  files
    .slice(0, cap)
    .map((file) => `  ${relative(repo, file)}\n`)
    .join('') + (files.length > cap ? `  … and ${files.length - cap} more\n` : '')

/** The build step: prune, say what went, and fail on anything missing. Returns the exit code. */
export function main(repo, out = process.stdout, err = process.stderr) {
  const { projects, removed, missing } = prune(repo)
  if (removed.length === 0) {
    out.write(`Pruned dist for ${projects} package(s): nothing had outlived its source.\n`)
  } else {
    out.write(`Pruned dist for ${projects} package(s), removing what no source builds any more:\n`)
    out.write(listed(repo, removed, Infinity))
  }
  if (missing.length === 0) return 0
  err.write(
    'The compiler writes these for sources that exist, and they are not in dist:\n\n' +
      listed(repo, missing) +
      '\n`tsc -b` will not put them back: it reads each project as up to date from its\n' +
      '.tsbuildinfo. And a compiled test that is not there does not fail anything —\n' +
      'the test glob just stops matching it. Rebuild with `pnpm exec tsc -b --force`.\n',
  )
  return 1
}

/* Imported by its test, so importing it must not prune the checkout. Same
   guard as `check-layering.mjs`. */
const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) process.exitCode = main(root)
