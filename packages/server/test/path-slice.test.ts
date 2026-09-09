import assert from 'node:assert/strict'
import { sep } from 'node:path'
import { test } from 'node:test'

import { canonicalDestination } from '../src/git-worktree.js'
import { readChannel } from '../src/installs/channels.js'

/**
 * `X.length + 1` as a way to take a path apart.
 *
 * The arithmetic assumes `X` does not already end in a separator, and skips one
 * character too many when it does. There is exactly one directory for which
 * that is false and it is the one nobody builds a fixture for: the filesystem
 * root, where `dirname` answers `/`. A path below it loses its first letter.
 *
 * Both of these are reachable in ordinary use. A repository checked out at
 * `/app` or `/workspace` — which is what a container image usually looks like —
 * has the root as its parent, so every worktree it makes walks through this.
 * And a managed directory is whatever the caller configured, trailing separator
 * included.
 */

test('a destination below the filesystem root keeps its first letter', async () => {
  // Nothing is created: the walk only reads, and stops at the first ancestor
  // that resolves — here, the root itself.
  assert.equal(await canonicalDestination(`${sep}harnessdesk-not-a-real-dir`), `${sep}harnessdesk-not-a-real-dir`)
  assert.equal(
    await canonicalDestination(`${sep}harnessdesk-not-a-real-dir${sep}under${sep}it`),
    `${sep}harnessdesk-not-a-real-dir${sep}under${sep}it`,
  )
})

test('a destination whose parents exist is unchanged, as it always was', async () => {
  // The control. If this ever fails the fix has broken the ordinary case,
  // which is the whole of what `canonicalDestination` is for.
  const root = await canonicalDestination(sep)
  assert.equal(root, sep)
})

test('a managed directory given with a trailing separator keeps the package name whole', () => {
  const managed = `${sep}opt${sep}harnessdesk${sep}agents`
  const installed = `${managed}${sep}claude-code${sep}bin${sep}claude`
  const reading = (dir: string) =>
    readChannel(installed, { managedDir: dir, realpath: (path) => path, platform: 'linux' })

  assert.equal(reading(managed).packageName, 'claude-code')
  // The same directory, spelled the way a config file often carries it.
  assert.equal(
    reading(`${managed}${sep}`).packageName,
    'claude-code',
    'a trailing separator is the same directory, not one character of the name',
  )
})
