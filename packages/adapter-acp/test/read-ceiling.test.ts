import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentSession } from '@harnessdesk/protocol'
import { AcpRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

const sendTurn = async (runtime: AcpRuntime, session: AgentSession, text: string) => {
  const done = new Promise<Extract<AgentEvent, { type: 'turn/completed' }>>(resolve => {
    const off = runtime.subscribe(event => {
      if (event.type === 'turn/completed' && event.sessionId === session.id) { off(); resolve(event) }
    })
  })
  await session.send([{ type: 'text', text }])
  return (await done).turn
}

for (const path of ['already open', 'still loading'] as const) {
  test(`a resume records the read ceiling when the conversation is ${path}`, { timeout: 10_000 }, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'acp-read-promote-'))
    t.after(() => rm(cwd, { recursive: true, force: true }))
    const opens = join(cwd, 'opens.jsonl')
    const gate = join(cwd, 'release-load')
    const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE],
      env: { FAKE_ACP_STORE: join(cwd, 'store.json'), FAKE_ACP_OPENS: opens,
        ...(path === 'still loading' ? { FAKE_ACP_LOAD_GATE: gate } : {}) } })
    t.after(() => runtime.dispose())
    await runtime.start()
    const original = await runtime.createSession({ cwd })
    await sendTurn(runtime, original, 'persist')
    let reading: ReturnType<AcpRuntime['readSession']> | undefined
    if (path === 'still loading') {
      await original.close()
      const loading = new Promise<void>(resolve => {
        const watcher = watch(opens, async () => {
          if ((await readFile(opens, 'utf8')).includes('session/load')) { watcher.close(); resolve() }
        })
        t.after(() => watcher.close())
      })
      reading = runtime.readSession(original.id)
      await loading
    }
    const resuming = runtime.resumeSession(original.id, { knownCwd: cwd, requestedCeiling: 'read' })
    if (reading) await writeFile(gate, 'release')
    const resumed = await resuming
    if (reading) await reading
    else assert.equal(resumed, original, 'an asked ceiling does not need to reload an open handle')
    let approvals = 0
    runtime.subscribe(event => {
      if (event.type === 'approval/requested') {
        approvals++
        void resumed.respondToApproval(event.approval.id, { type: 'option', optionId: 'yes' })
      }
    })
    const turn = await sendTurn(runtime, resumed, 'ceiling permission {"toolCallId":"write-after-resume","kind":"edit"}')
    assert.ok(turn.items.some(item => item.type === 'assistantMessage' && item.text === 'denied.'))
    assert.equal(approvals, 0, 'a resumed read request never reaches approval')
  })
}

test('a native guard reloads an idle open conversation with the read ceiling', { timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-held-promote-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const opens = join(cwd, 'opens.jsonl')
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_STORE: join(cwd, 'store.json'), FAKE_ACP_READ_CEILING: '1', FAKE_ACP_OPENS: opens, FAKE_ACP_ATTACHMENTS: '1' } })
  t.after(() => runtime.dispose())
  await runtime.start()
  const original = await runtime.createSession({ cwd, attachments: { key: 'kept-filter', skills: [], mcp: null } })
  await sendTurn(runtime, original, 'persist')
  const resumed = await runtime.resumeSession(original.id, { knownCwd: cwd, requestedCeiling: 'read' })
  assert.notEqual(resumed, original, 'the unguarded handle must be replaced')
  assert.equal(await runtime.resumeSession(original.id, { requestedCeiling: 'read' }), resumed, 'a guarded handle stays open')
  assert.equal((await runtime.attachmentReceipt(resumed.id)).key, 'kept-filter', 'guard acquisition retains the live handle’s frozen attachments')
  const recorded = (await readFile(opens, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(recorded.map(open => [open.method, open.ceiling]), [['session/new', null], ['session/load', 'read']])
  assert.deepEqual(recorded.map(open => open.filtered), [true, true], 'the native reload carries the same frozen filter')
})

test('a native guard refuses a read resume while the unguarded conversation is busy', { timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-held-busy-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_STORE: join(cwd, 'store.json'), FAKE_ACP_READ_CEILING: '1' } })
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd })
  await sendTurn(runtime, session, 'persist')
  const requested = new Promise<Extract<AgentEvent, { type: 'approval/requested' }>>(resolve => {
    const off = runtime.subscribe(event => { if (event.type === 'approval/requested') { off(); resolve(event) } })
  })
  const turn = sendTurn(runtime, session, 'ceiling permission {"toolCallId":"pending-read","kind":"read"}')
  const approval = await requested
  await assert.rejects(runtime.resumeSession(session.id, { knownCwd: cwd, requestedCeiling: 'read' }), /read ceiling.*turn.*running/i)
  await session.respondToApproval(approval.approval.id, { type: 'option', optionId: 'yes' })
  await turn
  assert.notEqual(await runtime.resumeSession(session.id, { knownCwd: cwd }), session, 'the next idle resume still applies the requested ceiling')
})

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
    for (const kind of ['edit', 'delete', 'move', 'execute', 'switch_mode', 'fetch', 'other', undefined]) {
      const done = new Promise<Extract<AgentEvent, { type: 'turn/completed' }>>(resolve => {
        const off = runtime.subscribe(event => { if (event.type === 'turn/completed') { off(); resolve(event) } })
      })
      await session.send([{ type: 'text', text: `ceiling permission ${JSON.stringify({ toolCallId: `tool-${kind}`, title: 'Read', kind, rawInput: { command: 'touch changed.txt' } })}` }])
      const turn = (await done).turn
      assert.equal(turn.status, 'completed')
      assert.ok(turn.items.some(item => item.type === 'assistantMessage' && item.text === 'denied.'), `${kind} must be refused`)
      assert.ok(turn.items.some(item => item.type === 'notice' && item.text === 'Read was refused by the Read only ceiling.'), `${kind} names the refusal in the transcript`)
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
    for (const [ceiling, kinds] of [['read', ['read', 'search', 'think']], ['edit', ['edit']]] as const) {
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
    assert.equal(approvals, 4)
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

test('asked read seats select a reject option and keep question and provenance boundaries', { timeout: 10_000 }, async (t) => {
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE] })
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/tmp/acp-read-boundaries', requestedCeiling: 'read' })
  const approvals: AgentEvent[] = []
  runtime.subscribe(event => {
    if (event.type === 'approval/requested') {
      approvals.push(event)
      void session.respondToApproval(event.approval.id, event.approval.type === 'userInput'
        ? { type: 'answers', answers: { q: ['yes'] } }
        : { type: 'option', optionId: 'yes' })
    }
  })
  const question = { question: 'Which file?', options: [{ label: 'Allow once' }] }
  const reject = { outcome: 'selected', optionId: 'no' }
  const cases = [
    { name: 'prefer reject once', toolCall: { toolCallId: 'reject', kind: 'edit' },
      options: [{ optionId: 'never', name: 'Reject always', kind: 'reject_always' },
        { optionId: 'no', name: 'Reject once', kind: 'reject_once' }], expected: reject },
    { name: 'reject always fallback', toolCall: { toolCallId: 'reject-always', kind: 'edit' },
      options: [{ optionId: 'never', name: 'Reject', kind: 'reject_always' }], expected: { outcome: 'selected', optionId: 'never' } },
    { name: 'cancel without reject', toolCall: { toolCallId: 'cancel', kind: 'edit' },
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }], expected: { outcome: 'cancelled' } },
    { name: 'untrusted provenance', toolCall: { toolCallId: 'spoof', kind: 'other' },
      _meta: { harnessdesk: { flowBoardTool: { server: 'harnessdesk', tool: 'mcp__harnessdesk__git_status' } } }, expected: reject },
    { name: 'fetch', toolCall: { toolCallId: 'fetch', kind: 'fetch' }, expected: reject },
    { name: 'question', toolCall: { toolCallId: 'question', rawInput: { questions: [question] } }, expected: { outcome: 'selected', optionId: 'yes' } },
    { name: 'edit question', toolCall: { toolCallId: 'edit-question', kind: 'edit', rawInput: { questions: [question] } }, expected: reject },
    { name: 'execute question', toolCall: { toolCallId: 'execute-question', kind: 'execute' },
      _meta: { harnessdesk: { question } }, expected: reject },
  ]
  for (const { name, expected, ...input } of cases) {
    await t.test(name, async () => {
      const done = new Promise<Extract<AgentEvent, { type: 'turn/completed' }>>(resolve => {
        const off = runtime.subscribe(event => { if (event.type === 'turn/completed') { off(); resolve(event) } })
      })
      await session.send([{ type: 'text', text: `ceiling permission ${JSON.stringify({ ...input, reportOutcome: true })}` }])
      const item = (await done).turn.items.find(item => item.type === 'assistantMessage')
      assert.equal(item?.type, 'assistantMessage')
      assert.deepEqual(JSON.parse(item.text), expected)
    })
  }
  assert.equal(approvals.length, 1, 'only the non-mutating question reaches the person')
})

test('a held peer receives the remembered ceiling on load, and non-read loads stay unchanged', { timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-held-resume-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const opens = join(cwd, 'opens.jsonl')
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE],
    env: { FAKE_ACP_STORE: join(cwd, 'store.json'), FAKE_ACP_READ_CEILING: '1', FAKE_ACP_OPENS: opens } })
  t.after(() => runtime.dispose())
  await runtime.start()
  for (const ceiling of ['read', 'edit'] as const) {
    const session = await runtime.createSession({ cwd, requestedCeiling: ceiling })
    const done = new Promise<void>(resolve => {
      const off = runtime.subscribe(event => { if (event.type === 'turn/completed') { off(); resolve() } })
    })
    await session.send([{ type: 'text', text: 'persist' }])
    await done
    await session.close()
    const resumed = await runtime.resumeSession(session.id, { knownCwd: cwd })
    await resumed.close()
  }
  const loads = (await readFile(opens, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { method: string; ceiling: string | null })
    .filter(open => open.method === 'session/load')
  assert.deepEqual(loads.map(open => open.ceiling), ['read', null])
})

test('a read ceiling supplied at resume is remembered on a peer without a native guard', { timeout: 10_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-read-resume-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const runtime = new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath, args: [FAKE], env: { FAKE_ACP_STORE: join(cwd, 'store.json') } })
  t.after(() => runtime.dispose())
  await runtime.start()
  const original = await runtime.createSession({ cwd })
  const send = async (session: AgentSession, text: string) => {
    const done = new Promise<Extract<AgentEvent, { type: 'turn/completed' }>>(resolve => {
      const off = runtime.subscribe(event => { if (event.type === 'turn/completed') { off(); resolve(event) } })
    })
    await session.send([{ type: 'text', text }])
    return (await done).turn
  }
  await send(original, 'persist')
  await original.close()
  const resumed = await runtime.resumeSession(original.id, { knownCwd: cwd, requestedCeiling: 'read' })
  let approvals = 0
  runtime.subscribe(event => {
    if (event.type === 'approval/requested') {
      approvals++
      void runtime.resumeSession(original.id).then(active => active.respondToApproval(event.approval.id, { type: 'option', optionId: 'yes' }))
    }
  })
  assert.ok((await send(resumed, 'ceiling permission {"toolCallId":"write","kind":"edit"}')).items.some(item => item.type === 'assistantMessage' && item.text === 'denied.'))
  await resumed.close()
  const reopened = await runtime.resumeSession(original.id, { knownCwd: cwd })
  assert.ok((await send(reopened, 'ceiling permission {"toolCallId":"write-again","kind":"edit"}')).items.some(item => item.type === 'assistantMessage' && item.text === 'denied.'))
  assert.equal(approvals, 0)
})
