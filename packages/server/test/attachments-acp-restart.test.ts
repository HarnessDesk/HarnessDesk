import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { AttachmentReview, Session } from '@harnessdesk/protocol'

import type { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, halt, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * Restart, then reopen, through the real ACP adapter over a real peer
 * process — not the in-memory fake runtime. The app's own order matters: it
 * *reads* a conversation (which, over ACP, is a `session/load`) before it
 * resumes it, and the read carries no filter. A reopen that then found the
 * conversation already live and handed it back as it was would leave the
 * Seat unfiltered and record every declaration as "Loading failed".
 */

const PEER = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))
const MCP = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

const peer = (store: string, version: string | null, opens?: string): AcpRuntime =>
  new AcpRuntime({
    id: 'rig-agent',
    name: 'Rig Agent',
    brand: 'claudecode',
    command: process.execPath,
    args: [PEER],
    env: {
      FAKE_ACP_ATTACHMENTS: '1',
      FAKE_ACP_STORE: store,
      ...(version ? { FAKE_ACP_AGENT_VERSION: version } : {}),
      ...(opens ? { FAKE_ACP_OPENS: opens } : {}),
    },
  })

const deskAt = async (
  t: { after(fn: () => unknown): void },
  version: string | null,
  options: { readonly opens?: string; readonly forgetTranscripts?: boolean } = {},
) => {
  const home = tempDir('hd-acp-restart-home-')
  const store = join(tempDir('hd-acp-restart-store-'), 'sessions.json')
  const work = tempDir('hd-acp-restart-work-')
  execFileSync('git', ['init', '-q', work])
  await writeFile(join(work, '.mcp.json'), JSON.stringify({ mcpServers: { 'reviewer-tools': { command: process.execPath, args: [MCP] } } }))
  const first = await start({ libraryHome: home }, undefined, peer(store, version) as unknown as FakeRuntime)
  const agentDir = join(first.stateDir, 'agents', 'reviewer')
  await mkdir(join(agentDir, 'skills', 'demo'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nCheck the diff.\n')
  await writeFile(join(agentDir, 'AGENT.md'), '---\nname: Reviewer\nceiling: merge\nprefer: [rig-agent]\nskills: [demo]\nmcp: [reviewer-tools]\n---\nRead the diff.\n')
  const client = await Client.connect(first.server)
  await client.call('workspace/open', { path: work })
  const review = (await client.call('attachment/review', { id: 'reviewer', origin: 'user', root: work })) as AttachmentReview
  await client.call('attachment/approve', { token: review.token })
  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work, project: work, permission: 'merge' })) as Session
  const seat = first.host.registry.attachmentSeatOf(session.runtime, session.id)!
  const opened = await first.host.attachmentsPlane.read(seat)
  assert.deepEqual(opened?.results.map((one) => one.status), ['loaded', 'loaded'], 'loaded at open')
  // The store is written when the Seat's first turn ends.
  for (let tries = 0; tries < 100; tries += 1) {
    const read = (await client.call('session/read', { runtime: 'rig-agent', sessionId: String(session.id) })) as Session
    if (!read.turns.some((turn) => turn.status === 'inProgress')) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  client.close()
  await halt(first)
  if (options.forgetTranscripts) await rm(join(first.stateDir, 'transcripts'), { recursive: true, force: true })

  const runtime = peer(store, version, options.opens)
  const again = await start({ libraryHome: home }, first.stateDir, runtime as unknown as FakeRuntime)
  t.after(() => stop(again))
  const reopened = await Client.connect(again.server)
  t.after(() => reopened.close())
  await reopened.call('workspace/open', { path: work })
  return { again, client: reopened, session, seat, runtime }
}

const statuses = (record: { readonly results: readonly { identity: { kind: string }; status: string; reason: string | null }[] } | null) =>
  record?.results.map((one) => `${one.identity.kind}:${one.status}${one.reason ? ` — ${one.reason}` : ''}`)

test('restart, then read and resume as the app does: the Seat reopens on its filter and its approved content loads again', async (t) => {
  const { again, client, session, seat } = await deskAt(t, '1.0.0')
  // The app reads a conversation before it resumes it; over ACP a read is a load, with no filter.
  await client.call('session/read', { runtime: 'rig-agent', sessionId: String(session.id) })
  await client.call('session/resume', { runtime: 'rig-agent', sessionId: String(session.id) })
  const record = await again.host.attachmentsPlane.read(seat)
  assert.equal(record?.epoch, 1)
  assert.deepEqual(statuses(record), ['skill:loaded', 'mcp:loaded'])
})

test('a restart onto a different build says the approval no longer covers it, and what to do — never "Loading failed"', async (t) => {
  // Unpinned: the peer reports its pid as its version, so every launch is a new build.
  const { again, client, session, seat } = await deskAt(t, null)
  await client.call('session/read', { runtime: 'rig-agent', sessionId: String(session.id) })
  await client.call('session/resume', { runtime: 'rig-agent', sessionId: String(session.id) })
  const record = await again.host.attachmentsPlane.read(seat)
  assert.equal(record?.epoch, 1)
  for (const one of record!.results) {
    assert.equal(one.status, 'not-loaded')
    assert.match(one.reason ?? '', /approved for another build of this agent/)
    assert.match(one.reason ?? '', /review it again/)
    assert.doesNotMatch(one.reason ?? '', /Loading failed/)
  }
})

const loadsOf = async (opens: string, sessionId: string) =>
  (await readFile(opens, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; sessionId: string; filtered?: boolean })
    .filter((one) => one.method === 'session/load' && one.sessionId === sessionId)

for (const [how, forgetTranscripts] of [
  ['from the transcript this desk kept', false],
  ['when this desk kept no transcript of it', true],
] as const) {
  test(`after a restart, reading a filtered Seat’s conversation never opens it on the agent unfiltered — ${how}`, async (t) => {
    const opens = join(tempDir('hd-acp-restart-opens-'), 'opens.ndjson')
    const { again, client, session, seat } = await deskAt(t, '1.0.0', { opens, forgetTranscripts })
    const read = (await client.call('session/read', { runtime: 'rig-agent', sessionId: String(session.id) })) as Session
    assert.ok(read.turns.length > 0, 'the read still shows the conversation')
    const afterRead = await loadsOf(opens, String(session.id))
    assert.deepEqual(afterRead.filter((one) => !one.filtered), [], 'the peer never saw an unfiltered load of this Seat’s conversation')
    await client.call('session/resume', { runtime: 'rig-agent', sessionId: String(session.id) })
    const loads = await loadsOf(opens, String(session.id))
    assert.ok(loads.length > 0 && loads.every((one) => one.filtered), JSON.stringify(loads))
    assert.deepEqual(statuses(await again.host.attachmentsPlane.read(seat))?.slice(-2), ['skill:loaded', 'mcp:loaded'])
  })
}

test('a turn a reconnect started survives a session/resume that arrives while the reconnect is still opening it: one reopen, one epoch', async (t) => {
  const opens = join(tempDir('hd-acp-race-opens-'), 'opens.ndjson')
  const { again, client, session, seat, runtime } = await deskAt(t, '1.0.0', { opens })
  // Hold the one reopen in the agent until both callers have asked for it.
  const real = runtime.resumeSession.bind(runtime)
  let entered = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let firstEntered!: () => void
  const firstIn = new Promise<void>((resolve) => { firstEntered = resolve })
  runtime.resumeSession = async (...args: Parameters<typeof real>) => {
    entered += 1
    firstEntered()
    await gate
    return real(...args)
  }
  const id = String(session.id)
  // A reconnect: the next message to the conversation reopens it (through the host's shared reopen).
  const sent = client.call('turn/send', { runtime: 'rig-agent', sessionId: id, input: [{ type: 'text', text: 'slow' }] })
  await firstIn
  // The person opens the same conversation while that reopen is in flight.
  const resumed = client.call('session/resume', { runtime: 'rig-agent', sessionId: id })
  // Released once the second caller has either joined the reopen in flight or started a second one.
  for (let turns = 0; entered < 2 && again.host.reopenWaiters('rig-agent', id) < 1; turns += 1) {
    if (turns > 10_000) throw new Error('the second caller never arrived')
    await new Promise((resolve) => setImmediate(resolve))
  }
  release()
  await sent
  await resumed
  assert.equal(entered, 1, 'one reopen served both callers')
  const loads = (await readFile(opens, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method: string; sessionId: string })
    .filter((one) => one.method === 'session/load' && one.sessionId === id)
  assert.equal(loads.length, 1, 'the conversation was loaded once, never dropped and loaded again under the running turn')
  const record = await again.host.attachmentsPlane.read(seat)
  assert.equal(record?.epoch, 1, 'one reopen, one epoch')
  const live = again.host.registry.get('rig-agent' as never, id as never)
  assert.ok(live?.running.size, 'the turn the reconnect started is still running — nothing cancelled it')
  await client.call('turn/interrupt', { runtime: 'rig-agent', sessionId: id }).catch(() => {})
})

/*
 * #895. When this desk has let a conversation's handle go but the agent still
 * holds it, a reopen is answered with that same session — still on the
 * filter an earlier reopen gave it. Its receipt answers for that earlier key,
 * and used to be taken as "nothing loaded": the Seat's new epoch said every
 * attachment failed, and the Seat lost its servers at the gateway.
 */
test('a resume the agent answers with the conversation it still held records what it loaded, and keeps the Seat’s servers', async (t) => {
  const { again, client, session, seat } = await deskAt(t, '1.0.0')
  const id = String(session.id)
  await client.call('session/read', { runtime: 'rig-agent', sessionId: id })
  await client.call('session/resume', { runtime: 'rig-agent', sessionId: id })
  assert.equal((await again.host.attachmentsPlane.read(seat))?.epoch, 1)
  assert.equal(again.host.attachmentsPlane.liveServersFor(seat)?.length, 1)
  // The desk lets the handle go; the agent keeps the session open.
  const record = again.host.registry.get('rig-agent' as never, id as never)
  assert.ok(record?.live)
  record.live = null
  await client.call('session/resume', { runtime: 'rig-agent', sessionId: id })
  const latest = await again.host.attachmentsPlane.read(seat)
  assert.equal(latest?.epoch, 2)
  assert.deepEqual(statuses(latest), ['skill:loaded', 'mcp:loaded'])
  assert.equal(again.host.attachmentsPlane.liveServersFor(seat)?.length, 1, 'and the Seat still reaches its server')
})
