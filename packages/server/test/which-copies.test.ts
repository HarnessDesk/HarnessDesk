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

test('no package asks /usr/bin/which (#129)', () => {
  // Absent on Windows and on minimal images, and at /bin/which on some Linux: there, every agent read as not installed.
  const root = join(checkout(), 'packages')
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(?:ts|mts|mjs|js)$/.test(entry.name) && /['"]\/usr\/bin\/which['"]/.test(readFileSync(path, 'utf8'))) offenders.push(path)
    }
  }
  for (const pkg of readdirSync(root)) if (existsSync(join(root, pkg, 'src'))) walk(join(root, pkg, 'src'))
  assert.deepEqual(offenders, [])
})
