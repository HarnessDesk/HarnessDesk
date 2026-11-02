import assert from 'node:assert/strict'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, type LeadPermissionCall, type LeadPermissionContext } from '@harnessdesk/lead'
import { leadMessageEnvelope, itemId, turnId } from '@harnessdesk/protocol'
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

// A warm runtime announces its full session before the Host attaches its handle.
function restoreLive(r: Awaited<ReturnType<typeof rig>>, live = r.runtime.sessions.get(r.session.id)!) {
  r.runtime.emit({ type: 'session/started', session: r.session })
  return r.host.registry.upsert(r.session, live)
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
  restoreLive(r)
  r.runtime.readSession = async () => { throw new Error('Synthetic raw location unavailable') }
  await assert.rejects(r.host.call('lead/chat/read', { id: r.id }), /Synthetic raw location unavailable/)
  assert.equal((await r.host.call('workspace/thread/read', { id: r.id })).id, r.id)
})

test('a loaded idle session cannot hide a changed runtime cwd behind its held transcript', async t => {
  const r = await rig(t)
  restoreLive(r)
  await assert.rejects(r.host.call('lead/chat/read', { id: r.id }), /scope|project/i)
  assert.equal(r.reads(), 1)
})

test('Lead refuses a warm reply when the actual live cwd differs from the index', async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  restoreLive(r, live)
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
  const record = restoreLive(r, live)
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
  const record = restoreLive(r, live)
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
  const record = restoreLive(r, live)
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
  restoreLive(r, live)
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
  const record = restoreLive(r, live)
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
  const record = restoreLive(r, live)
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
  assert.ok(!sent.includes(leadMessageEnvelope('Dex', 'Scoped follow-up')), 'the cancelled prompt never reaches the runtime')
  if (action === 'cancel') assert.ok(sent.includes('Person follow-up'))
  assert.equal(record.queue.messages.length, action === 'policy' ? 1 : 0)
  if (action === 'policy') assert.match(record.queue.reason ?? '', /policy|mode|read/i)
  else {
    assert.notEqual(record.queue.status, 'paused', 'a cancelled message does not poison the queue')
    assert.equal(dispatchRefused, false, 'cancellation is not reported as a dispatch failure')
  }
})

for (const continuation of ['idle', 'new-turn'] as const) test(`cancelled Lead admission may refuse without holding the person tail: ${continuation}`, { timeout: 10000 }, async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.runtime.refusesWhileBusy = true
  r.setCwd(r.project.path)
  const record = restoreLive(r, live)
  const target = { runtime: r.runtime.info.id, sessionId: r.session.id }
  const sent: string[] = [], warnings: string[] = [], observeSend = r.runtime.onSend
  r.runtime.onSend = (session, text, options) => { sent.push(text); observeSend?.(session, text, options) }
  let entered!: () => void, release!: () => void, delivered!: () => void
  const admitting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const tailDrained = new Promise<void>(resolve => { delivered = resolve })
  let refusal = ''
  t.after(r.host.addBroadcaster(notification => {
    if (notification.method !== 'event') return
    const event = notification.params.event
    if (event.type === 'notice' && event.level === 'warning') warnings.push(event.message)
    if (event.type === 'session/queue' && event.sessionId === r.session.id &&
      event.queue.messages.length === 0 && sent.includes('Person follow-up')) delivered()
  }))
  await r.host.call('turn/send', { ...target, input: [{ type: 'text', text: 'Person message' }] })
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Scoped follow-up' } })).outcome, 'succeeded')
  const selected = record.queue.messages[0]!
  if (continuation === 'idle') await r.host.call('turn/queue', { ...target, input: [{ type: 'text', text: 'Person follow-up' }] })
  const queuedAdmission = r.host.registry.queuedAdmission.bind(r.host.registry)
  r.host.registry.queuedAdmission = (one, id) => {
    const admit = queuedAdmission(one, id)
    if (id !== selected.id || !admit) return admit
    return async current => {
      entered(); await held
      try { await admit(current) } catch (error) { refusal = String(error); throw error }
    }
  }
  // Awaitable dispatch cleanup gives the test a boundary before trailing idle
  // or the newer turn completes. No flush is used to deliver the surviving tail.
  r.host.registry.pauseQueue(record, 'Waiting for explicit delivery')
  live.finish()
  const draining = r.host.call('turn/queue/flush', target)
  try {
    await admitting
    await r.host.call('turn/queue/cancel', { ...target, id: selected.id })
    if (continuation === 'idle') {
      r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'active' } })
      await r.journal.setPolicy({ version: 1, revision: 2, mode: 'plan', rules: [] })
    } else {
      assert.equal((await r.host.call('turn/queue', { ...target, input: [{ type: 'text', text: 'New person turn' }] })).sent, true)
      assert.equal((await r.host.call('turn/queue', { ...target, input: [{ type: 'text', text: 'Person follow-up' }] })).sent, false)
      await r.journal.stop(async () => {})
    }
  } finally { release(); await draining }
  assert.match(refusal, continuation === 'idle' ? /policy|mode|read/i : /stopped/i, 'production admission must actually refuse')
  const beforeTail = continuation === 'idle' ? ['Person message'] : ['Person message', 'New person turn']
  assert.deepEqual(sent, beforeTail, 'the cancelled Lead text never reaches the runtime')
  assert.equal(record.queue.messages[0]?.state, 'queued')
  assert.notEqual(record.queue.status, 'paused', 'a cancelled admission refusal is a normal skip')
  assert.deepEqual(warnings, [])
  r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'idle' } })
  if (continuation === 'new-turn') {
    assert.equal(record.queue.messages[0]?.state, 'queued', 'the newer person turn still owns delivery')
    live.finish()
  }
  await tailDrained
  live.finish()
  r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'idle' } })
  assert.deepEqual(sent, [...beforeTail, 'Person follow-up'])
  assert.equal(record.queue.messages.length, 0)
  assert.notEqual(record.queue.status, 'paused')
  assert.deepEqual(warnings, [])
})

test('cancelling a queued item after runtime send begins retains a later rejection fence', { timeout: 10000 }, async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.runtime.refusesWhileBusy = true
  r.setCwd(r.project.path)
  const record = restoreLive(r, live)
  const target = { runtime: r.runtime.info.id, sessionId: r.session.id }
  const sent: string[] = [], warnings: string[] = [], observeSend = r.runtime.onSend
  r.runtime.onSend = (session, text, options) => { sent.push(text); observeSend?.(session, text, options) }
  t.after(r.host.addBroadcaster(notification => {
    if (notification.method === 'event' && notification.params.event.type === 'notice' &&
      notification.params.event.level === 'warning') warnings.push(notification.params.event.message)
  }))
  await r.host.call('turn/send', { ...target, input: [{ type: 'text', text: 'Person message' }] })
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Scoped follow-up' } })).outcome, 'succeeded')
  const selected = record.queue.messages[0]!
  await r.host.call('turn/queue', { ...target, input: [{ type: 'text', text: 'Person follow-up' }] })
  let entered!: () => void, release!: () => void
  const sending = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const send = live.send.bind(live)
  live.send = async (input, options) => {
    const result = await send(input, options)
    if (input.some(part => part.type === 'text' && part.text === leadMessageEnvelope('Dex', 'Scoped follow-up'))) {
      entered(); await held
      throw new Error('Synthetic runtime receipt lost after send began')
    }
    return result
  }
  r.host.registry.pauseQueue(record, 'Waiting for explicit delivery')
  live.finish()
  const draining = r.host.call('turn/queue/flush', target)
  try {
    await sending
    assert.deepEqual(sent, ['Person message', leadMessageEnvelope('Dex', 'Scoped follow-up')], 'the runtime has crossed the send boundary')
    await r.host.call('turn/queue/cancel', { ...target, id: selected.id })
  } finally { release(); await draining }
  assert.equal(record.queue.status, 'paused')
  assert.match(record.queue.reason ?? '', /Synthetic runtime receipt lost after send began/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /The queued message was not sent:.*Synthetic runtime receipt lost after send began/)
  live.finish()
  r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'idle' } })
  assert.deepEqual(sent, ['Person message', leadMessageEnvelope('Dex', 'Scoped follow-up')], 'idle must not bypass the uncertain runtime effect fence')
  assert.equal(record.queue.messages.length, 1)
  assert.equal(record.queue.messages[0]?.state, 'queued')
  assert.equal(record.queue.status, 'paused')
})

test('cancelling a held Lead admission drains its surviving tail after trailing idle', { timeout: 10000 }, async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.runtime.refusesWhileBusy = true
  r.setCwd(r.project.path)
  const record = restoreLive(r, live)
  const target = { runtime: r.runtime.info.id, sessionId: r.session.id }
  const sent: string[] = [], warnings: string[] = [], observeSend = r.runtime.onSend
  r.runtime.onSend = (session, text, options) => { sent.push(text); observeSend?.(session, text, options) }
  let entered!: () => void, release!: () => void, cleaned!: () => void, delivered!: () => void
  const admitting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const cancellationCleaned = new Promise<void>(resolve => { cleaned = resolve }), tailDrained = new Promise<void>(resolve => { delivered = resolve })
  let released = false
  t.after(r.host.addBroadcaster(notification => {
    if (notification.method !== 'event') return
    const event = notification.params.event
    if (event.type === 'notice' && event.level === 'warning') warnings.push(event.message)
    if (event.type === 'session/queue' && event.sessionId === r.session.id) {
      if (released && event.queue.messages.length === 1) cleaned()
      if (sent.includes('Person follow-up') && event.queue.messages.length === 0) delivered()
    }
  }))
  await r.host.call('turn/send', { ...target, input: [{ type: 'text', text: 'Person message' }] })
  const originalTurn = record.session.turns.find(turn => turn.status === 'inProgress')!
  r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'active' } })
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Scoped follow-up' } })).outcome, 'succeeded')
  const selected = record.queue.messages[0]!
  assert.equal((await r.host.call('turn/queue', { ...target,
    input: [{ type: 'text', text: 'Person follow-up' }] })).sent, false)
  const queuedAdmission = r.host.registry.queuedAdmission.bind(r.host.registry)
  r.host.registry.queuedAdmission = (one, id) => {
    const admit = queuedAdmission(one, id)
    if (id !== selected.id || !admit) return admit
    return async current => { entered(); await held; await admit(current) }
  }
  live.finish()
  try {
    await admitting
    assert.equal(record.session.status.type, 'active', 'completion preserves the trailing runtime status')
    await r.host.call('turn/queue/cancel', { ...target, id: selected.id })
  } finally { released = true; release() }
  await cancellationCleaned
  assert.deepEqual(sent, ['Person message'], 'the surviving tail waits while the runtime still reports active')
  assert.equal(record.queue.messages[0]?.state, 'queued')
  assert.notEqual(record.queue.status, 'paused')
  assert.deepEqual(warnings, [])
  r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'idle' } })
  assert.equal(record.queue.messages[0]?.state, 'sending', 'trailing idle resumes the surviving tail without a flush')
  // Repeated idle and completion notifications must share the in-flight drain.
  r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'idle' } })
  r.runtime.emit({ type: 'turn/completed', sessionId: r.session.id, turn: { ...originalTurn, status: 'completed' } })
  await tailDrained
  assert.deepEqual(sent, ['Person message', 'Person follow-up'])
  assert.equal(record.queue.messages.length, 0)
  assert.notEqual(record.queue.status, 'paused')
  assert.deepEqual(warnings, [])
})

test('cancelling a held Lead admission leaves a new person follow-up behind its running turn', { timeout: 10000 }, async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.runtime.refusesWhileBusy = true
  r.setCwd(r.project.path)
  const record = restoreLive(r, live)
  const target = { runtime: r.runtime.info.id, sessionId: r.session.id }
  const sent: string[] = [], observeSend = r.runtime.onSend
  let delivered!: () => void
  const followUpDrained = new Promise<void>(resolve => { delivered = resolve })
  r.runtime.onSend = (session, text, options) => {
    sent.push(text)
    observeSend?.(session, text, options)
  }
  const warnings: string[] = []
  t.after(r.host.addBroadcaster(notification => {
    if (notification.method !== 'event') return
    const event = notification.params.event
    if (event.type === 'notice' && event.level === 'warning') warnings.push(event.message)
    if (event.type === 'session/queue' && event.sessionId === r.session.id &&
      event.queue.messages.length === 0 && sent.includes('Person follow-up')) delivered()
  }))
  await r.host.call('turn/send', { ...target, input: [{ type: 'text', text: 'Person message' }] })
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: r.id, text: 'Scoped follow-up' } })).outcome, 'succeeded')
  const queued = record.queue.messages[0]!
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), admitting = new Promise<void>(resolve => { entered = resolve })
  const queuedAdmission = r.host.registry.queuedAdmission.bind(r.host.registry)
  r.host.registry.queuedAdmission = (one, id) => {
    const admit = queuedAdmission(one, id)
    if (id !== queued.id || !admit) return admit
    return async current => { entered(); await held; await admit(current) }
  }
  // Hold automatic draining so the real flush call can await the selected
  // message's complete dispatch, including its cancellation cleanup.
  r.host.registry.pauseQueue(record, 'Waiting for explicit delivery')
  live.finish()
  const draining = r.host.call('turn/queue/flush', target)
  try {
    await admitting
    await r.host.call('turn/queue/cancel', { ...target, id: queued.id })
    assert.equal(record.queue.messages.length, 0)
    assert.equal((await r.host.call('turn/queue', { ...target,
      input: [{ type: 'text', text: 'New person turn' }] })).sent, true)
    assert.equal((await r.host.call('turn/queue', { ...target,
      input: [{ type: 'text', text: 'Person follow-up' }] })).sent, false)
  } finally { release(); await draining }
  // A trailing idle notification from the preceding turn cannot override the
  // newer unfinished person turn, even when that notification is repeated.
  r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'idle' } })
  r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'idle' } })
  assert.deepEqual(sent, ['Person message', 'New person turn'], 'neither follow-up is dispatched into the running turn')
  assert.equal(record.queue.messages.length, 1)
  assert.equal(record.queue.messages[0]?.state, 'queued', 'cancellation cleanup must not select the new tail while busy')
  assert.notEqual(record.queue.status, 'paused', 'cancellation does not poison the queue')
  assert.deepEqual(warnings, [], 'cancellation is not reported as a delivery failure')
  live.finish()
  await followUpDrained
  // Another completion and flush must not deliver the surviving tail twice.
  live.finish()
  await r.host.call('turn/queue/flush', target)
  assert.deepEqual(sent, ['Person message', 'New person turn', 'Person follow-up'])
  assert.equal(record.queue.messages.length, 0)
  assert.notEqual(record.queue.status, 'paused')
  assert.deepEqual(warnings, [])
})

test('idle notifications cannot drain a person follow-up while its first send awaits acceptance', { timeout: 10000 }, async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.runtime.refusesWhileBusy = true
  const record = restoreLive(r, live)
  const target = { runtime: r.runtime.info.id, sessionId: r.session.id }
  let entered!: () => void, release!: () => void, delivered!: () => void
  const accepting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const tailDrained = new Promise<void>(resolve => { delivered = resolve })
  const send = live.send.bind(live), sent: string[] = [], warnings: string[] = [], observeSend = r.runtime.onSend
  live.send = async (input, options) => {
    if (input.some(part => part.type === 'text' && part.text === 'Person message')) { entered(); await held }
    return send(input, options)
  }
  r.runtime.onSend = (session, text, options) => { sent.push(text); observeSend?.(session, text, options) }
  t.after(r.host.addBroadcaster(notification => {
    if (notification.method !== 'event') return
    const event = notification.params.event
    if (event.type === 'notice' && event.level === 'warning') warnings.push(event.message)
    if (event.type === 'session/queue' && event.sessionId === r.session.id &&
      event.queue.messages.length === 0 && sent.includes('Person follow-up')) delivered()
  }))
  const sending = r.host.call('turn/queue', { ...target, input: [{ type: 'text', text: 'Person message' }] })
  try {
    await accepting
    assert.equal((await r.host.call('turn/queue', { ...target,
      input: [{ type: 'text', text: 'Person follow-up' }] })).sent, false)
    r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'idle' } })
    r.runtime.emit({ type: 'session/status', sessionId: r.session.id, status: { type: 'idle' } })
    assert.equal(record.queue.messages[0]?.state, 'queued', 'the sendingNow marker still owns the first send')
    assert.deepEqual(sent, [])
  } finally { release(); assert.equal((await sending).sent, true) }
  live.finish()
  await tailDrained
  assert.deepEqual(sent, ['Person message', 'Person follow-up'])
  assert.equal(record.queue.messages.length, 0)
  assert.notEqual(record.queue.status, 'paused')
  assert.deepEqual(warnings, [])
})

test('a fresh Lead request cannot revive an uncertain queued reply from the stopped request', async t => {
  const r = await rig(t), live = r.runtime.sessions.get(r.session.id)!
  r.setCwd(r.project.path)
  const record = restoreLive(r, live)
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
  assert.equal(record.queue.reason, 'The Lead request changed. Cancel this queued reply and send a new message.')
})
