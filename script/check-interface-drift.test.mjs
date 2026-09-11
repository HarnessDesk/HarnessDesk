import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { TOKEN_SOURCES } from './design-tokens.mjs'

/**
 * The interface-drift gate, run whole, in a repository of its own.
 *
 * Its Studio-token scan lists files from the index and reads them from disk.
 * A stylesheet deleted but not yet staged is in the first and not the
 * second — the ordinary state of a branch that removes one, which is when
 * `pnpm verify` gets run — and the gate died on ENOENT instead of answering.
 * A crash is loud, but it stood between that branch and a green gate, and
 * nothing would have noticed the guard going missing again.
 *
 * The scratch repository carries the real token sources, because the gate
 * resolves every declaration against them and knows the Studio-only tokens by
 * reading them; with none of those there would be nothing to scan, and the
 * test would pass by never reaching the loop it is about.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const gate = path.join(here, 'check-interface-drift.mjs')

test('a stylesheet deleted but not yet staged is not a crash', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-drift-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], {
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
    })

  git('init', '-q', '-b', 'main')
  for (const file of TOKEN_SOURCES) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.copyFileSync(path.join(repo, file), path.join(dir, file))
  }
  const sheet = 'packages/ui/src/components/Gone.module.css'
  fs.mkdirSync(path.dirname(path.join(dir, sheet)), { recursive: true })
  fs.writeFileSync(path.join(dir, sheet), '.gone {\n  color: var(--hd-foreground);\n}\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  // Gone from the disk, still in the index.
  fs.rmSync(path.join(dir, sheet))

  const run = spawnSync(process.execPath, [gate, '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' })

  assert.doesNotMatch(run.stderr, /ENOENT/, run.stderr)
  assert.equal(run.status, 0, run.stderr || run.stdout)
  assert.match(run.stdout, /Studio-only tokens, all read with a Desk fallback/, 'and it reached the scan it is about')
})
