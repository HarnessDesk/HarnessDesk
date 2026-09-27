import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findOption } from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'
import { CODEX_CEILINGS } from '../src/mapping/options.js'
import type { CodexSession } from '../src/session.js'

/**
 * Issue #1074. Codex's workspace sandbox keeps a checkout's `.git` read-only
 * inside a writable folder (measured on 0.155.0: `index.lock` and
 * `refs/heads/<name>.lock` refused with "Operation not permitted"), so a Seat
 * held at `edit` wrote its files and then could not commit them — and a card
 * that can commit is never let finish with its own work uncommitted.
 *
 * A Seat whose grant can commit is opened with its checkout's git directories
 * (`SessionOptions.gitDirs`, the host's): a checkout's own `.git`, or a lane's
 * gitdir and the repository's common dir, where refs, objects and their lock
 * files live. Held at the workspace sandbox, those become writable roots, and
 * nothing else does. A conversation opened without them keeps Codex's own
 * workspace profile, and a read-only one is read-only throughout.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const codex = async (t: TestContext) => {
  const runtime = new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test', env: {} })
  t.after(() => runtime.dispose())
  await runtime.start()
  return runtime
}

const hold = async (session: CodexSession, level: 'read' | 'edit') => {
  for (const setting of CODEX_CEILINGS[level].settings) await session.setOption(setting.option, setting.value)
  for (const setting of CODEX_CEILINGS[level].settings) {
    assert.equal(findOption(session.options(), setting.option)?.currentValue, setting.value, `${setting.option} reads back held`)
  }
}

const sandboxOf = (session: CodexSession) => session.startLike().sandbox

test('an edit Seat in an ordinary checkout is held in a workspace sandbox that can write its .git', async (t) => {
  const runtime = await codex(t)
  const session = (await runtime.createSession({ cwd: '/w', gitDirs: ['/w/.git'] })) as CodexSession
  await hold(session, 'edit')
  const sandbox = sandboxOf(session)
  assert.equal(sandbox?.type, 'workspaceWrite')
  assert.ok(sandbox?.type === 'workspaceWrite' && sandbox.writableRoots.includes('/w/.git'), 'the checkout’s .git is writable')
  assert.equal(sandbox?.type === 'workspaceWrite' && sandbox.networkAccess, false, 'and nothing past what a commit needs')
})

test('an edit Seat in a worktree lane can write both its own gitdir and the common dir its refs live in', async (t) => {
  const runtime = await codex(t)
  const gitDirs = ['/r/.git/worktrees/lane', '/r/.git']
  const session = (await runtime.createSession({ cwd: '/w', gitDirs })) as CodexSession
  await hold(session, 'edit')
  const sandbox = sandboxOf(session)
  assert.equal(sandbox?.type, 'workspaceWrite')
  for (const dir of gitDirs) {
    assert.ok(sandbox?.type === 'workspaceWrite' && sandbox.writableRoots.includes(dir), `${dir} is writable`)
  }
})

test('a read-only Seat keeps .git read-only, git directories or not', async (t) => {
  const runtime = await codex(t)
  const session = (await runtime.createSession({ cwd: '/w', gitDirs: ['/w/.git'] })) as CodexSession
  await hold(session, 'read')
  const sandbox = sandboxOf(session)
  assert.ok(sandbox === null || sandbox.type === 'readOnly', 'read-only, with no writable root at all')
})

test('a conversation opened without git directories keeps Codex’s own workspace profile', async (t) => {
  const runtime = await codex(t)
  const session = (await runtime.createSession({ cwd: '/w' })) as CodexSession
  await hold(session, 'edit')
  assert.equal(sandboxOf(session), null, 'the named profile, not a policy with writable roots')
})
