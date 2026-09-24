import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

import type { GoalView, GoalReceipt, MemoryFile, MemoryResolution, WrapPreview } from '@harnessdesk/protocol'

import { goalFile } from '../src/goals/store.js'
import { Client, halt, start } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const exec = promisify(execFile)

/**
 * Task 6's read-only front door onto Task 2's retention, over a real Host:
 * `memory/list` at one exact commit, and `memory/read` opening a real
 * citation — plus the one thing decision 1 exists to prevent, a citation
 * whose project does not match the project the call was confined to.
 */

test('memory/list names a committed memory file at one exact revision, and memory/read opens a real citation', async (t) => {
  const root = tempDir('hd-memory-methods-')
  await exec('git', ['init', '-q'], { cwd: root })
  await mkdir(`${root}/.harnessdesk/memory`, { recursive: true })
  await writeFile(`${root}/.harnessdesk/memory/notes.md`, 'Prefer small diffs.\n', 'utf8')
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'notes'], { cwd: root })
  const at = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()

  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: root })

  const files = (await client.call('memory/list', { root, at })) as readonly MemoryFile[]
  assert.deepEqual(files, [{ path: '.harnessdesk/memory/notes.md', at, problem: null }])

  const source = await client.call('goal/create', { root, sentence: 'Write project notes' }) as GoalView
  const preview = await client.call('goal/preview', { goal: source.goal.id, choices: { summary: 'Wrote notes.', cards: [] } }) as WrapPreview
  const receipt = await client.call('goal/wrap', { goal: source.goal.id, stamp: preview.stamp, choices: { summary: 'Wrote notes.', cards: [] } }) as GoalReceipt

  const target = await client.call('goal/create', { root, sentence: 'Read the notes back' }) as GoalView
  // `target.goal.root` — never the raw `root` this test passed in — because
  // Goal creation confines/normalizes it (macOS's own /var -> /private/var
  // among other things), and `GoalPlane.cite` binds a citation's `project`
  // to exactly that normalized value.
  const project = target.goal.root
  const citation = { goal: source.goal.id, receipt: receipt.id, project, path: '.harnessdesk/memory/notes.md', at }
  await client.call('goal/cite', { goal: target.goal.id, citation })

  const resolution = (await client.call('memory/read', { root: project, citation })) as MemoryResolution
  assert.equal(resolution.state, 'retained')
  if (resolution.state === 'retained') {
    assert.equal(resolution.snapshot.text, 'Prefer small diffs.\n')
    assert.equal(resolution.sourceAvailable, true)
    assert.equal(resolution.restored, false)
  }
})

test('memory/read refuses a citation whose project does not match the one the call was confined to', async (t) => {
  const root = tempDir('hd-memory-methods-a-')
  await exec('git', ['init', '-q'], { cwd: root })
  const otherRoot = tempDir('hd-memory-methods-b-')
  await exec('git', ['init', '-q'], { cwd: otherRoot })

  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
    await rm(otherRoot, { recursive: true, force: true })
  })
  await client.call('workspace/open', { path: root })
  await client.call('workspace/open', { path: otherRoot })

  const forged = {
    goal: 'g1', receipt: 'r1', project: otherRoot, path: '.harnessdesk/memory/notes.md', at: 'a'.repeat(40),
  }
  await assert.rejects(
    client.call('memory/read', { root, citation: forged }),
    /does not belong to the selected project/,
  )
})

test('a citation still resolves after a real restart, and reports the source Goal honestly once it is gone', async (t) => {
  const root = tempDir('hd-memory-restart-')
  await exec('git', ['init', '-q'], { cwd: root })
  await mkdir(`${root}/.harnessdesk/memory`, { recursive: true })
  await writeFile(`${root}/.harnessdesk/memory/notes.md`, 'Prefer small diffs.\n', 'utf8')
  await exec('git', ['add', '.'], { cwd: root })
  await exec('git', ['-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '-qm', 'notes'], { cwd: root })
  const at = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()

  let harness = await start()
  let client: Client | null = null
  // One teardown, registered before anything below can throw, reading
  // `harness`/`client` at the time it actually *runs* rather than the time
  // it was registered — so whichever instance is live when a mid-test
  // assertion throws is still the one this closes. Order matters: a folder
  // removed while its host still holds the desk lock (or a socket, or a
  // watcher) is the exact class of hang `t.after` hooks registered
  // mid-test and left to fire in registration order produced here first —
  // the process outlives the test that failed in it, because nothing ever
  // disposes the host whose restart that assertion was checking.
  t.after(async () => {
    client?.close()
    await halt(harness).catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  client = await Client.connect(harness.server)
  await client.call('workspace/open', { path: root })
  const source = await client.call('goal/create', { root, sentence: 'Write project notes' }) as GoalView
  const preview = await client.call('goal/preview', { goal: source.goal.id, choices: { summary: 'Wrote notes.', cards: [] } }) as WrapPreview
  const receipt = await client.call('goal/wrap', { goal: source.goal.id, stamp: preview.stamp, choices: { summary: 'Wrote notes.', cards: [] } }) as GoalReceipt
  const target = await client.call('goal/create', { root, sentence: 'Read the notes back' }) as GoalView
  const project = target.goal.root
  const citation = { goal: source.goal.id, receipt: receipt.id, project, path: '.harnessdesk/memory/notes.md', at }
  await client.call('goal/cite', { goal: target.goal.id, citation })
  client.close()

  // A plain restart, nothing removed: the same stateDir, a fresh process's
  // in-memory registry rebuilt from what is still on disk. A citation is
  // "retention", not a cache — it must still open after the process that
  // made it is gone, which is the only case this phase's CDP walkthrough
  // actually cares about proving.
  await halt(harness)
  harness = await start({}, harness.stateDir)
  client = await Client.connect(harness.server)
  await client.call('workspace/open', { path: root })
  const survived = (await client.call('memory/read', { root: project, citation })) as MemoryResolution
  assert.equal(survived.state, 'retained', `a citation must still open after a restart, not just within the process that made it: ${JSON.stringify(survived)}`)
  if (survived.state === 'retained') {
    assert.equal(survived.snapshot.text, 'Prefer small diffs.\n')
    assert.equal(survived.sourceAvailable, true, 'the source Goal document is still on disk, unmodified — sourceAvailable must not go false on its own')
  }
  client.close()

  // Now the source Goal actually ends: removed from the rig's stored
  // history exactly as the plan's own CDP walkthrough puts it — its
  // document file gone AND its id gone from the index, the only way
  // `GoalStore.load()` accepts a desk that was not "opened empty" (a file
  // deleted from under a still-indexed id is refused as corruption, not
  // read as "the Goal ended"). The retained snapshot is a sibling
  // directory (`goals/memory-archive`), never touched by this.
  await halt(harness)
  const goalsDir = join(harness.stateDir, 'goals')
  await rm(join(goalsDir, goalFile(source.goal.id)))
  const index = JSON.parse(await readFile(join(goalsDir, 'index.json'), 'utf8')) as { ids: string[] }
  index.ids = index.ids.filter((id) => id !== source.goal.id)
  await writeFile(join(goalsDir, 'index.json'), JSON.stringify(index), 'utf8')

  harness = await start({}, harness.stateDir)
  client = await Client.connect(harness.server)
  await client.call('workspace/open', { path: root })
  const afterSourceGone = (await client.call('memory/read', { root: project, citation })) as MemoryResolution
  assert.equal(afterSourceGone.state, 'retained', `the retained copy must still open once the source Goal is gone, only labeled honestly: ${JSON.stringify(afterSourceGone)}`)
  if (afterSourceGone.state === 'retained') {
    assert.equal(afterSourceGone.snapshot.text, 'Prefer small diffs.\n', 'original bytes remain, untouched by the source Goal disappearing')
    assert.equal(afterSourceGone.sourceAvailable, false, 'the source Goal no longer exists on this desk')
  }
})

test('memory/list refuses a project this desk has not opened', async (t) => {
  const root = tempDir('hd-memory-methods-unopened-')
  await exec('git', ['init', '-q'], { cwd: root })
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })
  await assert.rejects(client.call('memory/list', { root, at: 'a'.repeat(40) }), /.+/)
})
