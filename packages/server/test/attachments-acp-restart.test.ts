import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
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

const peer = (store: string, version: string | null): AcpRuntime =>
  new AcpRuntime({
    id: 'rig-agent',
    name: 'Rig Agent',
    brand: 'claudecode',
    command: process.execPath,
    args: [PEER],
    env: { FAKE_ACP_ATTACHMENTS: '1', FAKE_ACP_STORE: store, ...(version ? { FAKE_ACP_AGENT_VERSION: version } : {}) },
  })

const deskAt = async (t: { after(fn: () => unknown): void }, version: string | null) => {
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

  const again = await start({ libraryHome: home }, first.stateDir, peer(store, version) as unknown as FakeRuntime)
  t.after(() => stop(again))
  const reopened = await Client.connect(again.server)
  t.after(() => reopened.close())
  await reopened.call('workspace/open', { path: work })
  return { again, client: reopened, session, seat }
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
