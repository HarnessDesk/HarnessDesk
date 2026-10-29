import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test from 'node:test'
import { createLeadJournal, type LeadPermissionContext, type LeadPermissionCall } from '@harnessdesk/lead'
import { runtimeId, sessionId } from '@harnessdesk/protocol'
import { LeadControls } from '../src/lead/controls.js'
import { QUEUE_LIMIT } from '../src/registry.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'

/** Real HostContext and ordinary fake-runtime lifecycle; no child or vendor traffic. */
test('Lead ordinary chats use selected runtime/defaults, queue and interrupt without Flow ownership', async t => {
  const { host, runtime, repo } = await evidenceDesk(t, { leadEnabled: true })
  const project = { id: 'project-demo', path: await realpath(repo.dir) }, now = Date.now()
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'ordinary-delegation', now, caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null,
    budget: null, now: Date.now(), policyInterpretation: 'idle' })
  const service = host.createLeadService({ journal, project, prices: {},
    resolveTool: async () => ({ project, runId: null, start: null, stepId: null, context: context() }),
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }),
  })
  await service.setEnabled(true)
  let attempt = 0
  const execute = async (call: LeadPermissionCall) => {
    const result = await journal.execute({ id: `chat-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
      async parsed => ({ value: await host.call(parsed.method, parsed.params as never), identity: null }))
    assert.equal(result.decision.effect, 'allow', result.decision.reason)
    assert.equal(result.outcome, 'succeeded')
    return result.value as any
  }
  const created = await execute({ method: 'lead/chat/start', params: { text: 'Inspect the task' } })
  assert.equal(typeof created.id, 'string'); assert.equal(created.problem, undefined)
  assert.equal(runtime.lastCreateOptions?.cwd, project.path)
  assert.equal(runtime.lastCreateOptions?.permission, undefined, 'ordinary session creation carries no Lead permission override')
  assert.equal(journal.state.runs.length, 0, 'ordinary work does not become a Flow run or claim its allowance')
  const listed = await host.call('lead/chat/list', {})
  assert.ok(listed.items.some(item => item.id === created.id))
  const read = await host.call('lead/chat/read', { id: created.id })
  assert.equal(read.id, created.id)
  const key = created.id.slice(created.id.indexOf(':') + 1), record = host.registry.get(runtimeId('fake'), sessionId(key))!
  assert.ok(record.running.size > 0)
  const reply = await execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Follow up' } })
  assert.equal(reply.queued, true, 'a busy ordinary session queues the reply')
  await execute({ method: 'lead/chat/stop', params: { id: created.id } })
  await assert.rejects(host.call('lead/chat/send', { id: created.id, text: 'Unjournaled' }), /attempt/i)
})

const refusalRig = async (t: import('node:test').TestContext) => {
  const { StateStore } = await import('../src/index.js')
  const { tempDir } = await import('./scratch.js')
  const state = new StateStore(`${tempDir('hd-chat-refusal-state-')}/state.json`)
  const desk = await evidenceDesk(t, { leadEnabled: true, state })
  const project = { id: 'project-demo', path: await realpath(desk.repo.dir) }
  const records: import('@harnessdesk/lead').LeadJournalRecord[] = []
  const journal = await createLeadJournal({ read: async () => [], append: async record => { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'ordinary-delegation', now: Date.now(), caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null,
    budget: null, now: Date.now(), policyInterpretation: 'idle' })
  const service = desk.host.createLeadService({ journal, project, prices: {},
    resolveTool: async () => ({ project, runId: null, start: null, stepId: null, context: context() }),
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }),
  })
  await service.setEnabled(true)
  let attempt = 0
  const execute = (call: LeadPermissionCall) => journal.execute({ id: `refusal-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
    async parsed => ({ value: await desk.host.call(parsed.method, parsed.params as never), identity: null }))
  return { ...desk, project, state, journal, records, execute }
}

test('a missing ordinary runtime refuses without poisoning a corrected chat start', async t => {
  const r = await refusalRig(t)
  await r.host.unregister(r.runtime.info.id)
  const call: LeadPermissionCall = { method: 'lead/chat/start', params: { text: 'Inspect the task' } }
  assert.equal((await r.execute(call)).outcome, 'failed')
  const { FakeRuntime } = await import('./fixtures/fake-runtime.js')
  r.host.register(new FakeRuntime())
  assert.equal((await r.execute(call)).outcome, 'succeeded')
  const replayed = await createLeadJournal({ read: async () => r.records, append: async () => {} })
  assert.equal(replayed.state.attempts.get('refusal-1')?.outcome, 'failed')
})

test('invalid saved defaults refuse before allocation and permit a corrected chat start', async t => {
  const r = await refusalRig(t)
  await r.state.setPreferences({ draftValues: { [r.runtime.info.id]: { model: 'gone' } } })
  const call: LeadPermissionCall = { method: 'lead/chat/start', params: { text: 'Inspect the task' } }
  assert.equal((await r.execute(call)).outcome, 'failed')
  assert.equal(r.runtime.sessions.size, 0)
  await r.state.setPreferences({ draftValues: {} })
  assert.equal((await r.execute(call)).outcome, 'succeeded')
})

test('paused ordinary queues refuse without poisoning a corrected chat send', async t => {
  const r = await refusalRig(t)
  const created = (await r.execute({ method: 'lead/chat/start', params: { text: 'First' } })).value as { id: string }
  const target = { runtime: r.runtime.info.id, sessionId: sessionId(created.id.slice(created.id.indexOf(':') + 1)) }
  const record = r.host.registry.get(target.runtime, target.sessionId)!
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Earlier reply' } })
  r.host.registry.pauseQueue(record, 'Synthetic pause')
  const call: LeadPermissionCall = { method: 'lead/chat/send', params: { id: created.id, text: 'Follow up' } }
  assert.equal((await r.execute(call)).outcome, 'failed')
  assert.equal(record.queue.messages.length, 1)
  r.host.registry.resumeQueue(record)
  assert.equal((await r.execute(call)).outcome, 'succeeded')
  assert.equal(record.queue.messages.length, 2)
})

test('an unknown ordinary create failure remains uncertain and blocks another start', async t => {
  const r = await refusalRig(t)
  const create = r.runtime.createSession.bind(r.runtime)
  r.runtime.createSession = async options => { await create(options); throw new Error('Synthetic lost allocation response') }
  const call: LeadPermissionCall = { method: 'lead/chat/start', params: { text: 'First' } }
  assert.equal((await r.execute(call)).outcome, 'uncertain')
  assert.equal(r.runtime.sessions.size, 1)
  r.runtime.createSession = create
  assert.equal((await r.execute(call)).outcome, 'denied')
  assert.equal(r.runtime.sessions.size, 1)
})

test('an archived ordinary target refuses before dispatch and permits send after restore', async t => {
  const r = await refusalRig(t)
  const created = await r.host.call('session/create', { runtime: r.runtime.info.id, options: { cwd: r.repo.dir } })
  const target = { runtime: r.runtime.info.id, sessionId: created.id }
  const call: LeadPermissionCall = { method: 'lead/chat/send', params: { id: `${target.runtime}:${target.sessionId}`, text: 'Follow up' } }
  await r.host.call('session/archive', { ...target, archived: true })
  assert.equal((await r.execute(call)).outcome, 'failed')
  await r.host.call('session/archive', { ...target, archived: false })
  assert.equal((await r.execute(call)).outcome, 'succeeded')
})

test('an unknown ordinary send failure cannot supply its own no-effect proof or be retried', async t => {
  const r = await refusalRig(t)
  const created = await r.host.call('session/create', { runtime: r.runtime.info.id, options: { cwd: r.repo.dir } })
  const live = r.runtime.sessions.get(created.id)!, send = live.send.bind(live)
  let dispatches = 0
  live.send = async input => { dispatches++; await send(input); throw Object.assign(new Error('Synthetic lost send response'), { noEffect: true }) }
  const call: LeadPermissionCall = { method: 'lead/chat/send', params: { id: `${r.runtime.info.id}:${created.id}`, text: 'Follow up' } }
  assert.equal((await r.execute(call)).outcome, 'uncertain')
  live.send = send
  assert.equal((await r.execute(call)).outcome, 'denied')
  assert.equal(dispatches, 1)
  assert.equal(r.host.registry.get(r.runtime.info.id, created.id)!.queue.messages.length, 0)
})

test('an unconfirmed first prompt retains its allocated ordinary chat identity', async t => {
  const r = await refusalRig(t)
  r.runtime.onSend = () => { throw new Error('Synthetic lost first-send response') }
  const result = await r.execute({ method: 'lead/chat/start', params: { text: 'First' } })
  assert.equal(result.outcome, 'succeeded')
  const created = result.value as { id: string; problem?: string }
  assert.equal(typeof created.id, 'string')
  assert.match(created.problem!, /could not be confirmed/)
  assert.equal(r.runtime.sessions.size, 1)
})

test('a full ordinary queue refuses before mutation and permits send after clearing it', async t => {
  const r = await refusalRig(t)
  const created = (await r.execute({ method: 'lead/chat/start', params: { text: 'First' } })).value as { id: string }
  const record = r.host.registry.get(r.runtime.info.id, sessionId(created.id.slice(created.id.indexOf(':') + 1)))!
  for (let i = 0; i < QUEUE_LIMIT; i++) r.host.registry.enqueue(record, `existing-${i}`, [{ type: 'text', text: 'Earlier reply' }])
  const call: LeadPermissionCall = { method: 'lead/chat/send', params: { id: created.id, text: 'Follow up' } }
  assert.equal((await r.execute(call)).outcome, 'failed')
  assert.equal(record.queue.messages.length, QUEUE_LIMIT)
  r.host.registry.clearQueue(record)
  assert.equal((await r.execute(call)).outcome, 'succeeded')
  assert.equal(record.queue.messages.length, 1)
})


for (const operation of ['start', 'send'] as const) test(`real chat ${operation} post-effect failure allows only person Stop then a fresh request`, async t => {
  const r = await refusalRig(t)
  let effects = 0, requests = 0, target: string | null = null
  if (operation === 'start') {
    const create = r.runtime.createSession.bind(r.runtime)
    r.runtime.createSession = async options => { effects++; await create(options); throw new Error('Lost allocation response after creation') }
  } else {
    const created = await r.host.call('session/create', { runtime: r.runtime.info.id, options: { cwd: r.repo.dir } })
    target = `${r.runtime.info.id}:${created.id}`
    const live = r.runtime.sessions.get(created.id)!, send = live.send.bind(live)
    live.send = async input => { effects++; await send(input); throw new Error('Lost turn response after send') }
  }
  const controls = new LeadControls({ journal: r.journal, project: r.project, model: 'fixture-model', now: () => Date.now(), nextId: () => 'fresh-logical-goal',
    push() {}, decidePerson: async () => {}, decideResult: async () => {}, stopEffects: async () => {},
    service: { status: async () => ({ configured: true, protection: 'synthetic' }), assertPublic: async () => {}, setKey: async () => {}, deleteKey: async () => {},
      send: async () => {
        if (++requests === 1) {
          const call: LeadPermissionCall = operation === 'start' ? { method: 'lead/chat/start', params: { text: 'Original task' } }
            : { method: 'lead/chat/send', params: { id: target!, text: 'Original task' } }
          assert.equal((await r.execute(call)).outcome, 'uncertain')
        }
        return { status: 'completed', text: 'Inspect the chat on the desk.' }
      } },
  })
  t.after(() => controls.close())
  await controls.send({ idempotencyKey: 'first-person', text: 'Original task' }); await controls.idle()
  const waiting = await controls.readThread()
  assert.equal(waiting.waitReason, 'lead-chat-effect-uncertain'); assert.equal(waiting.wayOut, null)
  const before = r.journal.state.seq
  await assert.rejects(controls.resume({ expectedRevision: before }), { wireCode: 'lead-no-person-wait' })
  await assert.rejects(controls.send({ idempotencyKey: 'too-soon', text: 'Next task draft' }), { wireCode: 'lead-chat-effect-uncertain' })
  assert.equal(r.journal.state.seq, before)
  assert.equal((await createLeadJournal({ read: async () => r.records, append: async () => {} })).state.attempts.get('refusal-1')!.outcome, 'uncertain')
  await controls.stop({ expectedRevision: before })
  await controls.send({ idempotencyKey: 'next-person', text: 'Next task' }); await controls.idle()
  assert.equal(r.journal.state.budget!.logicalGoalId, 'fresh-logical-goal')
  assert.equal(effects, 1); assert.equal(requests, 2)
  assert.equal(r.runtime.sessions.size, 1, 'uncertain original work is never duplicated')
  assert.equal(r.records.some(record => record.type === 'reconciliation'), false)
})
