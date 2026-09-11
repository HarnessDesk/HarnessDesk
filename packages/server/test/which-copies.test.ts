import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/** This file runs from `dist/test`, so find the checkout rather than count `..`. */
const checkout = (): string => {
  let root = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const up = dirname(root)
    assert.notEqual(up, root, 'ran outside the checkout')
    root = up
  }
  return root
}

test('the PATH walk is one text in the three packages that need it (#129)', () => {
  const read = (path: string) => readFileSync(join(checkout(), path), 'utf8')
  const server = read('packages/server/src/installs/which.ts')
  assert.equal(read('packages/adapter-acp/src/which.ts'), server, 'adapter-acp has drifted from the server copy')
  assert.equal(read('packages/codex/src/which.ts'), server, 'codex has drifted from the server copy')
})

test('nothing this checkout runs asks /usr/bin/which (#129)', () => {
  // Absent on Windows and on minimal images, and at /bin/which on some Linux: there, every agent read as not installed.
  // Every package's source and the desktop's main process, which has no src, and the scripts; `.cjs` and a template
  // literal's backticks too (review of #228, round 1). A comment may name the path.
  const root = checkout()
  const offenders: string[] = []
  let scanned = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(?:ts|mts|cts|tsx|mjs|cjs|js)$/.test(entry.name)) {
        scanned += 1
        const code = readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
        if (code.some((line) => /['"`]\/usr\/bin\/which['"`]/.test(line))) offenders.push(path)
      }
    }
  }
  for (const pkg of readdirSync(join(root, 'packages'))) {
    for (const part of ['src', 'electron']) {
      if (existsSync(join(root, 'packages', pkg, part))) walk(join(root, 'packages', pkg, part))
    }
  }
  walk(join(root, 'script'))
  // A walk that read nothing would pass on nothing.
  assert.ok(scanned > 500, `only ${scanned} files were read`)
  assert.deepEqual(offenders, [])
})
