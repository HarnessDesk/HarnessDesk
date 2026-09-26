import assert from 'node:assert/strict'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { status } from '../src/git.js'
import { topLevel } from '../src/git-ops.js'
import { tempDir } from './scratch.js'

/**
 * `status` (git.ts) and `topLevel` (git-ops.ts) each shell out to a real
 * `git` process with its own 20s timeout. `workspace/recent` bounds both far
 * shorter than that (#939, #948) — but bounding the *read* is not bounding
 * the *process*: racing a promise against a timer only stops this handler
 * from waiting on it, and a `git` a stalled mount or a huge repository is
 * making slow keeps running on its own for the rest of its 20s regardless,
 * one more real process for every folder a person opens and every
 * `workspace/recent` poll after it, until it finally times itself out or
 * finishes on its own.
 *
 * Both functions now take an optional `AbortSignal`, threaded down to the
 * `execFile` call that actually runs `git` — Node kills the child the moment
 * that signal aborts, the same way it already does for the 20s timeout. This
 * puts a fake, slow `git` on `PATH`, waits for it to actually be running
 * (its own pid, written to a marker file the instant it starts — nothing
 * about a race with a slow-to-warm-up interpreter, only "has it started at
 * all yet"), then aborts and proves that exact process is gone soon after,
 * not merely that this caller stopped waiting on it.
 */

/**
 * A `git` that writes its own pid to `marker` the moment it starts, then
 * sleeps far longer than any bound below — long enough that if it were left
 * running, this test would time out waiting for it to disappear, rather than
 * false-passing on a coincidence.
 */
const fakeGit = async (dir: string, marker: string): Promise<string> => {
  const bin = join(dir, 'git')
  await writeFile(
    bin,
    ['#!/usr/bin/env node', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid))`, 'setTimeout(() => {}, 30_000)', ''].join(
      '\n',
    ),
  )
  await chmod(bin, 0o755)
  return bin
}

/** `PATH`, with `dir` in front, restored after the test — never mutated for longer than one call. */
const withFakeGitFirst = async <T>(dir: string, run: () => Promise<T>): Promise<T> => {
  const before = process.env.PATH
  process.env.PATH = `${dir}:${before ?? ''}`
  try {
    return await run()
  } finally {
    process.env.PATH = before
  }
}

const untilPid = async (marker: string, what: string, ms = 10_000): Promise<number> => {
  const { readFile } = await import('node:fs/promises')
  const end = Date.now() + ms
  for (;;) {
    try {
      const text = await readFile(marker, 'utf8')
      if (text.trim()) return Number(text.trim())
    } catch {
      // Not written yet.
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Whether a process with this pid still exists — `kill(pid, 0)` sends no signal, only asks. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const untilGone = async (pid: number, what: string, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (alive(pid)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('git.ts status kills its git process the moment an aborted signal fires, rather than leaving it running (#948)', async () => {
  const bindir = tempDir('hd-git-signal-')
  const marker = join(tempDir('hd-git-signal-marker-'), 'marker')
  await fakeGit(bindir, marker)
  const controller = new AbortController()
  await withFakeGitFirst(bindir, async () => {
    const settled = status(tempDir('hd-git-signal-repo-'), controller.signal)
    const pid = await untilPid(marker, 'the fake git to start and report its own pid')
    assert.ok(alive(pid), 'sanity: the process this test is about to abort is actually running')
    controller.abort()
    await untilGone(pid, 'the fake git process to be killed, well before its own 30s sleep ends')
    const result = await settled
    assert.equal(result, null, 'the aborted call fails closed, exactly as any other failed git call does')
  })
})

test('git-ops.ts topLevel kills its git process the moment an aborted signal fires, rather than leaving it running (#948)', async () => {
  const bindir = tempDir('hd-git-signal-')
  const marker = join(tempDir('hd-git-signal-marker-'), 'marker')
  await fakeGit(bindir, marker)
  const controller = new AbortController()
  await withFakeGitFirst(bindir, async () => {
    const settled = topLevel(tempDir('hd-git-signal-repo-'), controller.signal)
    const pid = await untilPid(marker, 'the fake git to start and report its own pid')
    assert.ok(alive(pid), 'sanity: the process this test is about to abort is actually running')
    controller.abort()
    await untilGone(pid, 'the fake git process to be killed, well before its own 30s sleep ends')
    const result = await settled
    assert.equal(result, null, 'the aborted call fails closed, exactly as any other failed git call does')
  })
})
