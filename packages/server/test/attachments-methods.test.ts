import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AgentAttachmentsView, AgentEntry, AgentNotesView, AttachmentEditPreview, AttachmentReview, SeatAttachmentsRecord, Session } from '@harnessdesk/protocol'

import { ConfinedTree } from '../src/confined-tree.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, start } from './fixtures/harness.js'

/**
 * Task 5's wire surface over a real Host: `attachment/agent` for the Agent
 * page, `attachment/edit/{preview,write}` for its Skills/Servers allowlists,
 * `attachment/notes` and `.../clear` for its Notes section. Every handler
 * resolves its own folder from id/origin — never from a path or digest the
 * client supplies — the same discipline `agent/ceiling/*` already holds.
 */

const REVIEWER = ['---', 'name: Reviewer', 'ceiling: read', 'prefer: [fake]', '---', 'Read the diff.', ''].join('\n')

test('attachment/agent shows runtime defaults for an undeclared Agent, never "none"', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
  })
  await mkdir(`${harness.stateDir}/agents/reviewer`, { recursive: true })
  await writeFile(`${harness.stateDir}/agents/reviewer/AGENT.md`, REVIEWER, 'utf8')

  const view = (await client.call('attachment/agent', { id: 'reviewer', origin: 'user' })) as AgentAttachmentsView
  assert.equal(view.agent, 'reviewer')
  assert.equal(view.origin, 'user')
  assert.equal(view.skillsMode, 'runtime-defaults')
  assert.equal(view.mcpMode, 'runtime-defaults')
  assert.deepEqual(view.declarations, [])
  assert.ok(view.support.length > 0, 'at least the fake runtime reports its own measured support')
  // An unmeasured runtime's reason is read by a person: it names the runtime
  // by its presentation, never its id (rule 8).
  assert.match(view.support[0]!.reason ?? '', /^Fake Runtime has not been measured/)
})

test('attachment/agent refuses an Agent nobody has here', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
  })
  await assert.rejects(client.call('attachment/agent', { id: 'ghost', origin: 'user' }), /no.*Agent/i)
})

test('preview shows the exact diff and changes nothing on disk; write applies exactly that diff, bound to its digest', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
  })
  const folder = `${harness.stateDir}/agents/reviewer`
  await mkdir(folder, { recursive: true })
  await writeFile(`${folder}/AGENT.md`, REVIEWER, 'utf8')

  const preview = (await client.call('attachment/edit/preview', {
    id: 'reviewer',
    origin: 'user',
    skills: ['review-checklist'],
    mcp: [],
  })) as AttachmentEditPreview
  assert.match(preview.diff, /\+skills: \[review-checklist\]/)
  assert.match(preview.diff, /\+mcp: \[\]/)
  assert.equal(await readFile(`${folder}/AGENT.md`, 'utf8'), REVIEWER, 'a preview writes nothing')

  const written = (await client.call('attachment/edit/write', {
    id: 'reviewer',
    origin: 'user',
    skills: ['review-checklist'],
    mcp: [],
    digest: preview.digest,
  })) as AgentEntry
  assert.deepEqual(written.definition?.skills, ['review-checklist'])
  const onDisk = await readFile(`${folder}/AGENT.md`, 'utf8')
  assert.match(onDisk, /skills: \[review-checklist\]/)
  assert.match(onDisk, /name: Reviewer/, 'everything else about the file is untouched')
})

test('write refuses a stale digest and leaves the newer file exactly as it was', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
  })
  const folder = `${harness.stateDir}/agents/reviewer`
  await mkdir(folder, { recursive: true })
  await writeFile(`${folder}/AGENT.md`, REVIEWER, 'utf8')
  const preview = (await client.call('attachment/edit/preview', { id: 'reviewer', origin: 'user', skills: ['a'], mcp: [] })) as AttachmentEditPreview

  // Somebody else's edit lands first.
  await writeFile(`${folder}/AGENT.md`, `${REVIEWER}\nEdited elsewhere.\n`, 'utf8')

  await assert.rejects(
    client.call('attachment/edit/write', { id: 'reviewer', origin: 'user', skills: ['a'], mcp: [], digest: preview.digest }),
    /has changed since the update was shown to you/,
  )
  assert.match(await readFile(`${folder}/AGENT.md`, 'utf8'), /Edited elsewhere\./)
})

test('a built-in origin is refused at the wire before it ever reaches a handler — editing and clearing take only user or project', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
  })
  await assert.rejects(
    client.call('attachment/edit/preview', { id: 'reviewer', origin: 'builtin', skills: ['a'], mcp: [] } as never),
    /expected one of user \| project/,
  )
  await assert.rejects(
    client.call('attachment/notes/clear', { id: 'reviewer', origin: 'builtin', digest: 'a'.repeat(64) } as never),
    /expected one of user \| project/,
  )
})

test('notes: missing reads as text: null, and a person can clear only what was actually shown', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
  })
  const folder = `${harness.stateDir}/agents/reviewer`
  await mkdir(folder, { recursive: true })
  await writeFile(`${folder}/AGENT.md`, REVIEWER, 'utf8')

  const missing = (await client.call('attachment/notes', { id: 'reviewer', origin: 'user' })) as AgentNotesView
  assert.equal(missing.text, null)

  await writeFile(`${folder}/NOTES.md`, 'Prefer small diffs.\n', 'utf8')
  const shown = (await client.call('attachment/notes', { id: 'reviewer', origin: 'user' })) as AgentNotesView
  assert.equal(shown.text, 'Prefer small diffs.\n')

  const cleared = (await client.call('attachment/notes/clear', { id: 'reviewer', origin: 'user', digest: shown.digest })) as AgentNotesView
  assert.equal(cleared.text, '')
  assert.equal(await readFile(`${folder}/NOTES.md`, 'utf8'), '')
})

test('notes clear refuses a stale digest, leaving the newer text intact', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
  })
  const folder = `${harness.stateDir}/agents/reviewer`
  await mkdir(folder, { recursive: true })
  await writeFile(`${folder}/AGENT.md`, REVIEWER, 'utf8')
  await writeFile(`${folder}/NOTES.md`, 'first', 'utf8')
  const shown = (await client.call('attachment/notes', { id: 'reviewer', origin: 'user' })) as AgentNotesView
  await writeFile(`${folder}/NOTES.md`, 'changed since then', 'utf8')
  await assert.rejects(
    client.call('attachment/notes/clear', { id: 'reviewer', origin: 'user', digest: shown.digest }),
    /changed since it was shown to you/,
  )
  assert.equal(await readFile(`${folder}/NOTES.md`, 'utf8'), 'changed since then')
})

test('attachment/review binds trust to the exact project a Seat will actually open in, so an approval survives to the real Seat', async (t) => {
  // A `user` Agent's own folder (under the state directory) is never the
  // project it gets seated into (a work checkout) — this test's whole point
  // is that `attachment/review` must use the *latter*, matching exactly what
  // `agent/seat` itself binds trust to (`incarnationOf(project ?? cwd)`).
  const runtime = new FakeRuntime({
    id: 'fake' as never,
    attachments: { runtime: 'fake', build: '1.0.0', skills: 'scoped', mcp: 'unsupported', suppressUnapproved: true, reason: null },
  })
  const harness = await start({}, undefined, runtime)
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
  })
  const folder = `${harness.stateDir}/agents/reviewer`
  await mkdir(`${folder}/skills/review-checklist`, { recursive: true })
  await writeFile(`${folder}/AGENT.md`, ['---', 'name: Reviewer', 'ceiling: read', 'prefer: [fake]', 'skills: [review-checklist]', '---', 'Read the diff.', ''].join('\n'), 'utf8')
  await writeFile(`${folder}/skills/review-checklist/SKILL.md`, ['---', 'name: review-checklist', 'description: Checklist.', '---', 'Check things.', ''].join('\n'), 'utf8')

  const work = `${harness.stateDir}-work`
  await mkdir(work, { recursive: true })
  t.after(async () => rm(work, { recursive: true, force: true }))
  await client.call('workspace/open', { path: work })

  const review = (await client.call('attachment/review', { id: 'reviewer', origin: 'user', root: work, runtime: 'fake' })) as AttachmentReview
  assert.equal(review.declarations[0]?.name, 'review-checklist')
  await client.call('attachment/approve', { token: review.token })

  const seated = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const seatId = harness.host.registry.attachmentSeatOf(seated.runtime as never, seated.id as never)
  assert.ok(seatId, 'seatAgent must have recorded this live conversation’s attachment Seat')
  const receipt = (await client.call('attachment/seat', { seat: seatId })) as SeatAttachmentsRecord | null
  assert.equal(receipt?.results[0]?.status, 'loaded', 'the approval made against the real Seat’s own project must be the one the Seat actually finds')
  assert.equal(receipt?.results[0]?.reason, null)
})

test('write waits for an unfinished save of the same Agent file, so that save stays resumable', async (t) => {
  const harness = await start()
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await harness.server.close().catch(() => {})
    await harness.host.dispose().catch(() => {})
    await rm(harness.stateDir, { recursive: true, force: true })
  })
  const folder = `${harness.stateDir}/agents/reviewer`
  await mkdir(folder, { recursive: true })
  await writeFile(`${folder}/AGENT.md`, REVIEWER, 'utf8')
  const home = await ConfinedTree.open(harness.stateDir)
  const id = 'ef'.repeat(16)
  await mkdir(`${harness.stateDir}/authoring/transactions`, { recursive: true })
  await writeFile(`${harness.stateDir}/authoring/transactions/${id}.json`, JSON.stringify({
    version: 1, id, tx: 'crashed', scope: 'user', root: home.root, project: null, rootIdentity: home.identity,
    edits: [{ path: 'agents/reviewer/AGENT.md', before: REVIEWER, after: REVIEWER.replace('Read the diff.', 'Read the diff twice.') }],
    written: [], state: 'prepared', created: 1,
  }))
  const preview = (await client.call('attachment/edit/preview', { id: 'reviewer', origin: 'user', skills: ['a'], mcp: [] })) as AttachmentEditPreview
  await assert.rejects(
    client.call('attachment/edit/write', { id: 'reviewer', origin: 'user', skills: ['a'], mcp: [], digest: preview.digest }),
    /An earlier save of one of these files did not finish/,
  )
  assert.equal(await readFile(`${folder}/AGENT.md`, 'utf8'), REVIEWER)
})
