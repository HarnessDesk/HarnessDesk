import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentSession } from '@harnessdesk/protocol'
import { AcpRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

test('a read seat refuses write, execution and unknown permission requests before approval', { timeout: 10_000 }, async () => {
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE] })
  const approvals: AgentEvent[] = []
  let active: AgentSession | undefined
  runtime.subscribe(event => {
    if (event.type === 'approval/requested') {
      approvals.push(event)
      // Even an approval policy that admits everything cannot lift a read ceiling.
      void active?.respondToApproval(event.approval.id, { type: 'option', optionId: 'yes' })
    }
  })
  await runtime.start()
  try {
    assert.equal(runtime.info.ceilings, undefined, 'host permission refusal alone cannot hold native tools')
    const session = await runtime.createSession({ cwd: '/tmp/acp-read-seat', requestedCeiling: 'read' })
    active = session
    for (const kind of ['edit', 'delete', 'move', 'execute', 'switch_mode', 'other', undefined]) {
      const done = new Promise<Extract<AgentEvent, { type: 'turn/completed' }>>(resolve => {
        const off = runtime.subscribe(event => { if (event.type === 'turn/completed') { off(); resolve(event) } })
      })
      await session.send([{ type: 'text', text: `ceiling permission ${JSON.stringify({ toolCallId: `tool-${kind}`, title: 'Read', kind, rawInput: { command: 'touch changed.txt' } })}` }])
      const turn = (await done).turn
      assert.equal(turn.status, 'completed')
      assert.ok(turn.items.some(item => item.type === 'assistantMessage' && item.text === 'denied.'), `${kind} must be refused`)
    }
    assert.equal(approvals.length, 0, 'write requests never reach an approval policy or the person')
  } finally { await runtime.dispose() }
})

test('trusted desk tools use their ceiling even when the generic kind disagrees', { timeout: 10_000 }, async (t) => {
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE], trustsBridgeProvenance: true })
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp/acp-read-tools', requestedCeiling: 'read' })
  let approvals = 0
  runtime.subscribe(event => {
    if (event.type === 'approval/requested') {
      approvals += 1
      void session.respondToApproval(event.approval.id, { type: 'option', optionId: 'yes' })
    }
  })
  for (const [tool, kind, result] of [['git_status', 'other', 'allowed.'], ['commit_work', 'read', 'denied.'], ['unknown', 'read', 'denied.']] as const) {
    const done = new Promise<Extract<AgentEvent, { type: 'turn/completed' }>>(resolve => {
      const off = runtime.subscribe(event => { if (event.type === 'turn/completed') { off(); resolve(event) } })
    })
    await session.send([{ type: 'text', text: `ceiling permission ${JSON.stringify({
      toolCall: { toolCallId: tool, kind },
      _meta: { harnessdesk: { flowBoardTool: { server: 'harnessdesk', tool: `mcp__harnessdesk__${tool}` } } },
    })}` }])
    assert.ok((await done).turn.items.some(item => item.type === 'assistantMessage' && item.text === result), tool)
  }
  assert.equal(approvals, 1)
})

test('read and search permissions pass, and an edit seat retains its normal approval path', { timeout: 10_000 }, async () => {
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE] })
  let approvals = 0
  let active: AgentSession | undefined
  runtime.subscribe(event => {
    if (event.type === 'approval/requested') {
      approvals += 1
      void active?.respondToApproval(event.approval.id, { type: 'option', optionId: 'yes' })
    }
  })
  await runtime.start()
  try {
    for (const [ceiling, kinds] of [['read', ['read', 'search']], ['edit', ['edit']]] as const) {
      const session = await runtime.createSession({ cwd: '/tmp/acp-permissions', requestedCeiling: ceiling })
      active = session
      for (const kind of kinds) {
        const done = new Promise<Extract<AgentEvent, { type: 'turn/completed' }>>(resolve => {
          const off = runtime.subscribe(event => { if (event.type === 'turn/completed') { off(); resolve(event) } })
        })
        await session.send([{ type: 'text', text: `ceiling permission ${JSON.stringify({ toolCallId: kind, kind })}` }])
        assert.ok((await done).turn.items.some(item => item.type === 'assistantMessage' && item.text === 'allowed.'))
      }
    }
    assert.equal(approvals, 3)
  } finally { await runtime.dispose() }
})

test('a read seat still refuses writes after its handle is closed and loaded again', { timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-read-reopen-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE], env: { FAKE_ACP_STORE: join(cwd, 'store.json') } })
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd, requestedCeiling: 'read' })
  // Complete a turn so the peer persists a conversation that can be loaded.
  const completed = () => new Promise<Extract<AgentEvent, { type: 'turn/completed' }>>(resolve => {
    const off = runtime.subscribe(event => { if (event.type === 'turn/completed') { off(); resolve(event) } })
  })
  let done = completed()
  await session.send([{ type: 'text', text: 'Remember this conversation' }])
  await done
  await session.close()
  const resumed = await runtime.resumeSession(session.id, { knownCwd: cwd })
  let approvals = 0
  runtime.subscribe(event => {
    if (event.type === 'approval/requested') {
      approvals += 1
      void resumed.respondToApproval(event.approval.id, { type: 'option', optionId: 'yes' })
    }
  })
  done = completed()
  await resumed.send([{ type: 'text', text: 'ceiling permission {"toolCallId":"write-after-load","kind":"edit"}' }])
  assert.ok((await done).turn.items.some(item => item.type === 'assistantMessage' && item.text === 'denied.'))
  assert.equal(approvals, 0)
})
