import assert from 'node:assert/strict'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, type LeadPermissionCall, type LeadPermissionContext } from '@harnessdesk/lead'
import { itemId, turnId } from '@harnessdesk/protocol'
import { evidenceDesk, until } from './fixtures/evidence-desk.js'

const rig = async (t: TestContext) => {
  const desk = await evidenceDesk(t, { leadEnabled: true })
  const project = { id: 'project-demo', path: await realpath(desk.repo.dir) }
  const foreign = join(project.path, 'other-project')
  await mkdir(foreign)
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
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
  const session = await desk.host.call('session/create', { runtime: desk.runtime.info.id, options: { cwd: project.path } })
  desk.host.registry.delete(desk.runtime.info.id, session.id)
  let actualCwd = foreign, reads = 0, sends = 0
  const read = desk.runtime.readSession.bind(desk.runtime)
  desk.runtime.readSession = async id => {
    reads++
    return { ...await read(id), cwd: actualCwd, itemsLoaded: true, turns: [{ id: turnId('foreign-turn'), status: 'completed',
      items: [{ id: itemId('foreign-result'), type: 'assistantMessage', phase: 'final', text: 'Synthetic transcript from the other project.' }] }] }
  }
  desk.runtime.onSend = () => { sends++ }
  let attempt = 0
  const execute = (call: LeadPermissionCall) => journal.execute({ id: `cwd-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
    async parsed => ({ value: await desk.host.call(parsed.method, parsed.params as never), identity: null }))
  return { ...desk, project, foreign, journal, service, session, id: `${desk.runtime.info.id}:${session.id}`, execute,
    reads: () => reads, sends: () => sends, setCwd: (cwd: string) => { actualCwd = cwd } }
}

test('Lead refuses an unloaded transcript whose actual cwd differs from its indexed project', async t => {
  const r = await rig(t)
  await assert.rejects(r.host.call('lead/chat/read', { id: r.id }), /scope|project/i)
  assert.equal(r.reads(), 1, 'scope checks the same runtime response that would supply the body')
})

test('Lead refuses a cold reply before foreign transcript normalization or dispatch', async t => {
  const r = await rig(t)
  const result = await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Inspect this project' } })
  assert.notEqual(result.outcome, 'succeeded')
  assert.equal(r.reads(), 1)
  assert.equal(r.sends(), 0)
  assert.equal(r.host.registry.get(r.runtime.info.id, r.session.id), undefined)
})

test('a Lead read accepts a matching raw cwd and ordinary phone reads keep their history behavior', async t => {
  const r = await rig(t)
  const phone = await r.host.call('workspace/thread/read', { id: r.id })
  assert.ok(phone.turns.some(turn => turn.type === 'agent' && turn.markdown.includes('Synthetic transcript')))
  r.setCwd(r.project.path)
  const lead = await r.host.call('lead/chat/read', { id: r.id })
  assert.ok(lead.turns.some(turn => turn.type === 'agent' && turn.markdown.includes('Synthetic transcript')))
  assert.equal(r.reads(), 2, 'the Lead rechecks the actual response instead of trusting a normalized cached body')
})

test('a failed raw read refuses Lead scope without removing the ordinary phone fallback', async t => {
  const r = await rig(t)
  r.host.registry.upsert(r.session, r.runtime.sessions.get(r.session.id)!)
  r.runtime.readSession = async () => { throw new Error('Synthetic raw location unavailable') }
  await assert.rejects(r.host.call('lead/chat/read', { id: r.id }), /Synthetic raw location unavailable/)
  assert.equal((await r.host.call('workspace/thread/read', { id: r.id })).id, r.id)
})

test('a loaded idle session cannot hide a changed runtime cwd behind its held transcript', async t => {
  const r = await rig(t)
  r.host.registry.upsert(r.session, r.runtime.sessions.get(r.session.id)!)
  await assert.rejects(r.host.call('lead/chat/read', { id: r.id }), /scope|project/i)
  assert.equal(r.reads(), 1)
})

test('Lead refuses a warm reply when the actual live cwd differs from the index', async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.host.registry.upsert(r.session, live)
  const settings = live.settings.bind(live)
  live.settings = () => ({ ...settings(), cwd: r.foreign })
  const result = await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Inspect this project' } })
  assert.equal(result.outcome, 'failed')
  assert.equal(r.sends(), 0)
  assert.equal(r.host.registry.get(r.runtime.info.id, r.session.id)?.queue.messages.length, 0)
})

test('Lead checks the reopened live cwd before a cold reply starts its effect', async t => {
  const r = await rig(t)
  r.setCwd(r.project.path)
  const resume = r.runtime.resumeSession.bind(r.runtime)
  r.runtime.resumeSession = async (id, options) => {
    const live = await resume(id, options), settings = live.settings.bind(live)
    live.settings = () => ({ ...settings(), cwd: r.foreign })
    return live
  }
  const result = await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Inspect this project' } })
  assert.equal(result.outcome, 'failed')
  assert.equal(r.runtime.resumes, 1)
  assert.equal(r.sends(), 0)
})

test('an edited queued Lead reply retains its scope through delayed dispatch and can resume after correction', async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.setCwd(r.project.path)
  const record = r.host.registry.upsert(r.session, live)
  const target = { runtime: r.runtime.info.id, sessionId: r.session.id }
  await r.host.call('turn/send', { ...target, input: [{ type: 'text', text: 'Person message' }] })
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Scoped follow-up' } })).outcome, 'succeeded')
  const queued = record.queue.messages[0]!
  await r.host.call('turn/queue/update', { ...target, id: queued.id, input: [{ type: 'text', text: 'Edited scoped follow-up' }] })
  await r.host.call('turn/queue/move', { ...target, id: queued.id, to: 0 })
  const settings = live.settings.bind(live)
  live.settings = () => ({ ...settings(), cwd: r.foreign })
  live.finish()
  await until(() => record.queue.status === 'paused' || r.sends() > 1 ? true : null, 'queued scope decision')
  assert.equal(r.sends(), 1)
  assert.equal(record.queue.status, 'paused')
  assert.match(record.queue.reason ?? '', /project|scope/i)
  assert.equal(record.queue.messages[0]?.id, queued.id)
  assert.equal((await r.host.leadChats.list({})).items.find(item => item.id === r.id)?.state, 'waiting')
  live.settings = settings
  await r.host.call('turn/queue/flush', target)
  assert.equal(r.sends(), 2)
  assert.equal(record.queue.messages.length, 0)
})

test('queued Lead replies recheck a tightened policy before the agent receives them', async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.setCwd(r.project.path)
  const record = r.host.registry.upsert(r.session, live)
  await r.host.call('turn/send', { runtime: r.runtime.info.id, sessionId: r.session.id, input: [{ type: 'text', text: 'Person message' }] })
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Scoped follow-up' } })).outcome, 'succeeded')
  await r.journal.setPolicy({ version: 1, revision: 2, mode: 'plan', rules: [] })
  live.finish()
  await until(() => record.queue.status === 'paused' || r.sends() > 1 ? true : null, 'queued policy decision')
  assert.equal(r.sends(), 1)
  assert.equal(record.queue.status, 'paused')
  assert.match(record.queue.reason ?? '', /policy|mode|read/i)
})

test('disabling Lead holds its accepted queued reply before runtime dispatch', async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  await r.service.setEnabled(true)
  r.setCwd(r.project.path)
  const record = r.host.registry.upsert(r.session, live)
  await r.host.call('turn/send', { runtime: r.runtime.info.id, sessionId: r.session.id, input: [{ type: 'text', text: 'Person message' }] })
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Scoped follow-up' } })).outcome, 'succeeded')
  await r.service.setEnabled(false)
  live.finish()
  await until(() => record.queue.status === 'paused' || r.sends() > 1 ? true : null, 'disabled Lead queue decision')
  assert.equal(r.sends(), 1)
  assert.equal(record.queue.status, 'paused')
  assert.match(record.queue.reason ?? '', /disabled|unavailable|stopped/i)
})

test('Lead refuses Stop when the actual running handle moved outside its project', async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.host.registry.upsert(r.session, live)
  await r.host.call('turn/send', { runtime: r.runtime.info.id, sessionId: r.session.id, input: [{ type: 'text', text: 'Person message' }] })
  let interrupts = 0
  live.interrupt = async () => { interrupts++ }
  const settings = live.settings.bind(live)
  live.settings = () => ({ ...settings(), cwd: r.foreign })
  assert.equal((await r.execute({ method: 'lead/chat/stop', params: { id: r.id } })).outcome, 'failed')
  assert.equal(interrupts, 0)
})

test('a newly allocated foreign handle receives no first prompt and retains its identity', async t => {
  const r = await rig(t), create = r.runtime.createSession.bind(r.runtime)
  r.runtime.createSession = async options => {
    const live = await create(options), settings = live.settings.bind(live)
    live.settings = () => ({ ...settings(), cwd: r.foreign })
    return live
  }
  const result = await r.execute({ method: 'lead/chat/start', params: { text: 'Inspect this project' } })
  assert.equal(result.outcome, 'succeeded')
  const value = result.value as { id: string; problem?: string }
  assert.ok(value.id)
  assert.match(value.problem ?? '', /created|confirmed/i)
  assert.equal(r.sends(), 0)
})

test('a queued Lead reply drains while a second healthy mutation is held in dispatch', async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.setCwd(r.project.path)
  const record = r.host.registry.upsert(r.session, live)
  await r.host.call('turn/send', { runtime: r.runtime.info.id, sessionId: r.session.id, input: [{ type: 'text', text: 'Person message' }] })
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Scoped follow-up' } })).outcome, 'succeeded')
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), creating = new Promise<void>(resolve => { entered = resolve })
  const create = r.runtime.createSession.bind(r.runtime)
  r.runtime.createSession = async options => { entered(); await held; return create(options) }
  const second = r.execute({ method: 'lead/chat/start', params: { text: 'Inspect another task' } })
  try {
    await creating
    assert.ok([...r.journal.state.attempts.values()].some(a => a.method === 'lead/chat/start' && a.phase === 'started' && a.dispatched))
    live.finish()
    await until(() => record.queue.status === 'paused' || r.sends() > 1 ? true : null, 'concurrent queued admission')
    assert.equal(r.sends(), 2)
    assert.equal(record.queue.messages.length, 0)
    assert.notEqual(record.queue.status, 'paused')
  } finally { release(); await second }
})

for (const action of ['cancel', 'clear', 'policy'] as const) test(`queued dispatch awaiting a reopened handle honours ${action} before send`, async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  const sent: string[] = [], observeSend = r.runtime.onSend
  r.runtime.onSend = (session, text, options) => { sent.push(text); observeSend?.(session, text, options) }
  r.setCwd(r.project.path)
  const record = r.host.registry.upsert(r.session, live)
  const target = { runtime: r.runtime.info.id, sessionId: r.session.id }
  await r.host.call('turn/send', { ...target, input: [{ type: 'text', text: 'Person message' }] })
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Scoped follow-up' } })).outcome, 'succeeded')
  const queued = record.queue.messages[0]!
  if (action === 'cancel') r.host.registry.enqueue(record, 'person-tail', [{ type: 'text', text: 'Person follow-up' }])
  // Lose the handle after drain has selected the item, forcing its final dispatch
  // to await a reopen. This is the same boundary as an agent restarting there.
  const markSending = r.host.registry.markSending.bind(r.host.registry)
  r.host.registry.markSending = one => { const selected = markSending(one); one.live = null; return selected }
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), resuming = new Promise<void>(resolve => { entered = resolve })
  const resume = r.runtime.resumeSession.bind(r.runtime)
  r.runtime.resumeSession = async (id, options) => { entered(); await held; return resume(id, options) }
  let dispatchRefused = false
  let dispatchFinished = false, released = false
  const cancelQueued = r.host.registry.cancelQueued.bind(r.host.registry)
  r.host.registry.cancelQueued = (one, id) => {
    cancelQueued(one, id)
    if (released && id === queued.id) dispatchFinished = true
  }
  const detach = r.host.addBroadcaster(notification => {
    if (notification.method === 'event' && notification.params.event.type === 'notice' &&
      notification.params.event.message.startsWith('The queued message was not sent:')) dispatchRefused = true
  })
  t.after(detach)
  live.finish()
  await resuming
  try {
    if (action === 'cancel') await r.host.call('turn/queue/cancel', { ...target, id: queued.id })
    else if (action === 'clear') await r.host.call('turn/queue/clear', target)
    else await r.journal.setPolicy({ version: 1, revision: 2, mode: 'plan', rules: [] })
  } finally { released = true; release() }
  await until(() => dispatchFinished || dispatchRefused || record.queue.status === 'paused' || r.sends() > 1 ? true : null, 'final queued dispatch decision')
  if (action === 'cancel') await until(() => r.sends() === 2 ? true : null, 'uncancelled queue tail')
  assert.equal(r.sends(), action === 'cancel' ? 2 : 1)
  assert.ok(!sent.includes('Scoped follow-up'), 'the cancelled prompt never reaches the runtime')
  if (action === 'cancel') assert.ok(sent.includes('Person follow-up'))
  assert.equal(record.queue.messages.length, action === 'policy' ? 1 : 0)
  if (action === 'policy') assert.match(record.queue.reason ?? '', /policy|mode|read/i)
  else {
    assert.notEqual(record.queue.status, 'paused', 'a cancelled message does not poison the queue')
    assert.equal(dispatchRefused, false, 'cancellation is not reported as a dispatch failure')
  }
})

test('a fresh Lead request cannot revive an uncertain queued reply from the stopped request', async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.setCwd(r.project.path)
  const record = r.host.registry.upsert(r.session, live)
  await r.host.call('turn/send', { runtime: r.runtime.info.id, sessionId: r.session.id,
    input: [{ type: 'text', text: 'Person message' }] })
  const result = await r.journal.execute({ id: 'lost-queue-receipt', request: {
    method: 'lead/chat/send', params: { id: r.id, text: 'Old queued task' }, project: r.project, runId: null, start: null,
  }, context: { desk: r.journal.state.policy!, projectPolicy: null, project: r.project, approved: null,
    budget: null, now: Date.now(), policyInterpretation: 'idle' } }, async call => {
    await r.host.call(call.method, call.params as never)
    throw new Error('The queue accepted the message but its receipt was lost')
  })
  assert.equal(result.outcome, 'uncertain')
  assert.equal(record.queue.messages.length, 1)
  await r.journal.stop(async () => {})
  await r.journal.beginGoal('new-person-request', Date.now())
  live.finish()
  await until(() => record.queue.status === 'paused' || r.sends() > 1 ? true : null, 'old queued admission after a new request')
  assert.equal(r.sends(), 1, 'acknowledgement never dispatches the old uncertain instruction')
  assert.equal(record.queue.messages.length, 1)
  assert.equal(record.queue.status, 'paused')
  assert.match(record.queue.reason ?? '', /request|goal/i)
})
