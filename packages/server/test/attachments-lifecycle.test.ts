import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AttachmentReview, Session } from '@harnessdesk/protocol'

import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, start, stop, type Harness } from './fixtures/harness.js'
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
  t.after(() => stop(harness))
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
  return { harness, client, runtime, work }
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
  const forged = { key: 'forged', skills: [{ name: 'x', digest: 'd'.repeat(64), path: '/anything' }], mcp: null, notes: null }

  const created = await harness.host.call('session/create', { runtime: 'fake' as never, options: { cwd: work, attachments: forged } as never })
  assert.equal(runtime.lastCreateOptions?.attachments, undefined, 'session/create never forwards a client-supplied filter')

  await harness.host.call('session/resume', { runtime: 'fake' as never, sessionId: String(created.id) as never, options: { attachments: forged } as never })
  assert.equal(runtime.lastResumeOptions?.attachments, undefined, 'session/resume never forwards a client-supplied filter')

  await harness.host.call('session/fork', { runtime: 'fake' as never, sessionId: String(created.id) as never, options: { attachments: forged } as never }).catch(() => {})
  assert.equal(runtime.lastForkOptions?.attachments, undefined, 'session/fork never forwards a client-supplied filter')
})
