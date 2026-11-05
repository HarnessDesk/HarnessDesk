import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, type LeadPermissionCall, type LeadPermissionContext } from '@harnessdesk/lead'
import { runtimeId, sessionId, type AgentError, type WireNotification } from '@harnessdesk/protocol'
import { evidenceDesk, until } from './fixtures/evidence-desk.js'
import { FakeRuntime, FakeSession } from './fixtures/fake-runtime.js'

const rig = async (t: TestContext, previous?: Awaited<ReturnType<typeof evidenceDesk>>) => {
  const desk = await evidenceDesk(t, { leadEnabled: true }, previous)
  if (previous) for (const [id, cwd] of previous.runtime.minted) {
    desk.runtime.minted.set(id, cwd)
    desk.runtime.sessions.set(id, new FakeSession(desk.runtime, sessionId(id), { cwd, model: 'fake-1' }, { model: 'fake-1', tone: 'plain', uppercase: false }))
  }
  const project = { id: 'fixture-project', path: await realpath(desk.repo.dir) }
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'recovery-fixture', now: Date.now(), caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  await journal.appendMessage('request', 'Keep  these exact words.\nAnd this line.')
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null, budget: null, now: Date.now(), policyInterpretation: 'idle' })
  let modelRequests = 0, attempt = 0
  let resolveHook: ((call: LeadPermissionCall) => Promise<void>) | undefined
  const service = desk.host.createLeadService({ journal, project, prices: {},
    resolveTool: async call => { await resolveHook?.(call); return { project, runId: null, start: null, stepId: null, context: context() } },
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => { modelRequests++; return { status: 'completed', text: '' } }, stop: async () => {}, ownershipWithdrawn() {} }),
  })
  await service.setEnabled(true)
  const notifications: WireNotification[] = [], prompts: string[] = []
  desk.host.addBroadcaster(notification => { notifications.push(notification) })
  desk.runtime.onSend = (_session, text) => { prompts.push(text) }
  const execute = async (call: LeadPermissionCall) => {
    const result = await journal.execute({ id: `fixture-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
      async parsed => ({ value: await desk.host.call(parsed.method, parsed.params as never), identity: null }))
    assert.equal(result.decision.effect, 'allow', result.decision.reason)
    assert.equal(result.outcome, 'succeeded', JSON.stringify(result))
    return result.value as any
  }
  const incident = () => notifications.filter(one => one.method === 'lead/chat/changed' && one.params.incident)
  const start = () => execute({ method: 'lead/chat/start', params: { text: 'Add the helper\n\nPreserve its API.' } })
  const fail = (id: string, code: AgentError['code']) => desk.runtime.sessions.get(id.slice(id.indexOf(':') + 1))!.fail('Synthetic provider failure', code)
  const stored = async () => JSON.parse(await readFile(join(desk.stateDir, 'lead', 'incidents.json'), 'utf8'))
  return { ...desk, onResolve: (hook: typeof resolveHook) => { resolveHook = hook }, project, journal, service, notifications, prompts, execute, start, fail, incident, stored, models: () => modelRequests }
}

test('fake provider reset gives one retry at a time with no model request or allowance movement while waiting', async t => {
  const r = await rig(t)
  const created = await r.start()
  const reset = Date.now() + 200
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id,
    limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: reset }] } })
  r.fail(created.id, 'rateLimit')
  await until(async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'persisted reset wait')
  const allowance = JSON.stringify(r.journal.state.budget)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(r.prompts.length, 1); assert.equal(r.models(), 0); assert.equal(r.incident().length, 0)
  assert.equal(JSON.stringify(r.journal.state.budget), allowance)
  const work = await r.host.call('workspace/sessions/list', {})
  assert.equal(work.items.find(item => item.id === created.id)?.phase, 'running', 'queued recovery cannot report done')
  await until(() => r.prompts.length === 2 ? true : null, 'first retry after provider reset')
  assert.ok(Date.now() >= reset)
  assert.match(r.prompts[1]!, /Continue from where you stopped\./)
  assert.match(r.prompts[1]!, /Lead/)
  r.fail(created.id, 'rateLimit')
  await until(() => r.prompts.length === 3 ? true : null, 'second bounded retry')
  r.fail(created.id, 'rateLimit')
  await until(() => r.incident().length === 1 ? true : null, 'one incident wake after retry bound')
  const event = r.incident()[0]!
  assert.equal(event.method === 'lead/chat/changed' && event.params.incident?.attempts, 2)
  assert.equal(r.models(), 0, 'host scheduling never calls the Lead model')
  assert.equal(JSON.stringify(r.journal.state.budget), allowance)
})

test('credits asks immediately with eligible presentation candidates, then moves brief, exact words and digest through workspace start', async t => {
  const r = await rig(t)
  const second = new FakeRuntime({ id: runtimeId('second-private-backend') })
  Object.assign(second.info, { presentation: { ...second.info.presentation, name: 'Agent Two' } })
  r.host.register(second); await second.start()
  const destinationPrompts: string[] = []
  second.onSend = (_session, text) => { destinationPrompts.push(text) }
  for (const [id, capabilities, signedOut, reached] of [
    ['cannot-resume', { resume: false }, false, false], ['signed-out', { account: true }, true, false], ['limited', {}, false, true],
  ] as const) {
    const unavailable = new FakeRuntime({ id: runtimeId(id), capabilities }); unavailable.loggedOut = signedOut
    r.host.register(unavailable); await unavailable.start()
    if (reached) unavailable.getRateLimits = async () => ({ reached: 'Weekly' })
    if (reached) unavailable.emit({ type: 'limits/updated', runtime: unavailable.info.id, limits: { reached: 'Weekly' } })
  }
  const created = await r.start()
  r.fail(created.id, 'credits')
  await until(() => r.incident().length ? true : null, 'credit incident')
  assert.equal(r.prompts.length, 1)
  const notice = r.incident()[0]!
  assert.equal(notice.method, 'lead/chat/changed')
  if (notice.method !== 'lead/chat/changed') return
  assert.deepEqual(notice.params.incident?.candidates.map(one => one.name), ['Agent Two'])
  assert.doesNotMatch(JSON.stringify(notice.params.incident), /second-private-backend/)
  await r.journal.appendReply('Move this work?', undefined, { question: 'Move the helper work?', options: [{ id: 'move', label: 'Move to Agent Two' }, { id: 'stop', label: 'Stop' }], recommended: 'move' })
  await r.journal.appendMessage('move-answer', 'Move to Agent Two')
  const policy = JSON.stringify([r.journal.state.policy, r.journal.state.budget?.caps, r.journal.state.workerApprovals])
  const moved = await r.execute({ method: 'lead/chat/start', params: { text: 'Finish the helper\n\nRun the remaining tests.', agent: 'Agent Two', moveFrom: created.id } })
  assert.match(moved.id, /^second-private-backend:/)
  assert.equal(destinationPrompts.length, 1)
  for (const text of ['Finish the helper', 'Add the helper', 'Keep  these exact words.', 'And this line.', 'Progress digest']) assert.ok(destinationPrompts[0]!.includes(text), text)
  const record = (await r.stored()).records.find((one: any) => one.chatId === created.id)
  assert.equal(record.state, 'moved'); assert.equal(record.movedTo, moved.id)
  assert.equal(JSON.stringify([r.journal.state.policy, r.journal.state.budget?.caps, r.journal.state.workerApprovals]), policy)
  assert.ok(r.runtime.sessions.has(created.id.slice(created.id.indexOf(':') + 1)), 'old chat retained')
})

for (const held of [true, false]) test(held ? 'a person-held chat never creates an incident or wake' : 'stopping Lead cancels the durable wait', async t => {
  const r = await rig(t), created = await r.start()
  if (held) await r.host.call('lead/chat/takeOver', { id: created.id })
  r.fail(created.id, held ? 'credits' : 'network')
  if (!held) {
    await until(async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'wait')
    await r.service.setEnabled(false)
    await until(async () => (await r.stored()).records[0]?.state === 'stopped' ? true : null, 'cancelled wait')
  }
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(r.prompts.length, 1); assert.equal(r.incident().length, 0)
  if (held) assert.equal((await r.stored().catch(() => ({ records: [] }))).records.length, 0)
})


test('host restart mid-reset preserves the pending retry and reschedules exactly once', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() + 2000 }] } })
  r.fail(created.id, 'rateLimit')
  await until(async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'reset wait before restart')
  await r.stop()
  assert.equal((await r.stored()).records[0]?.state, 'waiting-reset', 'closing the desk preserves the provider-clock wait')
  const next = await rig(t, r)
  await until(() => next.prompts.length === 1 ? true : null, 'one restored retry', 8000).catch(async error => { throw new Error(`${error.message}; stored=${JSON.stringify(await next.stored())}; chats=${JSON.stringify(await next.host.call('lead/chat/list', {}))}; activities=${JSON.stringify(await next.host.leadChatActivities())}; attempts=${JSON.stringify([...next.journal.state.attempts])}`) })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(next.prompts.length, 1)
  assert.equal((await next.stored()).records[0]?.attempts, 1)
})

test('a successful automatic retry clears its incident and emits completion from turn/completed alone', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() }] } })
  r.fail(created.id, 'rateLimit')
  await until(() => r.prompts.length === 2 ? true : null, 'retry')
  const before = r.notifications.length
  r.runtime.sessions.get(created.id.slice(created.id.indexOf(':') + 1))!.finish('The helper and its tests are complete.')
  await until(() => r.notifications.slice(before).some(one => one.method === 'lead/chat/changed' && one.params.state === 'idle') ? true : null, 'completion after retry')
  assert.equal((await r.stored()).records[0]?.state, 'cleared')
  assert.equal(r.incident().length, 0, 'successful retry does not ask about a past failure')
})

test('phone Stop during a queued reset cancels recovery instead of sending later', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() + 1000 }] } })
  r.fail(created.id, 'rateLimit')
  await until(async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'wait before phone stop')
  Object.assign(r.runtime.info, { capabilities: { ...r.runtime.info.capabilities, interrupt: false } })
  await r.host.call('workspace/stop', { id: created.id })
  assert.equal((await r.stored()).records[0]?.state, 'stopped')
})


test('Stop revokes a retry already claimed but still awaiting ordinary send admission', async t => {
  const r = await rig(t), created = await r.start()
  let release: (() => void) | undefined, hold = true
  r.onResolve(async call => { if (hold && call.method === 'lead/chat/send') { hold = false; await new Promise<void>(resolve => { release = resolve }) } })
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() }] } })
  r.fail(created.id, 'rateLimit')
  try {
    await until(() => release ? true : null, 'claimed retry paused in host admission')
    await r.host.call('workspace/stop', { id: created.id })
    release!()
    await until(() => [...r.journal.state.attempts.values()].some(one => one.method === 'lead/chat/send' && one.phase === 'finished') ? true : null, 'revoked send finishes without dispatch')
    assert.equal(r.prompts.length, 1)
    assert.equal((await r.stored()).records[0]?.state, 'stopped')
  } finally { release?.() }
})
