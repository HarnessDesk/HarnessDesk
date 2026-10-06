import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { Session } from '@harnessdesk/protocol'
import { SeatBook } from '../src/evidence/seats.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { Client, halt, start, stop } from './fixtures/harness.js'
import type { FakeRuntime } from './fixtures/fake-runtime.js'
import { tempDir } from './scratch.js'

const PEER = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))

for (const path of ['send', 'resume', 'unlisted resume'] as const) {
  test(`a read seat keeps its ceiling after a fresh runtime through ${path}`, { timeout: 20_000 }, async (t) => {
    const cwd = tempDir('hd-read-restart-work-')
    const store = join(tempDir('hd-read-restart-store-'), 'sessions.json')
    const peer = (unlisted?: string) => new AcpRuntime({
      id: 'reader', name: 'Reader', command: process.execPath, args: [PEER],
      env: { FAKE_ACP_STORE: store, ...(unlisted ? { FAKE_ACP_UNLISTED: unlisted } : {}) },
    })
    const first = await start({}, undefined, peer() as unknown as FakeRuntime)
    const client = await Client.connect(first.server)
    const created = await client.call('session/create', { runtime: 'reader', options: { cwd } }) as Session
    await client.call('turn/send', { runtime: 'reader', sessionId: created.id, input: [{ type: 'text', text: 'persist this turn' }] })
    await client.until(() => client.events.some(event => event.type === 'turn/completed'), 10_000)
    await new SeatBook(new EvidenceStore(join(first.stateDir, 'evidence'))).opened({
      agent: null, briefDigest: null,
      seat: { runtime: 'reader' }, seatLabel: 'Reader', passedOver: [],
      standing: { kind: 'ceiling', level: 'read' }, ceiling: { level: 'read', hold: 'asked' },
      cwd, session: { runtime: 'reader', sessionId: String(created.id) }, board: null, role: null,
    })
    client.close()
    await halt(first)
    const runtime = peer(path === 'unlisted resume' ? String(created.id) : undefined)
    let approvals = 0
    runtime.subscribe(event => {
      if (event.type === 'approval/requested') {
        approvals++
        void runtime.resumeSession(event.approval.sessionId).then(session =>
          session.respondToApproval(event.approval.id, { type: 'option', optionId: 'yes' }))
      }
    })
    const again = await start({}, first.stateDir, runtime as unknown as FakeRuntime)
    t.after(() => stop(again))
    const resumed = await Client.connect(again.server)
    t.after(() => resumed.close())
    if (path !== 'send') await resumed.call('session/resume', { runtime: 'reader', sessionId: created.id })
    await resumed.call('turn/send', { runtime: 'reader', sessionId: created.id,
      input: [{ type: 'text', text: 'ceiling permission {"toolCallId":"restart-edit","title":"Edit","kind":"edit"}' }] })
    await resumed.until(() => resumed.events.some(event => event.type === 'turn/completed'), 10_000)
    const turn = resumed.events.findLast(event => event.type === 'turn/completed')
    assert.equal(turn?.type, 'turn/completed')
    assert.ok(turn.turn.items.some(item => item.type === 'notice' && item.text === 'Edit was refused by the Read only ceiling.'))
    assert.ok(turn.turn.items.some(item => item.type === 'assistantMessage' && item.text === 'denied.'))
    assert.equal(approvals, 0)
  })
}
