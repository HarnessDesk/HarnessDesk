import assert from 'node:assert/strict'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, initialLeadState, type LeadJournal, type LeadPermissionCall, type LeadPermissionContext } from '@harnessdesk/lead'
import { canonicalTranscriptBody, runtimeId, sessionId, turnId, type AgentError, type WireNotification } from '@harnessdesk/protocol'
import { TranscriptStore } from '../src/transcripts.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'
import { FakeRuntime, FakeSession } from './fixtures/fake-runtime.js'

const policySnapshot = (r: { journal: { state: { policy: unknown; budget: { caps: unknown } | null; workerApprovals: unknown } } }) => JSON.stringify([r.journal.state.policy, r.journal.state.budget?.caps, r.journal.state.workerApprovals])

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const after = async (r: { idle(): Promise<void> }, probe: () => unknown | Promise<unknown>, label: string) => { await r.idle(); assert.ok(await probe(), label) }

const rig = async (t: TestContext, previous?: Awaited<ReturnType<typeof evidenceDesk>> & { journal?: LeadJournal; now?: () => number }) => {
  let clock = previous?.now?.() ?? 1_800_000_000_000
  const scheduled = new Map<() => void, number>()
  const now = () => clock
  const recovery = { now, schedule: (run: () => void, delay: number) => { scheduled.set(run, clock + delay); return () => { scheduled.delete(run) } } }
  const desk = await evidenceDesk(t, { leadEnabled: true }, previous)
  if (previous) for (const [id, cwd] of previous.runtime.minted) {
    desk.runtime.minted.set(id, cwd)
    desk.runtime.sessions.set(id, new FakeSession(desk.runtime, sessionId(id), { cwd, model: 'fake-1' }, { model: 'fake-1', tone: 'plain', uppercase: false }))
  }
  const project = { id: 'fixture-project', path: await realpath(desk.repo.dir) }
  const journal = await createLeadJournal({ read: async () => [], append: async () => {}, checkpoint: () => previous?.journal?.state ?? ({ ...initialLeadState(), workerApprovals: [{ id: 'saved-rule', contractDigest: 'a'.repeat(64), goalStartedSeq: 1, key: { kind: 'tool', tool: 'read' }, target: 'Read files', count: 4 }] }) })
  if (!previous?.journal) {
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'recovery-fixture', now: now(), caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  await journal.appendMessage('request', 'Keep  these exact words.\nAnd this line.', 'person')
  }
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null, budget: null, now: now(), policyInterpretation: 'idle' })
  let modelRequests = 0, attempt = journal.state.seq
  let resolveHook: ((call: LeadPermissionCall) => Promise<void>) | undefined
  const initialPolicy = policySnapshot({ journal })
  const service = desk.host.createLeadService({ journal, project, prices: {}, recovery,
    resolveTool: async call => { await resolveHook?.(call); return { project, runId: null, start: null, stepId: null, context: context() } },
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => { modelRequests++; return { status: 'completed', text: '' } }, stop: async () => {}, ownershipWithdrawn() {} }),
  })
  await service.setEnabled(true)
  const notifications: WireNotification[] = [], prompts: string[] = []
  desk.host.addBroadcaster(notification => { notifications.push(notification) })
  desk.runtime.onSend = (_session, text) => { prompts.push(text) }
  const idle = () => desk.host.leadChats.idle()
  await idle()
  const advance = async (ms: number) => { clock += ms; for (const [run, at] of [...scheduled]) if (at <= clock) { scheduled.delete(run); run() }; await idle() }
  const nextRetry = async () => { await idle(); assert.ok(scheduled.size, 'one retry is scheduled'); await advance(Math.max(0, Math.min(...scheduled.values()) - clock)) }
  const execute = async (call: LeadPermissionCall, expected: 'succeeded' | 'uncertain' = 'succeeded') => {
    const result = await journal.execute({ id: `fixture-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
      async parsed => ({ value: await desk.host.call(parsed.method, parsed.params as never), identity: null }))
    assert.equal(result.decision.effect, 'allow', result.decision.reason)
    assert.equal(result.outcome, expected, JSON.stringify(result))
    await idle()
    return result.value as any
  }
  const incident = () => notifications.filter(one => one.method === 'lead/chat/changed' && one.params.incident)
  const start = () => execute({ method: 'lead/chat/start', params: { text: 'Add the helper\n\nPreserve its API.' } })
  const fail = (id: string, code: AgentError['code']) => desk.runtime.sessions.get(id.slice(id.indexOf(':') + 1))!.fail('Synthetic provider failure', code)
  const stored = async () => JSON.parse(await readFile(join(desk.stateDir, 'lead', 'incidents.json'), 'utf8'))
  return { ...desk, now, idle, advance, nextRetry, initialPolicy, onResolve: (hook: typeof resolveHook) => { resolveHook = hook }, project, journal, service, notifications, prompts, execute, start, fail, incident, stored, models: () => modelRequests }
}

test('fake provider reset gives one retry at a time with no model request or allowance movement while waiting', async t => {
  const r = await rig(t)
  const created = await r.start()
  const reset = r.now() + 200
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id,
    limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: reset }] } })
  r.fail(created.id, 'rateLimit')
  await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'persisted reset wait')
  const allowance = JSON.stringify(r.journal.state.budget)
  const policy = policySnapshot(r)
  await r.advance(100)
  assert.equal(r.prompts.length, 1); assert.equal(r.models(), 0); assert.equal(r.incident().length, 0)
  assert.equal(JSON.stringify(r.journal.state.budget), allowance)
  const work = await r.host.call('workspace/sessions/list', {})
  assert.equal(work.items.find(item => item.id === created.id)?.phase, 'running', 'queued recovery cannot report done')
  await r.nextRetry()
  await after(r, () => r.prompts.length === 2 ? true : null, 'first retry after provider reset')
  assert.ok(r.now() >= reset)
  assert.match(r.prompts[1]!, /Continue from where you stopped\./)
  assert.match(r.prompts[1]!, /Lead/)
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: r.now() + 200 }] } })
  r.fail(created.id, 'rateLimit')
  await r.nextRetry()
  await after(r, () => r.prompts.length === 3 ? true : null, 'second bounded retry')
  r.fail(created.id, 'rateLimit')
  await after(r, () => r.incident().length === 1 ? true : null, 'one incident wake after retry bound')
  const event = r.incident()[0]!
  assert.equal(event.method === 'lead/chat/changed' && event.params.incident?.attempts, 2)
  assert.equal(r.models(), 0, 'host scheduling never calls the Lead model')
  assert.equal(JSON.stringify(r.journal.state.budget), allowance)
  assert.equal(policySnapshot(r), policy, 'automatic journal.execute does not change policy, caps or approvals')
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
  await after(r, () => r.incident().length ? true : null, 'credit incident')
  assert.equal(r.prompts.length, 1)
  const notice = r.incident()[0]!
  assert.equal(notice.method, 'lead/chat/changed')
  if (notice.method !== 'lead/chat/changed') return
  assert.deepEqual(notice.params.incident?.candidates.map(one => one.name), ['Agent Two'])
  assert.doesNotMatch(JSON.stringify(notice.params.incident), /second-private-backend/)
  await r.journal.appendReply('Move this work?', undefined, { question: 'Move the helper work?', options: [{ id: 'move', label: 'Move to Agent Two' }, { id: 'stop', label: 'Stop' }], recommended: 'move' })
  await r.journal.appendMessage('move-answer', 'Move to Agent Two', 'person')
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
    await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'wait')
    await r.service.setEnabled(false)
    await after(r, async () => (await r.stored()).records[0]?.state === 'stopped' ? true : null, 'cancelled wait')
  }
  await r.advance(50)
  assert.equal(r.prompts.length, 1); assert.equal(r.incident().length, 0)
  if (held) assert.equal((await r.stored().catch(() => ({ records: [] }))).records.length, 0)
})


test('host restart mid-reset preserves the pending retry and reschedules exactly once', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: r.now() + 2000 }] } })
  r.fail(created.id, 'rateLimit')
  await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'reset wait before restart')
  await r.stop()
  assert.equal((await r.stored()).records[0]?.state, 'waiting-reset', 'closing the desk preserves the provider-clock wait')
  const next = await rig(t, r)
  await next.nextRetry()
  await after(next, () => next.prompts.length === 1 ? true : null, 'one restored retry').catch(async error => { throw new Error(`${error.message}; stored=${JSON.stringify(await next.stored())}; chats=${JSON.stringify(await next.host.call('lead/chat/list', {}))}; activities=${JSON.stringify(await next.host.leadChatActivities())}; attempts=${JSON.stringify([...next.journal.state.attempts])}`) })
  await next.advance(100)
  assert.equal(next.prompts.length, 1)
  assert.equal((await next.stored()).records[0]?.attempts, 1)
})

test('a successful automatic retry clears its incident and emits completion from turn/completed alone', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: r.now() + 2000 }] } })
  r.fail(created.id, 'rateLimit')
  await r.nextRetry()
  await after(r, () => r.prompts.length === 2 ? true : null, 'retry')
  const before = r.notifications.length
  r.runtime.sessions.get(created.id.slice(created.id.indexOf(':') + 1))!.finish('The helper and its tests are complete.')
  await after(r, () => r.notifications.slice(before).some(one => one.method === 'lead/chat/changed' && one.params.state === 'idle') ? true : null, 'completion after retry')
  assert.equal((await r.stored()).records[0]?.state, 'cleared')
  assert.equal(r.incident().length, 0, 'successful retry does not ask about a past failure')
})

test('phone Stop during a queued reset cancels recovery instead of sending later', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: r.now() + 1000 }] } })
  r.fail(created.id, 'rateLimit')
  await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'wait before phone stop')
  Object.assign(r.runtime.info, { capabilities: { ...r.runtime.info.capabilities, interrupt: false } })
  await r.host.call('workspace/stop', { id: created.id })
  assert.equal((await r.stored()).records[0]?.state, 'stopped')
})


test('Stop revokes a retry already claimed but still awaiting ordinary send admission', async t => {
  const r = await rig(t), created = await r.start()
  const entered = deferred()
  let release: (() => void) | undefined, hold = true, sendChecks = 0
  r.onResolve(async call => { if (hold && call.method === 'lead/chat/send' && ++sendChecks > 1) { hold = false; await new Promise<void>(resolve => { release = resolve; entered.resolve() }) } })
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: r.now() + 200 }] } })
  r.fail(created.id, 'rateLimit')
  const advancing = r.nextRetry()
  try {
    await entered.promise
    await r.host.call('workspace/stop', { id: created.id })
    release!(); await advancing
    await after(r, () => [...r.journal.state.attempts.values()].some(one => one.method === 'lead/chat/send' && one.phase === 'finished') ? true : null, 'revoked send finishes without dispatch')
    assert.equal(r.prompts.length, 1)
    assert.equal((await r.stored()).records[0]?.state, 'stopped')
  } finally { release?.(); await advancing }
})


test('take-over during waiting-reset cancels the retry and preserves policy, caps and approvals; hand-back permits fresh failures', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Daily', windows: [{ label: 'Daily', resetsAt: r.now() + 200, usedPercent: 100, windowMinutes: 1440 }] } })
  r.fail(created.id, 'rateLimit')
  await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'wait before take-over')
  const policy = policySnapshot(r)
  await r.host.call('lead/chat/takeOver', { id: created.id })
  await after(r, async () => (await r.stored()).records[0]?.state === 'stopped' ? true : null, 'take-over cancels wait')
  await r.advance(1600)
  assert.equal(r.prompts.length, 1); assert.equal(r.incident().length, 0)
  assert.equal(policySnapshot(r), policy)
  await r.host.call('lead/chat/handBack', { id: created.id })
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Resume the work after hand-back' } })
  r.fail(created.id, 'credits')
  await after(r, () => r.incident().length === 1 ? true : null, 'fresh incident after hand-back')
  assert.equal((await r.stored()).records[0]?.attempts, 0)
})

test('an overdue-on-restart reset fires exactly once through journal.execute without changing policy, caps or approvals', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Daily', windows: [{ label: 'Daily', resetsAt: r.now() + 10_000, usedPercent: 100, windowMinutes: 1440 }] } })
  r.fail(created.id, 'rateLimit')
  await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'wait before restart')
  await r.stop()
  const disk = await r.stored(); disk.records[0].resetsAt = r.now() - 2000; disk.records[0].nextAt = r.now() - 1000
  await writeFile(join(r.stateDir, 'lead', 'incidents.json'), JSON.stringify(disk))
  const next = await rig(t, r), policy = next.initialPolicy
  await next.nextRetry()
  await after(next, () => next.prompts.length === 1 ? true : null, 'one overdue retry')
  await next.advance(100)
  assert.equal(next.prompts.length, 1); assert.equal((await next.stored()).records[0].attempts, 1)
  assert.equal(policySnapshot(next), policy)
})

test('changing the Lead key preserves a pending provider reset wait', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Daily', windows: [{ label: 'Daily', resetsAt: r.now() + 2000, usedPercent: 100, windowMinutes: 1440 }] } })
  r.fail(created.id, 'rateLimit')
  await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'wait before key change')
  await r.service.deleteKey('anthropic')
  assert.equal((await r.stored()).records[0]?.state, 'waiting-reset')
  await r.nextRetry()
  await after(r, () => r.prompts.length === 2 ? true : null, 'retry survives non-stop key change')
})

test('a person-chosen reset retry uses the deterministic host continue and a new failure wakes again', async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits')
  await after(r, () => r.incident().length === 1 ? true : null, 'initial ask')
  // First retry now makes a new failed turn, even for an identical error.
  await r.journal.appendMessage('retry-now', 'Retry this chat', 'person')
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Retry now' } })
  r.fail(created.id, 'credits')
  await after(r, () => r.incident().length === 2 ? true : null, 'retry failure wakes again')
  // Use an exhausted quota incident to give the next chosen retry a future provider reset.
  const file = join(r.stateDir, 'lead', 'incidents.json')
  await r.stop()
  const disk = await r.stored(); disk.records[0].kind = 'quota'; disk.records[0].resetsAt = r.now() + 2000
  await writeFile(file, JSON.stringify(disk))
  const next = await rig(t, r), budget = JSON.stringify(next.journal.state.budget)
  await next.journal.appendMessage('retry-reset', 'Retry when it resets', 'person')
  await next.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'This text is not the continue', retryAt: 'reset' } })
  assert.equal(next.prompts.length, 0)
  assert.equal(JSON.stringify(next.journal.state.budget), budget)
  await next.nextRetry()
  await after(next, () => next.prompts.length === 1 ? true : null, 'chosen reset retry')
  assert.match(next.prompts[0]!, /Continue from where you stopped\./)
  assert.doesNotMatch(next.prompts[0]!, /This text is not the continue/)
  await next.advance(100); assert.equal(next.prompts.length, 1)
})


test('a direct send awaiting turn-start is busy to recovery and cannot queue a continue behind it', async t => {
  const r = await rig(t), created = await r.start()
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Daily', windows: [{ label: 'Daily', resetsAt: r.now() + 500, usedPercent: 100, windowMinutes: 1440 }] } })
  r.fail(created.id, 'rateLimit')
  await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'reset wait')
  const due = (await r.stored()).records[0].nextAt
  const session = r.runtime.sessions.get(created.id.slice(created.id.indexOf(':') + 1))!
  const entered = deferred(), released = deferred(), send = session.send.bind(session)
  t.mock.method(session, 'send', async (...args: Parameters<typeof send>) => { entered.resolve(); await released.promise; return send(...args) })
  const sending = r.host.call('workspace/session/send', { id: created.id, text: 'Person follow-up already sending' })
  try {
    await entered.promise; await r.nextRetry()
    await after(r, async () => { const record = (await r.stored()).records[0]; return record.state === 'waiting-reset' && record.nextAt > due ? true : null }, 'busy retry defers')
    assert.equal((await r.stored()).records[0].attempts, 0)
  } finally { released.resolve(); await sending; await r.idle() }
  assert.equal(r.prompts.length, 2)
  assert.doesNotMatch(r.prompts[1]!, /Continue from where you stopped/)
})

for (const failAt of [2, 3]) test(`a late pre-effect retry admission failure (${failAt}) re-arms instead of silently consuming an attempt`, async t => {
  const r = await rig(t), created = await r.start()
  let admissions = 0
  r.onResolve(async call => { if (call.method === 'lead/chat/send' && ++admissions >= failAt) throw new Error('Synthetic temporary admission refusal') })
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Daily', windows: [{ label: 'Daily', resetsAt: r.now() + 200, usedPercent: 100, windowMinutes: 1440 }] } })
  r.fail(created.id, 'rateLimit')
  await r.idle(); await r.nextRetry()
  await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.blocked === 1 ? true : null, 'retry re-armed after refused tool resolution')
  const record = (await r.stored()).records[0]
  assert.equal(record.state, 'waiting-reset'); assert.equal(record.attempts, 0)
  assert.equal(r.prompts.length, 1); assert.equal(r.incident().length, 0)
})


test('a person turn superseding an undispatched retry inherits no automatic attempt charge', async t => {
  const r = await rig(t), created = await r.start()
  const entered = deferred()
  let release: (() => void) | undefined, admissions = 0
  r.onResolve(async call => { if (call.method === 'lead/chat/send' && ++admissions === 2) await new Promise<void>(resolve => { release = resolve; entered.resolve() }) })
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id, limits: { reached: 'Daily', windows: [{ label: 'Daily', resetsAt: r.now() + 200, usedPercent: 100, windowMinutes: 1440 }] } })
  r.fail(created.id, 'rateLimit')
  const advancing = r.nextRetry()
  try {
    await entered.promise
    await r.host.call('workspace/session/send', { id: created.id, text: 'A person follow-up before the retry sends' })
    r.fail(created.id, 'network')
    await r.host.leadChats.idle(false)
    assert.equal((await r.stored()).records[0]?.attempts, 0)
    release!(); await advancing
    await after(r, async () => (await r.stored()).records[0]?.state === 'waiting-reset' ? true : null, 'new failed person turn')
    assert.equal((await r.stored()).records[0]?.attempts, 0)
  } finally { release?.(); await advancing }
  await after(r, () => [...r.journal.state.attempts.values()].some(one => one.method === 'lead/chat/send' && one.phase === 'finished') ? true : null, 'stale retry refused before effect')
  assert.equal((await r.stored()).records[0]?.attempts, 0)
  assert.equal(r.prompts.length, 2)
})


test('a direct retry rejected by the agent asks without replaying an unconfirmed send', { timeout: 30_000 }, async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits'); await r.idle()
  await r.journal.appendMessage('retry-answer', 'Retry this chat', 'person')
  r.runtime.sessions.get(created.id.slice(created.id.indexOf(':') + 1))!.sendFailure = new Error('Synthetic send rejection')
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Continue' } }, 'uncertain')
  const incident = (await r.stored()).records[0]
  assert.equal(incident.state, 'asked')
  assert.equal(incident.attempts, 1)
  assert.match(incident.lastError.message, /confirm|check/i)
  await r.advance(600_000)
  assert.equal(r.prompts.length, 1, 'an uncertain send is never replayed automatically')
})

test('an automatically retried send rejected by the agent still asks', { timeout: 30_000 }, async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'network'); await r.idle()
  r.runtime.sessions.get(created.id.slice(created.id.indexOf(':') + 1))!.sendFailure = new Error('Synthetic send rejection')
  await r.nextRetry()
  assert.equal((await r.stored()).records[0].state, 'asked')
  await r.advance(600_000)
  assert.equal(r.prompts.length, 1)
})

test('a late rejected retry cannot replace a newer completed turn', { timeout: 30_000 }, async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits'); await r.idle()
  await r.journal.appendMessage('retry-answer', 'Retry this chat', 'person')
  const id = sessionId(created.id.slice(created.id.indexOf(':') + 1))
  const session = r.runtime.sessions.get(String(id))!
  const entered = deferred(), release = deferred()
  t.after(() => release.resolve())
  t.mock.method(session, 'send', async () => { entered.resolve(); await release.promise; throw new Error('Synthetic late rejection') })
  const sending = r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Continue' } }, 'uncertain')
  try {
    await entered.promise
    r.runtime.emit({ type: 'turn/completed', sessionId: id, turn: { id: turnId('new-completed-turn'), items: [], status: 'completed' } })
    await r.idle()
    assert.equal((await r.stored()).records[0].state, 'cleared')
  } finally { release.resolve(); await sending }
  assert.equal((await r.stored()).records[0].state, 'cleared')
})

test('a late rejected retry cannot undo person take-over', { timeout: 30_000 }, async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits'); await r.idle()
  await r.journal.appendMessage('retry-answer', 'Retry this chat', 'person')
  const session = r.runtime.sessions.get(created.id.slice(created.id.indexOf(':') + 1))!
  const entered = deferred(), release = deferred()
  t.after(() => release.resolve())
  t.mock.method(session, 'send', async () => { entered.resolve(); await release.promise; throw new Error('Synthetic late rejection') })
  const sending = r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Continue' } }, 'uncertain')
  try {
    await entered.promise
    await r.host.call('lead/chat/takeOver', { id: created.id }); await r.idle()
    assert.equal((await r.stored()).records[0].state, 'stopped')
  } finally { release.resolve(); await sending }
  assert.equal((await r.stored()).records[0].state, 'stopped')
})

test('a queued retry rejected after dispatch asks without replay', { timeout: 30_000 }, async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits'); await r.idle()
  await r.journal.appendMessage('retry-answer', 'Retry this chat', 'person')
  await r.host.call('workspace/session/send', { id: created.id, text: 'Person turn still running' })
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Continue after this turn' } })
  const target = { runtime: r.runtime.info.id, sessionId: sessionId(created.id.slice(created.id.indexOf(':') + 1)) }
  const session = r.runtime.sessions.get(String(target.sessionId))!
  session.sendFailure = new Error('Synthetic send rejection')
  const readEntered = deferred(), releaseRead = deferred(), paused = deferred()
  t.after(() => releaseRead.resolve())
  let holdRead = true
  r.onResolve(async call => { if (call.method === 'lead/chat/read' && holdRead) { holdRead = false; readEntered.resolve(); await releaseRead.promise } })
  const pause = r.host.registry.pauseQueue.bind(r.host.registry)
  t.mock.method(r.host.registry, 'pauseQueue', (record: Parameters<typeof pause>[0], reason: string) => { pause(record, reason); paused.resolve() })
  session.finish('The earlier turn finished')
  try {
    await readEntered.promise; await paused.promise
    await (r.host.leadChats as import('../src/lead/chats.js').LeadChats).incidents!.idle()
    const notice = r.notifications.find(one => one.method === 'event' && one.params.event.type === 'notice' && one.params.event.message.includes('queued message'))
    assert.ok(notice && notice.method === 'event' && notice.params.event.type === 'notice')
    assert.match(notice.params.event.message, /could not be confirmed/i)
    assert.match(notice.params.event.message, /check.*conversation.*before/i)
    assert.doesNotMatch(notice.params.event.message, /was not sent/i)
    const incident = (await r.stored()).records[0]
    assert.equal(incident.state, 'asked')
    assert.equal(incident.attempts, 1)
    assert.match(incident.lastError.message, /confirm|check/i)
    assert.equal(r.host.registry.get(target.runtime, target.sessionId)!.queue.status, 'paused')
    assert.equal(r.prompts.length, 2)
  } finally { releaseRead.resolve(); await r.idle() }
  assert.equal((await r.stored()).records[0].state, 'asked', 'an older turn observation cannot clear the newer unconfirmed send')
})

test('an earlier turn observation cannot settle a queued retry while its send is pending', { timeout: 30_000 }, async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits'); await r.idle()
  await r.journal.appendMessage('retry-answer', 'Retry this chat', 'person')
  await r.host.call('workspace/session/send', { id: created.id, text: 'Person turn still running' })
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Continue after this turn' } })
  const id = sessionId(created.id.slice(created.id.indexOf(':') + 1)), session = r.runtime.sessions.get(String(id))!
  const readEntered = deferred(), releaseRead = deferred(), sendEntered = deferred(), rejectSend = deferred(), paused = deferred()
  t.after(() => { releaseRead.resolve(); rejectSend.resolve() })
  let holdRead = true
  r.onResolve(async call => { if (call.method === 'lead/chat/read' && holdRead) { holdRead = false; readEntered.resolve(); await releaseRead.promise } })
  t.mock.method(session, 'send', async () => { sendEntered.resolve(); await rejectSend.promise; throw new Error('Synthetic send rejection') })
  const pause = r.host.registry.pauseQueue.bind(r.host.registry)
  t.mock.method(r.host.registry, 'pauseQueue', (record: Parameters<typeof pause>[0], reason: string) => { pause(record, reason); paused.resolve() })
  session.finish('The earlier turn finished')
  try {
    await readEntered.promise; await sendEntered.promise
    releaseRead.resolve(); await (r.host.leadChats as import('../src/lead/chats.js').LeadChats).idle(false)
    assert.equal((await r.stored()).records[0].state, 'retrying')
    const target = { runtime: r.runtime.info.id, sessionId: id }, record = r.host.registry.get(target.runtime, id)!
    await r.host.call('turn/queue/cancel', { ...target, id: record.queue.messages[0]!.id })
    rejectSend.resolve(); await paused.promise; await r.idle()
    assert.equal((await r.stored()).records[0].state, 'asked', 'removal after dispatch cannot erase an unconfirmed outcome')
  } finally { releaseRead.resolve(); rejectSend.resolve() }
})

test('a desk interrupt settles an automatic retry through its terminal turn event', async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'network'); await r.idle(); await r.nextRetry()
  assert.equal((await r.stored()).records[0].state, 'retrying')
  await r.host.call('turn/interrupt', { runtime: r.runtime.info.id, sessionId: sessionId(created.id.slice(created.id.indexOf(':') + 1)) })
  await r.idle()
  assert.equal((await r.stored()).records[0].state, 'stopped')
  const count = r.prompts.length; await r.advance(600_000); assert.equal(r.prompts.length, count)
})


test('a detached agent pauses a queued renewal without retiring it before resume', async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits'); await r.idle()
  await r.journal.appendMessage('retry-answer', 'Retry this chat', 'person')
  await r.host.call('workspace/session/send', { id: created.id, text: 'Person turn still running' })
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Continue after this turn' } })
  const target = { runtime: r.runtime.info.id, sessionId: sessionId(created.id.slice(created.id.indexOf(':') + 1)) }
  const record = r.host.registry.get(target.runtime, target.sessionId)!
  const settings = r.runtime.sessions.get(String(target.sessionId))!.settings()
  assert.equal(record.queue.messages.length, 1)
  assert.equal((await r.stored()).records[0].state, 'retrying')

  r.runtime.emit({ type: 'session/detached', sessionId: target.sessionId })
  await r.idle()
  assert.equal(record.queue.status, 'paused')
  assert.equal(record.queue.messages.length, 1)
  assert.equal((await r.stored()).records[0].state, 'retrying', 'a held message still owns its recovery')

  r.runtime.sessions.set(String(target.sessionId), new FakeSession(r.runtime, target.sessionId, settings, { model: 'fake-1', tone: 'plain', uppercase: false }))
  await r.host.call('turn/queue/flush', target)
  await r.idle()
  assert.equal(r.prompts.length, 3, 'the retained renewal sends once')
  assert.equal(record.queue.messages.length, 0)
  assert.equal((await r.stored()).records[0].state, 'retrying')
  await r.host.call('turn/queue/flush', target)
  assert.equal(r.prompts.length, 3, 'another flush cannot send the renewal twice')
})

test('expiry of a removed paused conversation settles its queued renewal', async t => {
  let transcripts: TranscriptStore | undefined
  const recordTranscript = TranscriptStore.prototype.record
  t.mock.method(TranscriptStore.prototype, 'record', function (this: TranscriptStore, ...args: Parameters<TranscriptStore['record']>) {
    transcripts = this
    return recordTranscript.apply(this, args)
  })
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits'); await r.idle()
  await r.journal.appendMessage('retry-answer', 'Retry this chat', 'person')
  await r.host.call('workspace/session/send', { id: created.id, text: 'Person turn still running' })
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Continue after this turn' } })
  const target = { runtime: r.runtime.info.id, sessionId: sessionId(created.id.slice(created.id.indexOf(':') + 1)) }
  const record = r.host.registry.get(target.runtime, target.sessionId)!
  r.host.registry.pauseQueue(record, 'The agent stopped')
  assert.equal((await r.stored()).records[0].state, 'retrying')
  assert.ok(transcripts)
  await transcripts.flushSession(target.runtime, target.sessionId)
  const saved = await transcripts.recover(target.runtime, target.sessionId)
  assert.ok(saved)
  assert.equal(canonicalTranscriptBody(saved.turns).canonical, canonicalTranscriptBody(record.session.turns).canonical)
  const removed = await r.host.call('session/remove', { ...target, removed: true })
  const deadline = removed.undoUntil
  assert.ok(deadline, 'the actual removal provides an Undo deadline')
  assert.equal(r.host.registry.get(target.runtime, target.sessionId), undefined)
  assert.equal(r.host.registry.forReopen(target.runtime, target.sessionId), record)
  r.host.registry.sweepRemoved(deadline - 1)
  await r.idle()
  assert.equal((await r.stored()).records[0].state, 'retrying', 'Undo still owns the queued renewal')
  r.host.registry.sweepRemoved(deadline)
  await r.idle()
  assert.equal((await r.stored()).records[0].state, 'stopped')
  assert.equal(r.prompts.length, 2, 'expiry did not dispatch the renewal')
})

for (const removal of ['cancel', 'clear', 'delete'] as const) test(`a queued renewal removed before dispatch settles recovery: ${removal}`, async t => {
  let transcripts: TranscriptStore | undefined
  if (removal === 'delete') {
    const record = TranscriptStore.prototype.record
    t.mock.method(TranscriptStore.prototype, 'record', function (this: TranscriptStore, ...args: Parameters<TranscriptStore['record']>) {
      transcripts = this
      return record.apply(this, args)
    })
  }
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits'); await r.idle()
  await r.journal.appendMessage('retry-answer', 'Retry this chat', 'person')
  await r.host.call('workspace/session/send', { id: created.id, text: 'Person turn still running' })
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Continue after this turn' } })
  assert.equal((await r.stored()).records[0].state, 'retrying')
  const target = { runtime: r.runtime.info.id, sessionId: sessionId(created.id.slice(created.id.indexOf(':') + 1)) }
  const record = r.host.registry.get(target.runtime, target.sessionId)!
  assert.equal(record.queue.messages.length, 1)
  r.host.registry.pauseQueue(record, 'The agent stopped')
  await r.idle()
  assert.equal((await r.stored()).records[0].state, 'retrying', 'pause retains the renewal before removal')
  if (removal === 'delete') {
    // A bare registry delete does not perform the Host's transcript cleanup.
    // Settle this active owner's exact body first so deletion cannot strand a
    // pending write whose generation no longer has an owner.
    assert.ok(transcripts, 'the real Host recorded a transcript')
    const held = record.session
    await transcripts.flushSession(target.runtime, target.sessionId)
    const saved = await transcripts.recover(target.runtime, target.sessionId)
    assert.ok(saved, 'the current transcript reached durable storage')
    assert.equal(canonicalTranscriptBody(saved.turns).canonical, canonicalTranscriptBody(held.turns).canonical)
    assert.equal(r.host.registry.get(target.runtime, target.sessionId), record, 'the saved generation still has its owner')
    assert.equal(record.session, held, 'the saved body is still the current body')
    assert.ok(record.running.size > 0 && held.turns.some(turn => turn.status === 'inProgress'), 'the person turn is still active')
    assert.equal(record.queue.messages.length, 1, 'the renewal is still queued at deletion')
    r.host.registry.delete(target.runtime, target.sessionId)
  }
  else if (removal === 'clear') await r.host.call('turn/queue/clear', target)
  else await r.host.call('turn/queue/cancel', { ...target, id: record.queue.messages[0]!.id })
  await r.idle()
  assert.equal((await r.stored()).records[0].state, 'stopped')
  assert.equal(r.prompts.length, 2, 'the renewal never reaches the worker')
})


test('a queued renewal rejected by the outer host admission settles before its terminal observation resumes', async t => {
  const r = await rig(t), created = await r.start()
  r.fail(created.id, 'credits'); await r.idle()
  await r.journal.appendMessage('retry-answer', 'Retry this chat', 'person')
  await r.host.call('workspace/session/send', { id: created.id, text: 'Person turn still running' })
  await r.execute({ method: 'lead/chat/send', params: { id: created.id, text: 'Continue after this turn' } })
  const target = { runtime: r.runtime.info.id, sessionId: sessionId(created.id.slice(created.id.indexOf(':') + 1)) }
  const session = r.runtime.sessions.get(String(target.sessionId))!, settings = session.settings()
  const readEntered = deferred(), releaseRead = deferred(), paused = deferred()
  let changeSettings = true
  r.onResolve(async call => {
    if (call.method === 'lead/chat/read') { readEntered.resolve(); await releaseRead.promise }
    if (call.method === 'lead/chat/send' && changeSettings) {
      changeSettings = false
      t.mock.method(session, 'settings', () => ({ ...settings, cwd: join(r.repo.dir, 'changed-folder') }))
    }
  })
  const pause = r.host.registry.pauseQueue.bind(r.host.registry)
  t.mock.method(r.host.registry, 'pauseQueue', (record: Parameters<typeof pause>[0], reason: string) => { pause(record, reason); paused.resolve() })
  session.finish('The earlier turn finished')
  try {
    await readEntered.promise; await paused.promise
    await (r.host.leadChats as import('../src/lead/chats.js').LeadChats).incidents!.idle()
    assert.match(r.host.registry.get(target.runtime, target.sessionId)!.queue.reason!, /scope changed before dispatch/)
    assert.equal((await r.stored()).records[0].state, 'stopped')
    assert.equal(r.prompts.length, 2)
    const notice = r.notifications.find(one => one.method === 'event' && one.params.event.type === 'notice' && one.params.event.message.includes('queued message'))
    assert.ok(notice && notice.method === 'event' && notice.params.event.type === 'notice')
    assert.match(notice.params.event.message, /queued message was not sent/i)
  } finally { releaseRead.resolve(); await r.idle() }
})

// A retry the host sends on its own is automatic work: after the goal's time has run out it goes nowhere.
test('a stuck-chat retry the host schedules is refused once the goal\'s deadline has passed', async t => {
  const r = await rig(t)
  const created = await r.start()
  const reset = r.now() + 200
  await r.host.leadAutonomy.setDeadline({ logicalGoalId: 'recovery-fixture', deadlineAt: Date.now() + 400 })
  r.runtime.emit({ type: 'limits/updated', runtime: r.runtime.info.id,
    limits: { reached: 'Weekly', windows: [{ label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: reset }] } })
  r.fail(created.id, 'rateLimit')
  await after(r, async () => (await r.stored().catch(() => null))?.records[0]?.state === 'waiting-reset' ? true : null, 'persisted reset wait')
  await new Promise(resolve => setTimeout(resolve, 500)) // the autonomy store keeps real time; the retry clock is the rig's
  await r.advance(500)
  await r.idle()
  assert.equal(r.prompts.length, 1, 'no continue goes out after the time has run out')
  assert.equal(await r.host.leadAutonomy.deadlineElapsed('recovery-fixture'), true)
})
