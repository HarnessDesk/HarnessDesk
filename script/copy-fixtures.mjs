#!/usr/bin/env node
/**
 * Copies non-TypeScript test fixtures into the compiled output.
 *
 * `tsc` only emits what it compiles, and some fixtures are deliberately not
 * TypeScript — the fake Codex binary has to be an executable script that
 * `spawn` can run, so the tests exercise the real process path.
 *
 * It only ever adds. A fixture deleted from `test/fixtures` is taken out of
 * `dist` by `prune-dist.mjs`, which runs after this.
 */
import { chmodSync, cpSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where a package's fixtures live, and where under `dist` they are copied to:
 * the same path. `prune-dist.mjs` keeps a copy only while its original sits
 * here, so the two steps have to mean the same place — and they agreed by
 * convention alone until this constant (#222).
 */
export const FIXTURES = join('test', 'fixtures')

/** Copies every package's fixtures into its `dist`. Answers how many packages had any. */
export function copyFixtures(repo) {
  let copied = 0
  for (const pkg of readdirSync(join(repo, 'packages'))) {
    const from = join(repo, 'packages', pkg, FIXTURES)
    const to = join(repo, 'packages', pkg, 'dist', FIXTURES)
    if (!existsSync(from)) continue
    cpSync(from, to, {
      recursive: true,
      // `.ts` fixtures are compiled by tsc; copying the sources over the output
      // would shadow them with files Node cannot run.
      filter: (source) => statSync(source).isDirectory() || !source.endsWith('.ts'),
    })
    for (const entry of readdirSync(to)) {
      if (entry.endsWith('.mjs')) chmodSync(join(to, entry), 0o755)
    }
    copied += 1
  }
  return copied
}

/* Imported by its test, so importing it must not copy anything — the guard
   `prune-dist.mjs` has, compared as real paths, so a run through a symlink is
   still the command. */
const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
if (process.argv[1] != null && real(resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) {
  const repo = process.argv[2] == null ? root : resolve(process.argv[2])
  console.log(`Copied fixtures for ${copyFixtures(repo)} package(s).`)
}
