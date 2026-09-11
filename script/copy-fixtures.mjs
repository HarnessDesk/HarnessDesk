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
import { chmodSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packages = readdirSync(join(root, 'packages'))

let copied = 0
for (const pkg of packages) {
  const from = join(root, 'packages', pkg, 'test/fixtures')
  const to = join(root, 'packages', pkg, 'dist/test/fixtures')
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
console.log(`Copied fixtures for ${copied} package(s).`)
