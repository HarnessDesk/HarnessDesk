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

/**
 * Renaming a token is a change this gate has to be able to express.
 *
 * Both sides used to resolve against the branch's tokens, so a declaration
 * that merely changed which name it reads — same value, new spelling — came
 * back as *was nothing, is now something* for every reader of the renamed
 * token. That made renaming one token an unreviewable diff of a hundred and
 * fifty declarations, and the only way out was to keep the old name alive
 * forever as an alias.
 *
 * Both halves are here, because the fix must not cost the gate its job: a
 * rename at the same value passes, and pointing a declaration at a token that
 * means something else still fails.
 */
const scratch = (t, write) => {
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
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  const tokens = 'packages/ui/src/design/foundation/tokens.css'
  const read = () => fs.readFileSync(path.join(dir, tokens), 'utf8')
  put('packages/ui/src/components/Probe.module.css', '.probe {\n  color: var(--hd-probe-old);\n}\n')
  put(tokens, `${read()}\n:root {\n  --hd-probe-old: rgb(1, 2, 3);\n  --hd-probe-other: rgb(9, 9, 9);\n}\n`)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  write({ put, read, tokens })
  return spawnSync(process.execPath, [gate, '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' })
}

test('a token renamed at the same value is not drift (#754)', (t) => {
  const run = scratch(t, ({ put, read, tokens }) => {
    put(tokens, read().replace('--hd-probe-old: rgb(1, 2, 3);', '--hd-probe-new: rgb(1, 2, 3);'))
    put('packages/ui/src/components/Probe.module.css', '.probe {\n  color: var(--hd-probe-new);\n}\n')
  })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.doesNotMatch(run.stdout + run.stderr, /was ""/, 'the base side resolved against the base its own tokens')
})

test('a declaration pointed at a different value is still drift (#754)', (t) => {
  const run = scratch(t, ({ put }) => {
    put('packages/ui/src/components/Probe.module.css', '.probe {\n  color: var(--hd-probe-other);\n}\n')
  })
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout + run.stderr, /rgb\(1, 2, 3\)/, 'and it says what the declaration used to mean')
})
