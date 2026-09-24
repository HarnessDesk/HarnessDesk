import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AttachmentReview, Session } from '@harnessdesk/protocol'

import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, halt, start, stop, type Harness } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * Phase 12's whole journey over the real wire, on a real `Host`: a person
 * reviews what an Agent would load, approves it, and the Agent is seated —
 * then the conversation lives on through the events a Seat outlives. Every
 * step goes through the same wire methods the app calls, never a host
 * internal, so a review that approves something `agent/seat` would never
 * accept (a different ceiling, a different runtime) fails here.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))
const SKILL_TEXT = '---\nname: demo\ndescription: demo skill\n---\nDo the thing.\n'

/** A fake that implements the attachment contract and reads the Library the way a Claude Code runtime would. */
export const capableRuntime = (): FakeRuntime =>
  new FakeRuntime({
    brand: 'claudecode',
    attachments: { runtime: 'fake', build: '1.0.0', skills: 'scoped', mcp: 'scoped-gated', suppressUnapproved: true, reason: null },
  })

export interface Desk {
  readonly harness: Harness
  readonly client: Client
  readonly runtime: FakeRuntime
  readonly work: string
  /** Stops the host and leaves its state for another to start on — a restart's first half. */
  halt(): Promise<void>
}

/**
 * A desk with one project that declares a Library server in its own
 * `.mcp.json`, and one personal Agent at `merge` that carries one skill of
 * its own and that server. `libraryHome` keeps the Library scan off the
 * machine this runs on.
 */
export const deskWithMergeAgent = async (t: { after(fn: () => unknown): void }, runtime = capableRuntime()): Promise<Desk> => {
  const home = tempDir('hd-attach-life-home-')
  const harness = await start({ libraryHome: home }, undefined, runtime)
  let halted = false
  t.after(async () => {
    if (!halted) await stop(harness)
  })
  const work = tempDir('hd-attach-life-work-')
  execFileSync('git', ['init', '-q', work])
  await writeFile(
    join(work, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'reviewer-tools': { command: process.execPath, args: [FIXTURE] } } }),
  )
  const agentDir = join(harness.stateDir, 'agents', 'reviewer')
  await mkdir(join(agentDir, 'skills', 'demo'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'demo', 'SKILL.md'), SKILL_TEXT)
  await writeFile(
    join(agentDir, 'AGENT.md'),
    '---\nname: Reviewer\nceiling: merge\nprefer: [fake=fake-1]\nskills: [demo]\nmcp: [reviewer-tools]\n---\nRead the diff.\n',
  )
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: work })
  return {
    harness,
    client,
    runtime,
    work,
    halt: async () => {
      halted = true
      client.close()
      await halt(harness)
    },
  }
}

export const reviewAndApprove = async (desk: Desk): Promise<AttachmentReview> => {
  // No runtime named: the host answers for the one `agent/seat` would choose.
  const review = (await desk.client.call('attachment/review', { id: 'reviewer', origin: 'user', root: desk.work })) as AttachmentReview
  await desk.client.call('attachment/approve', { token: review.token })
  return review
}

export const recordOf = async (desk: Desk, session: Session) => {
  const seat = desk.harness.host.registry.attachmentSeatOf(session.runtime, session.id)
  assert.ok(seat, 'the seated conversation names the Seat its attachments were frozen under')
  const record = await desk.harness.host.attachmentsPlane.read(seat)
  assert.ok(record)
  return record
}

const statuses = (record: { readonly results: readonly { identity: { kind: string; name: string }; status: string }[] }) =>
  record.results.map((one) => `${one.identity.kind}:${one.identity.name}:${one.status}`)

test('review, approve, then agent/seat: a merge-ceiling Agent loads its skill and its server at merge, and its skill at the default ceiling', async (t) => {
  const desk = await deskWithMergeAgent(t)
  const review = await reviewAndApprove(desk)
  assert.equal(review.runtime, 'fake', 'the review is for the runtime the Seat will actually run on')
  assert.equal(review.effectiveCeiling, 'merge')
  assert.deepEqual(review.declarations.map((one) => `${one.kind}:${one.name}`), ['skill:demo', 'mcp:reviewer-tools'])

  const atMerge = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work, permission: 'merge' })) as Session
  const merged = await recordOf(desk, atMerge)
  assert.deepEqual(statuses(merged), ['skill:demo:loaded', 'mcp:reviewer-tools:loaded'], JSON.stringify(merged.results))

  // The default seating (no permission) runs at `edit`: the approval, given
  // at the Agent's own `merge`, still covers it — a narrower Seat is less
  // authority, never more — so the skill loads. The server does not: an
  // external server is `merge` by decision 13, and says so.
  const byDefault = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work })) as Session
  const plain = await recordOf(desk, byDefault)
  assert.deepEqual(statuses(plain), ['skill:demo:loaded', 'mcp:reviewer-tools:not-loaded'])
  assert.match(plain.results[1]!.reason ?? '', /exceeds the Seat ceiling/)
})

test('a caller past the wire validator still cannot hand a runtime `attachments`: create, resume and fork strip it', async (t) => {
  const runtime = capableRuntime()
  const harness = await start({ libraryHome: tempDir('hd-attach-strip-home-') }, undefined, runtime)
  t.after(() => stop(harness))
  const work = tempDir('hd-attach-strip-work-')
  await harness.host.call('workspace/open', { path: work })
  const forged = { key: 'forged', skills: [{ name: 'x', digest: 'd'.repeat(64), path: '/anything' }], mcp: null }

  const created = await harness.host.call('session/create', { runtime: 'fake' as never, options: { cwd: work, attachments: forged } as never })
  assert.equal(runtime.lastCreateOptions?.attachments, undefined, 'session/create never forwards a client-supplied filter')

  await harness.host.call('session/resume', { runtime: 'fake' as never, sessionId: String(created.id) as never, options: { attachments: forged } as never })
  assert.equal(runtime.lastResumeOptions?.attachments, undefined, 'session/resume never forwards a client-supplied filter')

  await harness.host.call('session/fork', { runtime: 'fake' as never, sessionId: String(created.id) as never, options: { attachments: forged } as never }).catch(() => {})
  assert.equal(runtime.lastForkOptions?.attachments, undefined, 'session/fork never forwards a client-supplied filter')
})

/** What the runtime was actually handed when it (re)opened a conversation. */
const given = (runtime: FakeRuntime, id: string) => runtime.attachmentsGiven.get(id)

test('a restart, then session/resume: the Seat reopens on its frozen filter, revalidated, and appends an epoch — never native defaults', async (t) => {
  const desk = await deskWithMergeAgent(t)
  await reviewAndApprove(desk)
  const session = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work, permission: 'merge' })) as Session
  const opened = given(desk.runtime, String(session.id))
  assert.ok(opened)

  // The Agent's file changes while the desk is down: a new skill it now wishes for.
  const agentDir = join(desk.harness.stateDir, 'agents', 'reviewer')
  await mkdir(join(agentDir, 'skills', 'later'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'later', 'SKILL.md'), '---\nname: later\n---\nNot approved.\n')
  await writeFile(
    join(agentDir, 'AGENT.md'),
    '---\nname: Reviewer\nceiling: merge\nprefer: [fake=fake-1]\nskills: [demo, later]\nmcp: [reviewer-tools]\n---\nRead the diff.\n',
  )
  await desk.halt()

  const runtime = capableRuntime()
  const again = await start({ libraryHome: tempDir('hd-attach-life-home2-') }, desk.harness.stateDir, runtime)
  t.after(() => stop(again))
  const client = await Client.connect(again.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: desk.work })
  await client.call('session/resume', { runtime: 'fake', sessionId: String(session.id) })

  const reopened = given(runtime, String(session.id))
  assert.ok(reopened, 'a reopen hands the runtime the Seat’s filter — without one it would load every ambient skill and server')
  assert.notEqual(reopened.key, opened.key, 'a reopen is its own observation, with its own key')
  assert.deepEqual(reopened.skills?.map((one) => `${one.name}:${one.digest}`), opened.skills?.map((one) => `${one.name}:${one.digest}`), 'the frozen skill, not the Agent’s current list')
  assert.deepEqual(reopened.mcp?.map((one) => one.name), ['reviewer-tools'])

  const seat = again.host.registry.attachmentSeatOf(session.runtime, session.id)
  assert.ok(seat, 'the reopened conversation names its Seat again, so the gateway can serve it')
  const record = await again.host.attachmentsPlane.read(seat)
  assert.equal(record?.epoch, 1)
  assert.deepEqual(statuses(record!), ['skill:demo:loaded', 'mcp:reviewer-tools:loaded'])
  assert.equal(again.host.attachmentsPlane.liveServersFor(seat)?.length, 1)
})

test('a reconnect after the runtime restarts re-applies the frozen filter too', async (t) => {
  const desk = await deskWithMergeAgent(t)
  await reviewAndApprove(desk)
  const session = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work, permission: 'merge' })) as Session
  const opened = given(desk.runtime, String(session.id))!
  // What an adapter's own restart looks like from the host: health leaves
  // `ready`, the process's sessions are gone, health returns.
  desk.runtime.setHealth({ state: 'starting' })
  desk.runtime.sessions.clear()
  desk.runtime.attachmentsGiven.clear()
  desk.runtime.setHealth({ state: 'ready' })

  await desk.client.call('turn/send', { runtime: 'fake', sessionId: String(session.id), input: [{ type: 'text', text: 'Carry on.' }] })
  const reopened = given(desk.runtime, String(session.id))
  assert.ok(reopened, 'the reconnect reopened the conversation on its filter')
  assert.notEqual(reopened.key, opened.key)
  assert.deepEqual(reopened.skills?.map((one) => one.digest), opened.skills?.map((one) => one.digest))
  const record = await desk.harness.host.attachmentsPlane.read(desk.harness.host.registry.attachmentSeatOf(session.runtime, session.id)!)
  assert.equal(record?.epoch, 1)
})

test('a fork of a Seat that carries attachments is refused: it would run on the runtime’s own defaults', async (t) => {
  const desk = await deskWithMergeAgent(t)
  await reviewAndApprove(desk)
  const session = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work })) as Session
  await assert.rejects(
    desk.client.call('session/fork', { runtime: 'fake', sessionId: String(session.id) }),
    /a fork of it would run without them/,
  )
  assert.equal(desk.runtime.lastForkOptions, null, 'the runtime was never asked to fork it')
})

test('bytes that change after approval are never loaded under the approved digest — refused before staging, or reported after it', async (t) => {
  const desk = await deskWithMergeAgent(t)
  await reviewAndApprove(desk)
  const skill = join(desk.harness.stateDir, 'agents', 'reviewer', 'skills', 'demo', 'SKILL.md')

  // Changed in the Agent's own folder after the approval: a different identity, so nothing approved it.
  await writeFile(skill, '---\nname: demo\n---\nDo something else.\n')
  const changed = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work })) as Session
  assert.deepEqual(given(desk.runtime, String(changed.id))?.skills, [], 'the runtime is never handed bytes nobody approved')
  const refused = await recordOf(desk, changed)
  assert.equal(refused.results[0]!.status, 'not-loaded')
  assert.match(refused.results[0]!.reason ?? '', /Review this content/)

  // Back to the approved bytes; then the host's own staged copy is rewritten
  // after the Seat was prepared, before the runtime reports: the runtime
  // hashes what is there, and the host refuses it as different content.
  await writeFile(skill, '---\nname: demo\ndescription: demo skill\n---\nDo the thing.\n')
  desk.runtime.beforeAttachmentReceipt = async (input) => {
    for (const one of input.skills ?? []) await writeFile(join(one.path, 'SKILL.md'), 'swapped after approval')
  }
  const tampered = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work })) as Session
  const staged = given(desk.runtime, String(tampered.id))?.skills?.[0]
  assert.equal(
    staged?.path,
    join(await realpath(desk.harness.stateDir), 'attachments', 'staged', 'skill', staged?.digest ?? ''),
    'the runtime is handed the host’s own staged copy, under machine state — never the Agent’s folder',
  )
  const record = await recordOf(desk, tampered)
  assert.equal(record.results[0]!.status, 'not-loaded')
  assert.match(record.results[0]!.reason ?? '', /different content/)
})
