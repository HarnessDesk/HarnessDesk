import assert from 'node:assert/strict'
import test from 'node:test'
import { createLeadLoop, createLeadJournal, leadCheckpoint, parseLeadCheckpoint, type LeadJournalRecord } from '@harnessdesk/lead'
import { parseLeadAcceptanceContract, type LeadCard, type WireNotification } from '@harnessdesk/protocol'
import { dispatch, type HostContext } from '../src/methods/index.js'

const key = 'sk-test-not-real-0000'
const project = { id: 'demo', path: '/workspace/demo' }
const policy = { version: 1 as const, revision: 1, mode: 'default' as const, rules: [] }
const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Inspect the check', project,
  policyRevision: 1, steps: [{ id: 'work', title: 'Review work', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture', model: 'fixture-model' }, ceiling: 'edit' }] }],
  assertions: [{ id: 'unit', kind: 'check', description: 'Tests pass' }, { id: 'review', kind: 'review', description: 'Review approves' }, { id: 'blockers', kind: 'blocking-findings', description: 'No blockers' }], caps: { usdMicros: 100000, rounds: 5 } })
const plan = { version: 1 as const, id: 'plan', revision: 1, type: 'plan' as const, contractDigest: contract.digest, contract }
const planClick = { version: 1 as const, cardId: 'plan', cardType: 'plan' as const, expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' as const }
const controlsModule = async (): Promise<any> => {
  const path = new URL('../src/lead/controls.js', import.meta.url).href
  const module = await import(path).catch(() => ({}))
  assert.equal(typeof module.LeadControls, 'function', 'host-owned LeadControls must exist')
  return module
}
const rig = async (over: { configured?: boolean; service?: Record<string, any>; controls?: Record<string, any> } = {}) => {
  const records: LeadJournalRecord[] = [], notifications: WireNotification[] = [], sends: unknown[] = [], answers: unknown[] = []
  const storage = { async read() { return records }, async append(record: LeadJournalRecord) { records.push(record) } }
  const journal = await createLeadJournal(storage)
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 1000 })
  let configured = over.configured ?? false
  const service = { async status() { return { configured, protection: 'synthetic cipher' } },
    async setKey(provider: string, value: string) { assert.equal(provider, 'anthropic'); assert.equal(value, key); configured = true },
    async deleteKey() { configured = false },
    async assertPublic(value: unknown) { if (JSON.stringify(value).includes(key)) throw new Error('lead-secret-refused') },
    async send(value: unknown) { sends.push(value); return { status: 'completed', text: 'Ready to inspect' } }, ...over.service }
  const { LeadControls } = await controlsModule()
  let nextCard = 0
  const controls = new LeadControls({ journal, service, project, model: 'fixture-model', now: () => 100, nextId: () => `card-${++nextCard}`,
    push: (value: WireNotification) => notifications.push(value), decidePerson: async (...args: unknown[]) => { answers.push(args) }, decideResult: async (...args: unknown[]) => { answers.push(args) }, ...over.controls })
  const ctx = { leadThreadRead: () => controls.readThread(), leadThreadSend: (p: unknown) => controls.send(p),
    leadCardDecide: (p: unknown) => controls.decide(p), leadSettingsRead: () => controls.readSettings(),
    leadSettingsUpdate: (p: unknown) => controls.updateSettings(p), leadResume: (p: unknown) => controls.resume(p) } as unknown as HostContext
  const call = (method: string, params: unknown = {}) => dispatch(ctx, method as never, params as never) as Promise<any>
  return { controls, journal, records, storage, notifications, sends, answers, service, call }
}
const code = (reason: string) => (error: any) => error.wireCode === reason

test('window handlers reach named context operations and thread sends are durably idempotent', async () => {
  const s = await rig({ configured: true })
  const first = await s.call('lead/thread/send', { idempotencyKey: 'send-1', text: 'Inspect the check' })
  await s.controls.idle()
  const seq = s.journal.state.seq
  assert.deepEqual(await s.call('lead/thread/send', { idempotencyKey: 'send-1', text: 'A retry cannot replace the first text' }), first)
  assert.equal(s.journal.state.seq, seq)
  assert.equal(s.sends.length, 1)
  const { thread } = await s.call('lead/thread/read')
  assert.deepEqual(thread.messages.map((m: any) => m.text), ['Inspect the check', 'Ready to inspect'])
  const reopened = await createLeadJournal(s.storage)
  assert.deepEqual(await (reopened as any).appendMessage('send-1', 'a retry'), first)
  const checkpoint = parseLeadCheckpoint(leadCheckpoint(reopened.state, '0'.repeat(64)))
  assert.deepEqual(checkpoint.state, reopened.state)
})

test('stale, changed-digest and double clicks cannot change a plan gate', async () => {
  const s = await rig(); await s.journal.offerCard(plan)
  for (const patch of [{ expectedRevision: 0 }, { contractDigest: 'b'.repeat(64) }]) {
    const before = s.journal.state
    await assert.rejects(s.call('lead/card/decide', { ...planClick, ...patch }), code('lead-card-stale'))
    assert.deepEqual(s.journal.state, before)
  }
  await s.call('lead/card/decide', planClick)
  const before = s.journal.state
  await assert.rejects(s.call('lead/card/decide', planClick), code('lead-card-decided'))
  assert.deepEqual(s.journal.state, before)
})

test('resume reports plan-pending, stale and no-wait reasons without changing state', async () => {
  const s = await rig()
  await assert.rejects(s.call('lead/resume', { expectedRevision: s.journal.state.seq }), code('lead-no-person-wait'))
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  await assert.rejects(s.call('lead/resume', { expectedRevision: 0 }), code('lead-revision-stale'))
  await s.journal.offerCard(plan); await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  const before = s.journal.state
  await assert.rejects(s.call('lead/resume', { expectedRevision: before.seq }), code('lead-plan-pending'))
  assert.deepEqual(s.journal.state, before)
  await s.call('lead/card/decide', planClick)
  await s.controls.idle()
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  await s.call('lead/resume', { expectedRevision: s.journal.state.seq })
  assert.equal(s.journal.state.phase, 'running')
  assert.equal(s.journal.state.managementReason, null)
})

test('settings tightening applies; widening requires a permission card and its fenced decision', async () => {
  const s = await rig()
  await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, policy: { ...policy, revision: 2, mode: 'plan' } })
  assert.equal(s.journal.state.policy?.mode, 'plan')
  await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, policy: { ...policy, revision: 3, mode: 'manage' } })
  assert.equal(s.journal.state.policy?.mode, 'plan')
  const card = s.journal.state.cards.at(-1)!
  assert.equal(card.type, 'permission-change')
  await s.call('lead/card/decide', { version: 1, cardId: card.id, cardType: card.type, expectedRevision: card.revision, contractDigest: null, choice: 'approve' })
  assert.equal(s.journal.state.policy?.mode, 'manage')
  await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, caps: { usdMicros: 50000, rounds: 3 } })
  assert.equal(s.journal.state.budget?.caps.usdMicros, 50000)
  await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, caps: contract.caps })
  assert.equal(s.journal.state.cards.at(-1)?.type, 'budget-change')
  assert.equal(s.journal.state.budget?.caps.usdMicros, 50000)
})

test('worker approval identifiers and relays never enter a person decision', async () => {
  const s = await rig(); await s.journal.offerCard(plan); await s.call('lead/card/decide', planClick)
  await s.journal.offerCard({ version: 1, id: 'worker-approval-1', revision: 1, type: 'waiting', kind: 'worker-approval', runId: 'run-1',
    personCardId: null, summary: 'Worker asks for permission', assertions: [], contractDigest: contract.digest })
  await assert.rejects(s.call('lead/card/decide', { version: 1, cardId: 'worker-approval-1', cardType: 'waiting', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' }), code('lead-worker-approval'))
  assert.equal(s.answers.length, 0)
})

test('write-only keys never reach thread, settings, notifications, journal or errors', async () => {
  const s = await rig()
  await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key } })
  assert.equal((await s.call('lead/settings/read')).settings.key.configured, true)
  await assert.rejects(s.call('lead/thread/send', { idempotencyKey: 'echo', text: key }), code('lead-secret-refused'))
  assert.equal(JSON.stringify([await s.call('lead/thread/read'), await s.call('lead/settings/read'), s.notifications, s.records]).includes(key), false)
  await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key: null } })
  assert.equal((await s.call('lead/settings/read')).settings.key.configured, false)
})

test('changed projections have strictly increasing revisions and bounded retained messages', async () => {
  const s = await rig({ configured: true })
  for (let i = 0; i < 270; i++) { await s.call('lead/thread/send', { idempotencyKey: `send-${i}`, text: 'x'.repeat(1000) }); await s.controls.idle() }
  await s.controls.idle()
  const revisions = s.notifications.map((n: any) => n.params.revision)
  assert.ok(revisions.length > 0)
  assert.ok(revisions.every((revision, i) => i === 0 || revision > revisions[i - 1]!))
  for (const notification of s.notifications) assert.ok(Buffer.byteLength(JSON.stringify(notification)) <= 1048576)
  const { thread } = await s.call('lead/thread/read')
  assert.ok(thread.messages.length <= 256); assert.ok(thread.olderMessages > 0)
  assert.equal(thread.olderMessages + thread.messages.length, 540)
})


test('live person decision revalidates Flow membership and changed evidence before answering', async () => {
  const path = new URL('../src/lead/person-decision.js', import.meta.url).href
  const module = await import(path).catch(() => ({}))
  assert.equal(typeof module.answerLeadPersonGate, 'function', 'live person gate validator must exist')
  const s = await rig(); await s.journal.offerCard(plan); await s.call('lead/card/decide', planClick)
  const { parseFlowPolicy } = await import('../src/flow-policy.js')
  const { flowRevision } = await import('../src/flow-execution.js')
  const { leadReviewedResultSource } = await import('@harnessdesk/lead')
  const document = parseFlowPolicy(leadReviewedResultSource).document!
  const revision = flowRevision(document)
  // Seed ownership through the normal host-binding path (no model-supplied approval id).
  const state = s.journal.state
  const ownedJournal = { get state() { return { ...state, runs: [{ runId: 'run-1', teamId: 'team-1', correlationId: 'start-1' }], steps: state.steps.map(step => ({ ...step, state: 'started', attemptId: 'start-1' })) } } }
  let evidenceHead = 'head-1', source = revision, answers = 0, live = true, race = false
  const assertions = [{ assertionId: 'unit', status: 'passed', revision: 1, contractRevision: 1,
    evidence: [{ kind: 'check', id: 'check-1', revision: 'head-1' }], reason: null },
    { assertionId: 'review', status: 'passed', revision: 1, contractRevision: 1, evidence: [{ kind: 'review', id: 'review-1', revision: 'head-1' }], reason: null },
    { assertionId: 'blockers', status: 'passed', revision: 1, contractRevision: 1, evidence: [], reason: null }]
  const card = { version: 1, id: 'gate', revision: 1, type: 'waiting', kind: 'person', runId: 'run-1', personCardId: '7',
    summary: 'Accept the reviewed result', assertions, contractDigest: contract.digest }
  const click = { version: 1, cardId: 'gate', cardType: 'waiting', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' }
  const execution = () => ({ id: 'run-1', goal: 'team-1', state: 'running', revision: source, document,
    flow: { name: 'Lead reviewed result' }, rounds: [{ cards: [7] }] })
  const intent = { id: 7, state: 'open', outcome: null as string | null }
  const options = { journal: ownedJournal, project, now: () => 100,
    flows: { executionOf: execution, storedRun: () => ({ source: leadReviewedResultSource, compiled: { document } }), personCard: () => ({ live, outcomes: ['accepted', 'declined'] }) },
    team: { stateFor: () => ({ root: project.path, intents: [intent] }), async intentAction(...args: any[]) { if (race) live = false; args.at(-1)?.(); intent.state = 'done'; intent.outcome = args[4]; answers++ }, async flush() {} },
    readEvidence: async () => ({ project, runId: 'run-1', contractDigest: contract.digest, revision: evidenceHead, observedAt: 100,
      complete: true, spendComplete: true, findingsComplete: true, findings: [], reviews: [{ assertionId: 'review', id: 'review-1', revision: evidenceHead, observedAt: 100, verdict: 'approve', complete: true }], diffs: [], checks: [
        { assertionId: 'unit', id: 'check-1', revision: evidenceHead, observedAt: 100, exit: 0, timedOut: false, dirty: false, counted: true }] }) }
  evidenceHead = 'head-2'
  await assert.rejects(module.answerLeadPersonGate(options, card, click, contract), code('lead-gate-changed'))
  assert.equal(answers, 0)
  evidenceHead = 'head-1'; source = 'changed'
  await assert.rejects(module.answerLeadPersonGate(options, card, click, contract), code('lead-gate-changed'))
  source = revision; live = false
  await assert.rejects(module.answerLeadPersonGate(options, card, click, contract), code('lead-gate-changed'))
  live = true; race = true
  await assert.rejects(module.answerLeadPersonGate(options, card, click, contract), code('lead-gate-changed'))
  assert.equal(answers, 0, 'a changed gate after a pending save cannot be answered')
  live = true; race = false
  await module.answerLeadPersonGate(options, card, click, contract)
  assert.equal(answers, 1)
})

test('a result click invokes the live person path instead of accepting only the Lead summary', async () => {
  const s = await rig(); await s.journal.offerCard(plan); await s.call('lead/card/decide', planClick)
  const budget = { version: 1, revision: 1, caps: contract.caps, leadUsdMicros: 0, workerUsdMicros: 0,
    reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null }
  await s.journal.offerCard({ version: 1, id: 'result', revision: 1, type: 'result', outcome: 'reviewed', summary: 'Ready', assertions: [], budget, contractDigest: contract.digest } as any)
  await s.call('lead/card/decide', { version: 1, cardId: 'result', cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' })
  assert.equal(s.answers.length, 1)
  assert.equal(s.journal.state.phase, 'accepted')
})

for (const action of ['resume', 'send'] as const) test(`the window ${action} resets the real loop no-progress counter`, async () => {
  const s = await rig({ configured: true }), scheduled: (() => void)[] = []
  let requests = 0, sequence = 0, end: (() => void) | undefined
  const loop = createLeadLoop({ journal: s.journal, project, now: () => 100,
    nextId: () => `loop-${++sequence}`,
    clock: { now: () => 100, schedule(callback: () => void) { scheduled.push(callback); return () => {} } },
    desk: { async call(method: string) { if (method === 'flow/catalog') throw new Error('synthetic read failed'); return {} },
      async synced() {}, snapshot: () => ({ teams: [], runs: [], boards: [], seats: [], approvals: [], reviews: [], waiting: [] }),
      events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(resolve => { end = () => resolve({ done: true, value: undefined }) }),
        async return() { end?.(); return { done: true, value: undefined } } }) }) },
    messages: { apiKey: key, model: 'fixture-model', prices: { 'fixture-model': { inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1,
      cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 1 } }, countInput: async () => 10, wait: async () => {},
      transport: { async send() { requests++; return { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant',
        content: requests <= 4 ? [{ type: 'tool_use', id: `tool-${requests}`, name: 'flow_catalog', input: { root: project.path } }] : [{ type: 'text', text: 'Ready' }],
        stop_reason: requests <= 4 ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) } } } },
    freezePlan: async (proposal: any) => proposal, readEvidence: async () => { throw new Error('no runs') },
    resolveTool: async () => ({ project, runId: null, start: null, context: { desk: policy, projectPolicy: null, project, approved: null,
      budget: null, now: 100, policyInterpretation: 'idle' } }),
  } as any)
  const input = { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Inspect the check' }] }], maxTokens: 32 }
  await loop.request(input)
  for (let i = 0; i < 4; i++) { for (const callback of scheduled.splice(0)) callback(); await loop.idle() }
  assert.equal(requests, 3)
  assert.equal(s.journal.state.phase, 'waiting-for-user')
  assert.equal((await s.call('lead/thread/read')).wayOut, 'resume')
  s.service.send = async input => { const result = await loop.request(input as any); return { status: result?.status ?? 'refused', text: result?.text ?? '' } }
  await (action === 'resume' ? s.call('lead/resume', { expectedRevision: s.journal.state.seq }) :
    s.call('lead/thread/send', { idempotencyKey: 'continue', text: 'Try the check again' }))
  await s.controls.idle()
  assert.equal(requests, 4, 'the window control restarts the parked loop')
  assert.equal(s.journal.state.phase, 'running', 'the fourth failed tool turn starts a fresh allowance')
  for (const callback of scheduled.splice(0)) callback()
  await loop.idle()
  assert.equal(requests, 5)
  await loop.close()
})

test('a gate changed on the journal queue gets a typed stale refusal before any effect', async () => {
  const s = await rig(); await s.journal.offerCard(plan)
  let effects = 0
  const changed = s.journal.offerCard({ ...plan, revision: 2 })
  const click = s.journal.decideCard(planClick, 1000, undefined, async () => { effects++ })
  await changed
  await assert.rejects(click, code('lead-card-stale'))
  assert.equal(effects, 0)
  assert.equal(s.journal.state.contract, null)
})

test('malformed credential frames cannot echo secret fragments into wire logs or errors', async t => {
  const { EventEmitter } = await import('node:events')
  const { Server } = await import('node:http')
  const { WebSocketServer } = await import('ws')
  const { serve } = await import('../src/server.js')
  let http: InstanceType<typeof Server> | undefined
  const frames: unknown[] = [], logs: unknown[] = []
  class Socket extends EventEmitter { OPEN = 1; readyState = 1; send(raw: string) { frames.push(JSON.parse(raw)) } }
  const socket = new Socket()
  t.mock.method(Server.prototype, 'listen', function (this: InstanceType<typeof Server>, _port: number, _host: string, ready: () => void) {
    http = this; queueMicrotask(ready); return this
  })
  t.mock.method(Server.prototype, 'address', () => ({ port: 7777, address: '127.0.0.1', family: 'IPv4' }))
  t.mock.method(Server.prototype, 'close', function (this: InstanceType<typeof Server>, ready: () => void) { ready(); return this })
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (_request: unknown, _socket: unknown, _head: unknown, ready: (socket: unknown) => void) => ready(socket))
  const host = { addBroadcaster: () => () => {}, syncPayload: () => ({ method: 'sync', params: {} }),
    editorPlaneNotification: () => ({ method: 'editor/event', params: {} }), teamNotifications: () => [], pendingApprovalEvents: () => [] }
  const logger = { child() { return this }, info(...args: unknown[]) { logs.push(args) }, warn(...args: unknown[]) { logs.push(args) } }
  const server = await serve({ host: host as any, logger: logger as any, token: 'synthetic-window-token' }) // hd-secrets-ok: synthetic window transport credential
  t.after(() => server.close())
  http!.emit('upgrade', { url: '/ws?token=synthetic-window-token', headersDistinct: { host: ['127.0.0.1:7777'], origin: ['http://127.0.0.1:7777'] }, headers: { host: '127.0.0.1:7777', origin: 'http://127.0.0.1:7777' } }, {}, Buffer.alloc(0)) // hd-secrets-ok: synthetic window transport credential
  socket.emit('message', Buffer.from(key))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(JSON.stringify([logs, frames]).includes('sk-test'), false, 'even malformed input must stay out of log messages')
  const providerSecret = 'sk-ant-test-not-real-0000' // hd-secrets-ok: synthetic provider credential
  socket.emit('message', Buffer.from(JSON.stringify({ id: 9, method: 'lead/settings/update', params: { expectedRevision: 0, credential: { provider: providerSecret, key: null } } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(JSON.stringify([logs, frames]).includes(providerSecret), false, 'provider validation must stay out of logs and responses')
})

test('step 9 checkpoints acquire empty thread state without changing their authenticated bytes', async () => {
  const s = await rig()
  const checkpoint: any = leadCheckpoint(s.journal.state, '0'.repeat(64))
  delete checkpoint.state.messages; delete checkpoint.state.olderMessages; delete checkpoint.state.sends
  const original = JSON.stringify(checkpoint)
  const parsed = parseLeadCheckpoint(checkpoint)
  assert.deepEqual(parsed.state.messages, [])
  assert.equal(parsed.state.olderMessages, 0)
  assert.deepEqual(parsed.state.sends, [])
  assert.equal(JSON.stringify(parsed.checkpoint), original, 'the checksum is over the old bytes, before migration')
})

test('invalid journal decisions preserve the asynchronous refusal contract', async () => {
  const s = await rig(); await s.journal.offerCard(plan)
  await assert.rejects(s.journal.decideCard({ ...planClick, choice: 'accept' } as never))
  assert.equal(s.journal.state.contract, null)
})

test('the real HostContext connects window reads and idempotent sends to its Lead owner without starting a disabled child', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { Host, StateStore } = await import('../src/index.js')
  const { silent } = await import('./fixtures/harness.js')
  const home = await mkdtemp('/tmp/hd-lead-window-')
  const host = new Host({ leadEnabled: true, logger: silent, state: new StateStore(join(home, 'state.json')), catalogRefreshMs: 0 })
  t.after(async () => { await host.dispose(); await rm(home, { recursive: true, force: true }) })
  await host.start()
  const journal = await createLeadJournal({ async read() { return [] }, async append() {} })
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 1000 })
  let spawns = 0
  host.createLeadService({ journal, project: { id: 'demo', path: home }, model: 'fixture-model', prices: {},
    resolveTool: async () => { throw new Error('unused') }, freezePlan: async proposal => proposal,
    readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => { spawns++ }, send: async () => { throw new Error('unused') }, stop: async () => {}, ownershipWithdrawn() {} }) })
  const settings = await host.call('lead/settings/read', {})
  assert.deepEqual(settings.settings.key, { configured: false, protection: 'unavailable' })
  await assert.rejects(host.call('lead/thread/send', { idempotencyKey: 'prekey-host', text: 'No append' }), code('lead-key-missing'))
  t.mock.method(host.credentials, 'leadStatus', async () => ({ configured: true, protection: 'synthetic cipher' }))
  t.mock.method(host.credentials, 'resolveLead', async () => key)
  const first = await host.call('lead/thread/send', { idempotencyKey: 'host-send', text: 'Inspect the check' })
  assert.deepEqual(await host.call('lead/thread/send', { idempotencyKey: 'host-send', text: 'retry' }), first)
  const projection = await host.call('lead/thread/read', {})
  assert.equal(projection.thread.messages.length, 1)
  assert.equal(projection.thread.messages[0]?.text, 'Inspect the check')
  assert.equal(spawns, 0)
})


const within = async <T>(operation: Promise<T>, ms = 200): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('control deadline exceeded')), ms) })]) }
  finally { clearTimeout(timer) }
}
test('held paid send returns its receipt and leaves reads, caps and key deletion responsive', async () => {
  let release!: (value: any) => void, began!: () => void, deleted = false
  const started = new Promise<void>(resolve => { began = resolve })
  const held = new Promise(resolve => { release = resolve })
  const s = await rig({ configured: true, service: { send: () => { began(); return held }, deleteKey: async () => { deleted = true } } })
  const sent = s.controls.send({ idempotencyKey: 'held', text: 'Inspect' })
  try {
    await started
    await within(sent)
    await within(s.controls.readThread()); await within(s.controls.readSettings())
    await within(s.controls.updateSettings({ expectedRevision: s.journal.state.seq, caps: { usdMicros: 99999, rounds: 5 } }))
    await within(s.controls.updateSettings({ expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key: null } }))
    assert.equal(deleted, true)
  } finally { release({ status: 'completed' }); await sent; await s.controls.idle() }
})

for (const kind of ['policy', 'caps'] as const) test(`70 ${kind} widenings keep one pending card; decline cycles free slots and replay tombstones`, async () => {
  const s = await rig()
  const update = () => s.controls.updateSettings({ expectedRevision: s.journal.state.seq, ...(kind === 'policy' ?
    { policy: { ...policy, revision: 2, mode: 'manage' } } : { caps: { ...contract.caps, rounds: 6 } }) })
  await update()
  for (let i = 1; i < 70; i++) await assert.rejects(update(), code('lead-change-pending'))
  assert.equal(s.journal.state.cards.length, 1)
  let last: any
  for (let i = 0; i < 70; i++) {
    if (i) await update()
    const card = s.journal.state.cards[0]!
    last = { version: 1, cardId: card.id, cardType: card.type, expectedRevision: card.revision, contractDigest: null, choice: 'decline' }
    await s.controls.decide(last)
    await assert.rejects(s.controls.decide(last), code('lead-card-decided'))
  }
  assert.equal(s.journal.state.cards.length, 0)
  const reopened = await createLeadJournal(s.storage)
  assert.deepEqual(reopened.state, s.journal.state)
  await assert.rejects(reopened.decideCard(last), code('lead-card-decided'))
  await reopened.offerCard(plan)
  assert.equal(reopened.state.cards[0]?.type, 'plan')
})

test('an unbuildable projection emits a typed error state and reads return the same code', async () => {
  const s = await rig()
  const big = 'x'.repeat(16000)
  const large = (id: string) => { const c = parseLeadAcceptanceContract({ ...contract, goal: big,
    steps: Array.from({ length: 6 }, (_, i) => ({ ...contract.steps[0], id: `s${i}`, title: 'Large plan', variables: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`v${k}`, big])) })) })
    return { ...plan, id, contract: c } }
  await s.journal.offerCard(large('one')); await s.controls.idle()
  await s.journal.offerCard(large('two'))
  await assert.rejects(s.controls.readThread(), code('lead-projection-failed'))
  await s.controls.idle()
  assert.equal((s.notifications.at(-1) as any).params.error, 'lead-projection-failed')
})

test('send before key configuration refuses without appending any text', async () => {
  const s = await rig(), seq = s.journal.state.seq
  await assert.rejects(s.controls.send({ idempotencyKey: 'prekey', text: 'Inspect this private request' }), code('lead-key-missing'))
  assert.equal(s.journal.state.seq, seq); assert.equal(JSON.stringify(s.records).includes('Inspect this private request'), false)
})
test('key-shaped text is refused independently of the configured key', async () => {
  const s = await rig({ configured: true }), seq = s.journal.state.seq
  await assert.rejects(s.controls.send({ idempotencyKey: 'secret', text: 'Use sk-ant-test-not-real-0000' }), code('lead-secret-refused')) // hd-secrets-ok: synthetic provider credential
  assert.equal(s.journal.state.seq, seq)
})
for (const location of ['message', 'card'] as const) test(`new credential in retained ${location} is refused before storage`, async () => {
  let stored = false
  const s = await rig({ service: { setKey: async () => { stored = true } } })
  if (location === 'message') await s.journal.appendMessage('legacy', key)
  else await s.journal.offerCard({ ...plan, contract: { ...contract, goal: key } })
  await assert.rejects(s.controls.updateSettings({ expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key } }), code('lead-secret-in-thread'))
  assert.equal(stored, false)
})

test('4097th receipt evicts the oldest, preserves recent retries and replays the window', async () => {
  const s = await rig()
  let recent: any
  for (let i = 0; i < 4097; i++) recent = await s.journal.appendMessage(`k${i}`, 'Inspect')
  assert.equal(s.journal.state.sends.length, 4096)
  assert.equal(s.journal.state.sends[0]?.key, 'k1')
  const seq = s.journal.state.seq
  assert.deepEqual(await s.journal.appendMessage('k4096', 'Retry'), recent)
  assert.equal(s.journal.state.seq, seq)
  const reopened = await createLeadJournal(s.storage)
  assert.deepEqual(reopened.state.sends, s.journal.state.sends)
  assert.deepEqual(await reopened.appendMessage('k4096', 'Retry'), recent)
  const fresh = await reopened.appendMessage('k0', 'A new send after eviction')
  assert.ok(fresh.revision > seq); assert.equal(reopened.state.sends.length, 4096)
})

for (const category of ['policy', 'caps', 'credential'] as const) test(`stale settings revision refuses ${category} without any effect`, async () => {
  const s = await rig()
  const update = { policy: { ...policy, revision: 2, mode: 'plan' }, caps: { usdMicros: 5, rounds: 1 }, credential: { provider: 'anthropic', key } }
  const before = s.journal.state
  await assert.rejects(s.controls.updateSettings({ expectedRevision: before.seq - 1, [category]: update[category] }), code('lead-revision-stale'))
  assert.deepEqual(s.journal.state, before); assert.equal((await s.service.status()).configured, false)
})
test('control revision fence rejects before journal policy or cap writers', async () => {
  const s = await rig()
  s.journal.changePolicy = async () => { assert.fail('stale update reached journal') }
  s.journal.changeBudgetCaps = async () => { assert.fail('stale update reached journal') }
  for (const update of [{ policy: { ...policy, revision: 2, mode: 'plan' } }, { caps: { usdMicros: 5, rounds: 1 } }])
    await assert.rejects(s.controls.updateSettings({ expectedRevision: 0, ...update }), code('lead-revision-stale'))
})
test('settings updates require authority changes or an exclusive credential change', async () => {
  const s = await rig(), before = s.journal.state
  for (const update of [{}, { credential: { provider: 'anthropic', key }, caps: { usdMicros: 5, rounds: 1 } },
    { credential: { provider: 'anthropic', key }, policy: { ...policy, revision: 2, mode: 'plan' } }])
    await assert.rejects(s.controls.updateSettings({ expectedRevision: before.seq, ...update }), code('lead-settings-combination'))
  assert.deepEqual(s.journal.state, before)
})
test('raw credential writer failures are normalized without echoing input', async () => {
  const s = await rig({ service: { setKey: async () => { throw new Error(`failed ${key}`) } } })
  await assert.rejects(s.controls.updateSettings({ expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key } }), (error: any) =>
    error.wireCode === 'lead-operation-refused' && !String(error).includes(key))
})
test('burst notifications remain strictly increasing', async () => {
  const s = await rig(); await s.controls.readThread()
  await Promise.all(Array.from({ length: 6 }, (_, i) => s.journal.setPolicy({ ...policy, revision: i + 2 })))
  await s.controls.idle()
  const revisions = s.notifications.map((n: any) => n.params.revision)
  assert.ok(revisions.length > 0)
  assert.ok(revisions.every((r, i) => !i || r > revisions[i - 1]!))
})
test('projection protection rejects retained secrets; unavailable broker has its own refusal', async () => {
  const s = await rig(); await s.journal.appendMessage('legacy', key)
  await assert.rejects(s.controls.readThread(), code('lead-secret-refused'))
  const b = await rig({ service: { assertPublic: async () => { throw Object.assign(new Error('broker failed'), { wireCode: 'lead-protection-unavailable' }) } } })
  await assert.rejects(b.controls.readThread(), code('lead-protection-unavailable'))
})
test('non-plan digest fence refuses before the independent journal fence', async () => {
  const s = await rig(); await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000000)
  const card = { version: 1 as const, id: 'person', revision: 1, type: 'waiting' as const, kind: 'person' as const, runId: 'run', personCardId: '7', summary: 'Ready', assertions: [], contractDigest: 'b'.repeat(64) }
  await s.journal.offerCard(card)
  const click = { version: 1 as const, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: card.contractDigest, choice: 'accept' as const }
  s.journal.decideCard = async () => { assert.fail('mismatched digest reached journal') }
  await assert.rejects(s.controls.decide(click), code('lead-card-stale'))
})
test('reducer pre-validation precedes every human side effect', async () => {
  const s = await rig(); await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000000)
  const card = { version: 1 as const, id: 'person', revision: 1, type: 'waiting' as const, kind: 'person' as const, runId: 'run', personCardId: '7', summary: 'Ready', assertions: [], contractDigest: 'b'.repeat(64) }
  await s.journal.offerCard(card)
  const click = { version: 1 as const, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: card.contractDigest, choice: 'accept' as const }
  let answered = false
  await assert.rejects(s.journal.decideCard(click, null, undefined, async () => { answered = true }))
  assert.equal(answered, false)
})

test('server projects each wayOut, typed wait reason and exact 24-hour consent expiry', async () => {
  const s = await rig()
  assert.equal((await s.controls.readThread()).wayOut, null)
  await s.journal.offerCard(plan)
  assert.equal((await s.controls.readThread()).wayOut, 'decide-plan')
  await s.controls.decide(planClick); await s.controls.idle()
  assert.equal((await s.controls.readThread()).wayOut, null)
  assert.equal(s.journal.state.consent?.expiresAt, 100 + 86400000)
  assert.equal((await s.controls.readThread()).planConsentExpiresAt, 100 + 86400000)
  assert.equal((s.sends[0] as any).maxTokens, 4096)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  const wait = await s.controls.readThread()
  assert.equal(wait.wayOut, 'resume'); assert.equal(wait.waitReason, 'lead-request-failed')
  await s.journal.offerCard({ version: 1, id: 'person', revision: 1, type: 'waiting', kind: 'person', runId: 'run', personCardId: '7', summary: 'Ready', assertions: [], contractDigest: contract.digest })
  assert.equal((await s.controls.readThread()).wayOut, null)
  // Result buttons are the exit, too.
  const { leadBudgetProjection } = await import('@harnessdesk/lead')
  const r = await rig(); await r.journal.offerCard(plan); await r.journal.decideCard(planClick, 1000000)
  await r.journal.offerCard({ version: 1, id: 'result', revision: 1, type: 'result', outcome: 'reviewed', summary: 'Ready', assertions: [], contractDigest: contract.digest, budget: leadBudgetProjection(r.journal.state.budget!, 100) })
  await r.journal.setManagementPhase('waiting-for-user', 'lead-result-awaiting-person')
  assert.equal((await r.controls.readThread()).wayOut, null)
})
test('consent expiry never advertises a resume that cannot renew it', async () => {
  const s = await rig({ controls: { now: () => 1000001 } }); await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000000)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  assert.equal((await s.controls.readThread()).wayOut, null)
})
for (const phase of ['accepted', 'declined', 'stopped'] as const) test(`send into ${phase} refuses before append`, async () => {
  const s = await rig({ configured: true })
  if (phase === 'stopped') await s.journal.stop()
  else if (phase === 'declined') { await s.journal.offerCard(plan); await s.journal.decideCard({ ...planClick, choice: 'decline' }) }
  else { await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000000)
    const { leadBudgetProjection } = await import('@harnessdesk/lead')
    await s.journal.offerCard({ version: 1, id: 'r', revision: 1, type: 'result', contractDigest: contract.digest, outcome: 'reviewed', summary: 'Ready', assertions: [], budget: leadBudgetProjection(s.journal.state.budget!, 100) })
    await s.journal.decideCard({ version: 1, cardId: 'r', cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' }) }
  const before = s.journal.state
  await assert.rejects(s.controls.send({ idempotencyKey: 'closed', text: 'Inspect' }), code('lead-thread-closed'))
  assert.deepEqual(s.journal.state, before)
})
test('a stopped budget refuses send with its own code', async () => {
  const s = await rig({ configured: true })
  await s.journal.updateBudget({ version: 1, type: 'stop', now: 100, reason: 'budget' })
  await assert.rejects(s.controls.send({ idempotencyKey: 'budget', text: 'Inspect' }), code('lead-budget-stopped'))
})
test('restart between admission and reply projects resume for the unanswered user message', async () => {
  const s = await rig(); await s.journal.appendMessage('crash', 'Inspect')
  const reopened = await createLeadJournal(s.storage)
  const { LeadControls } = await controlsModule()
  const controls = new LeadControls({ journal: reopened, service: s.service, project, model: 'fixture-model', now: () => 100, nextId: () => 'card', push() {}, decidePerson: async () => {}, decideResult: async () => {} })
  assert.equal((await controls.readThread()).wayOut, 'resume')
  await controls.resume({ expectedRevision: reopened.state.seq }); await controls.idle()
  assert.equal(reopened.state.messages.at(-1)?.role, 'assistant')
  controls.close()
})


const gateRig = async (multiple = false) => {
  const { answerLeadResult, answerLeadPersonGate } = await import('../src/lead/person-decision.js')
  const { parseFlowPolicy } = await import('../src/flow-policy.js')
  const { flowRevision } = await import('../src/flow-execution.js')
  const { leadReviewedResultSource, LEAD_REVIEWED_RESULT, evaluateLeadAcceptance, leadBudgetProjection } = await import('@harnessdesk/lead')
  const document = parseFlowPolicy(leadReviewedResultSource).document!, revision = flowRevision(document)
  const c = parseLeadAcceptanceContract({ ...contract, steps: (multiple ? ['work', 'work2'] : ['work']).map(id => ({ ...contract.steps[0]!, id, sourceRevision: LEAD_REVIEWED_RESULT.revision })) })
  const s = await rig(); await s.journal.offerCard({ ...plan, contract: c }); await s.journal.decideCard(planClick, 1000000)
  const runs = (multiple ? [1, 2] : [1]).map(i => ({ runId: `run-${i}`, teamId: `team-${i}`, correlationId: `start-${i}` }))
  let owned = runs, executionState = 'running', stepFlow = LEAD_REVIEWED_RESULT.id as string, stepRevision = LEAD_REVIEWED_RESULT.revision as string, storedSource = leadReviewedResultSource as string, failSecond = false, answers = 0
  const state = () => ({ ...s.journal.state, runs: owned, steps: c.steps.map((step, i) => ({ id: step.id, state: 'started' as const, attemptId: `start-${i + 1}` })),
    contract: { ...c, steps: c.steps.map(step => ({ ...step, flow: stepFlow, sourceRevision: stepRevision })) } })
  const evidenceFor = (runId: string) => ({ project, runId, contractDigest: c.digest, revision: 'head-1', observedAt: 100, complete: true, spendComplete: true, findingsComplete: true, findings: [],
    reviews: [{ assertionId: 'review', id: 'review-1', revision: 'head-1', observedAt: 100, verdict: 'approve' as const, complete: true }], diffs: [],
    checks: [{ assertionId: 'unit', id: 'check-1', revision: 'head-1', observedAt: 100, exit: 0, timedOut: false, dirty: false, counted: true }] })
  const intents: Record<string, { id: number; state: string; outcome: string | null }> = Object.fromEntries(runs.map((run, i) => [run.teamId, { id: 7 + i, state: 'open', outcome: null }]))
  const per = runs.map(run => evaluateLeadAcceptance(c, evidenceFor(run.runId), { now: 100, freshnessMs: 60000, revision: state().seq }).assertions)
  const assertions = c.assertions.map(assertion => { const results = per.map(p => p.find(item => item.assertionId === assertion.id)!); return { ...results[0]!, evidence: results.flatMap(item => item.evidence) } })
  const options: any = { journal: { get state() { return state() } }, project, now: () => 100,
    flows: { executionOf: (id: string) => ({ id, goal: id === 'run-1' ? 'team-1' : 'team-2', state: executionState, revision, document, rounds: [{ cards: [id === 'run-1' ? 7 : 8] }] }),
      storedRun: () => ({ source: storedSource, compiled: { document } }), personCard: (_team: string, intent: any) => ({ live: intent.state === 'open', outcomes: ['accepted', 'declined'] }) },
    team: { stateFor: (team: string) => ({ root: project.path, intents: [intents[team]] }),
      async intentAction(team: string, _id: number, _action: string, _a: unknown, outcome: string, ...rest: any[]) {
        rest.at(-1)?.(); if (team === 'team-2' && failSecond) throw new Error('board save failed')
        intents[team]!.state = 'done'; intents[team]!.outcome = outcome; answers++
      }, async flush() {} }, readEvidence: async (runId: string) => evidenceFor(runId) }
  const card = { version: 1 as const, id: 'result', revision: 1, type: 'result' as const, outcome: 'reviewed' as const, summary: 'Ready', contractDigest: c.digest, budget: leadBudgetProjection(state().budget!, 100), assertions }
  const click = { version: 1 as const, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: c.digest, choice: 'accept' as const }
  return { ...s, c, card, click, intents, options, answerLeadResult, answerLeadPersonGate, answers: () => answers,
    setOwned: (value: typeof runs) => { owned = value }, setExecution: (value: string) => { executionState = value },
    setBinding: (flow: string, rev: string, source: string) => { stepFlow = flow; stepRevision = rev; storedSource = source },
    failSecond: (value: boolean) => { failSecond = value }, currentContract: () => state().contract }
}
test('multi-run result retry finishes a matching partial save with the same Lead card revision', async () => {
  const g = await gateRig(true)
  await g.journal.offerCard(g.card)
  const apply = () => g.journal.decideCard(g.click, null, undefined, () => g.answerLeadResult(g.options, g.card, g.click, g.c))
  g.failSecond(true)
  await assert.rejects(apply(), /board save failed/)
  assert.deepEqual(Object.values(g.intents).map(i => i.state), ['done', 'open'])
  assert.equal(g.journal.state.decidedCards.includes('result:1'), false)
  g.failSecond(false); await apply()
  assert.deepEqual(Object.values(g.intents).map(i => i.state), ['done', 'done'])
  assert.equal(g.answers(), 2); assert.ok(g.journal.state.decidedCards.includes('result:1'))
})
test('a partial gate with the opposite outcome refuses retry', async () => {
  const g = await gateRig(true)
  g.intents['team-1']!.state = 'done'; g.intents['team-1']!.outcome = 'declined'
  await assert.rejects(g.answerLeadResult(g.options, g.card, g.click, g.c), code('lead-gate-changed'))
  assert.equal(g.answers(), 0)
})
for (const guard of ['execution', 'ownership', 'step-flow', 'step-revision', 'recipe-source'] as const) test(`person gate refuses changed ${guard} before answering`, async () => {
  const g = await gateRig()
  const { leadReviewedResultSource, LEAD_REVIEWED_RESULT } = await import('@harnessdesk/lead')
  if (guard === 'execution') g.setExecution('stopped')
  if (guard === 'ownership') g.setOwned([])
  if (guard === 'step-flow') g.setBinding('other-flow', LEAD_REVIEWED_RESULT.revision, leadReviewedResultSource)
  if (guard === 'step-revision') g.setBinding(LEAD_REVIEWED_RESULT.id, 'other-revision', leadReviewedResultSource)
  if (guard === 'recipe-source') g.setBinding(LEAD_REVIEWED_RESULT.id, LEAD_REVIEWED_RESULT.revision, 'other-source')
  const card = { version: 1 as const, id: 'person', revision: 1, type: 'waiting' as const, kind: 'person' as const, runId: 'run-1', personCardId: '7', summary: 'Ready', assertions: g.card.assertions, contractDigest: g.c.digest }
  const click = { ...g.click, cardId: card.id, cardType: card.type }
  await assert.rejects(g.answerLeadPersonGate(g.options, card, click, g.currentContract()), code('lead-gate-changed'))
  assert.equal(g.answers(), 0)
})


test('a failed changed notification is visible as a typed error and through reads', async () => {
  let fail = true
  const delivered: any[] = []
  const s = await rig({ controls: { push: (notification: any) => { if (fail) { fail = false; throw new Error('transport failed') }; delivered.push(notification) } } })
  await s.journal.settingsChanged(); await s.controls.idle()
  assert.equal(delivered.at(-1)?.params.error, 'lead-projection-failed')
  await assert.rejects(s.controls.readThread(), code('lead-projection-failed'))
})


test('server wayOut is null without a wait', async () => {
  const s = await rig(); assert.equal((await s.controls.readThread()).wayOut, null)
})
test('server wayOut is decide-plan while approval is pending', async () => {
  const s = await rig(); await s.journal.offerCard(plan)
  assert.equal((await s.controls.readThread()).wayOut, 'decide-plan')
})
test('server wayOut is resume for a person wait without an actionable card', async () => {
  const s = await rig(); await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  const projection = await s.controls.readThread()
  assert.equal(projection.wayOut, 'resume'); assert.equal(projection.waitReason, 'lead-request-failed')
})

test('an unanswered message with a held local request does not advertise crash recovery', async () => {
  let release!: () => void, began!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const s = await rig({ configured: true, service: { async send() { began(); await held; return { status: 'completed' } } } })
  try {
    await s.controls.send({ idempotencyKey: 'inflight', text: 'Inspect' }); await started
    await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'held-request', inputTokens: 1, maxOutputTokens: 1,
      inputUsdMicrosPerMillion: 1000000, outputUsdMicrosPerMillion: 1000000, cacheReadUsdMicrosPerMillion: 1000000, cacheWriteUsdMicrosPerMillion: 1000000 })
    assert.equal((await s.controls.readThread()).wayOut, null)
    assert.equal((await s.controls.readThread()).requestInFlight, true)
  } finally { release(); await s.controls.idle(); s.controls.close() }
})

for (const reopen of [false, true]) for (const action of ['send', 'resume'] as const)
  test(`a stale reservation permits ${action} ${reopen ? 'after reopen' : 'after a failed child'}`, async () => {
    const s = await rig({ configured: true })
    s.service.send = async () => {
      await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'dead-child', inputTokens: 1, maxOutputTokens: 1,
        inputUsdMicrosPerMillion: 1000000, outputUsdMicrosPerMillion: 1000000, cacheReadUsdMicrosPerMillion: 1000000, cacheWriteUsdMicrosPerMillion: 1000000 })
      throw new Error('lead-send-deadline')
    }
    await s.controls.send({ idempotencyKey: 'interrupted', text: 'Inspect' }); await s.controls.idle()
    if (reopen) s.controls.close()
    const journal = reopen ? await createLeadJournal(s.storage) : s.journal
    const requests: unknown[] = []
    const { LeadControls } = await controlsModule()
    s.service.send = async (request: unknown) => {
      requests.push(request)
      await journal.recoverUnsettledRequests()
      return { status: 'completed', text: 'Recovered' }
    }
    const controls = reopen ? new LeadControls({ journal, service: s.service, project, model: 'fixture-model', now: () => 100, nextId: () => 'recovered', push() {}, decidePerson: async () => {}, decideResult: async () => {} }) : s.controls
    try {
      assert.equal(journal.state.budget!.requests.filter(request => !request.uncertain).length, 1)
      const projection = await controls.readThread()
      assert.equal(projection.requestInFlight, false)
      assert.equal(projection.wayOut, 'resume')
      assert.equal(projection.waitReason, 'lead-request-failed')
      await (action === 'send' ? controls.send({ idempotencyKey: 'recover', text: 'Try again' }) : controls.resume({ expectedRevision: projection.revision }))
      await controls.idle()
      assert.equal(requests.length, 1)
      assert.equal(journal.state.budget!.requests[0]!.uncertain, true)
    } finally { controls.close() }
  })

for (const check of ['wake', 'projection'] as const) test(`approve during a held request preserves the ${check}`, async () => {
  let releaseFirst!: () => void, releaseSecond!: () => void, began!: () => void, second!: () => void
  const firstStarted = new Promise<void>(resolve => { began = resolve }), secondStarted = new Promise<void>(resolve => { second = resolve })
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve }), secondHeld = new Promise<void>(resolve => { releaseSecond = resolve })
  const requests: any[] = [], published: WireNotification[] = [], duringSecond: WireNotification[] = []
  let secondRunning = false
  const s = await rig({ configured: true, service: { async send(request: any) {
    requests.push(request)
    if (requests.length === 1) { began(); await firstHeld } else { secondRunning = true; second(); await secondHeld; secondRunning = false }
    return { status: 'completed', text: 'Reply' }
  } }, controls: { push(notification: WireNotification) { published.push(notification); if (secondRunning) duringSecond.push(notification) } } })
  try {
    await s.journal.offerCard(plan)
    await s.controls.send({ idempotencyKey: 'held', text: 'Inspect' }); await firstStarted
    await s.controls.decide(planClick)
    releaseFirst()
    // idle detects a lost wake without hanging on a second request that never starts.
    if (check === 'wake') { releaseSecond(); await s.controls.idle() }
    else {
      await within(secondStarted, 1000)
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.ok(duringSecond.length > 0)
      assert.ok(duringSecond.every((notification: any) => notification.params.requestInFlight === true))
      const firstReceipt = s.journal.state.messages.find(message => message.role === 'user')!.revision
      assert.ok(published.filter((notification: any) => notification.params.revision >= firstReceipt)
        .every((notification: any) => notification.params.requestInFlight === true), 'chained requests never publish an idle gap')
      const latest = (published.at(-1) as any).params
      assert.equal(latest.requestInFlight, true, 'latest published projection while the second request runs')
      assert.ok(latest.revision > s.journal.state.messages.find(message => message.role === 'assistant')!.revision)
      assert.equal((await s.controls.readThread()).requestInFlight, true)
    }
  } finally { releaseFirst(); releaseSecond(); await s.controls.idle(); s.controls.close() }
  assert.equal(requests.length, 2)
  assert.equal(s.journal.state.messages.map(message => message.role[0]).join(''), 'uaa')
  assert.ok(requests.every(request => request.messages.at(-1).role === 'user'))
})

for (const action of ['approve', 'resume'] as const) test(`${action} commits and continues despite a failed response projection`, async () => {
  let broken = false
  const s = await rig({ configured: true, service: { async assertPublic() { if (broken) throw Object.assign(new Error('locked'), { wireCode: 'lead-protection-unavailable' }) } } })
  await s.journal.offerCard(plan)
  if (action === 'resume') {
    await s.controls.decide(planClick); await s.controls.idle()
    await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  }
  const before = s.sends.length
  broken = true
  await assert.rejects(action === 'approve' ? s.controls.decide(planClick) : s.controls.resume({ expectedRevision: s.journal.state.seq }), code('lead-protection-unavailable'))
  await s.controls.idle()
  assert.equal(s.sends.length, before + 1)
  broken = false; s.controls.close()
})

test('an in-flight request refuses a new send without keeping its key and every request ends in a user turn', async () => {
  let release!: () => void, began!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const requests: any[] = []
  const s = await rig({ configured: true, service: { async send(request: any) { requests.push(request); began(); await held; return { status: 'completed', text: 'Reply' } } } })
  try {
    await s.controls.send({ idempotencyKey: 'first', text: 'First' }); await started
    assert.equal((await s.controls.readThread()).requestInFlight, true)
    assert.equal((await s.controls.readThread()).wayOut, null)
    await assert.rejects(s.controls.send({ idempotencyKey: 'retry', text: 'Second' }), code('lead-request-in-flight'))
    await assert.rejects(s.controls.resume({ expectedRevision: s.journal.state.seq }), code('lead-request-in-flight'))
    assert.equal(s.journal.state.sends.some(send => send.key === 'retry'), false)
  } finally { release(); await s.controls.idle() }
  assert.equal((await s.controls.readThread()).requestInFlight, false)
  assert.equal((s.notifications.at(-1) as any).params.requestInFlight, false)
  await s.controls.send({ idempotencyKey: 'retry', text: 'Second' }); await s.controls.idle()
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.messages.at(-1).role === 'user'))
  assert.deepEqual(s.journal.state.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant'])
  s.controls.close()
})

for (const kind of ['policy', 'caps'] as const) test(`a ${kind} settings card must fit before journal admission`, async () => {
  const { leadWindowThread } = await import('../src/lead/projection.js')
  const s = await rig({ configured: true })
  const card = (i: number, length: number) => ({ ...plan, id: `fill-${i}`, contract: { ...contract, goal: 'g'.repeat(length) } })
  const admit = (candidate: any) => {
    const state = s.journal.state
    leadWindowThread({ ...state, cards: [...state.cards, candidate] }, project, { version: 1, model: 'fixture-model', policy: state.policy!, caps: state.budget!.caps, key: { configured: true, protection: 'encrypted' } })
  }
  let i = 0
  while (i < 64) { try { await s.journal.offerCard(card(i, 16000), admit); i++ } catch { break } }
  let lo = 1, hi = 16000
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; try { admit(card(i, mid)); lo = mid } catch { hi = mid - 1 } }
  await s.journal.offerCard(card(i, lo), admit)
  await s.controls.idle(); await s.controls.readThread()
  const before = s.journal.state
  await assert.rejects(s.controls.updateSettings({ expectedRevision: before.seq, ...(kind === 'policy' ?
    { policy: { ...policy, revision: 2, mode: 'manage' } } : { caps: { ...contract.caps, rounds: 6 } }) }), code('lead-card-too-large'))
  assert.deepEqual(s.journal.state, before)
  await s.controls.readThread(); s.controls.close()
})

test('combined policy and caps cards are both admitted or neither is made', async () => {
  const s = await rig({ configured: true })
  const proposed = { ...policy, revision: 2, mode: 'manage' as const }
  const update = { policy: proposed, caps: { ...contract.caps, rounds: 6 } }
  const { admitLeadCard } = await import('../src/lead/projection.js')
  const permission = { version: 1 as const, id: 'card-1', revision: 1, type: 'permission-change' as const, contractDigest: null, previous: policy, proposed }
  const fill = (i: number, length: number) => ({ ...plan, id: `fill-${i}`, contract: { ...contract, goal: 'g'.repeat(length) } })
  // Fill to the exact boundary at which the policy card fits but adding caps cannot.
  const admitWithPolicy = (card: LeadCard) => admitLeadCard({ ...s.journal.state, cards: [...s.journal.state.cards, card] }, permission, project, 'fixture-model')
  let i = 0
  while (i < 64) { try { await s.journal.offerCard(fill(i, 16000), admitWithPolicy); i++ } catch { break } }
  let lo = 1, hi = 16000
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; try { admitWithPolicy(fill(i, mid)); lo = mid } catch { hi = mid - 1 } }
  await s.journal.offerCard(fill(i, lo), admitWithPolicy)
  const before = s.journal.state
  admitLeadCard(before, permission, project, 'fixture-model')
  try {
    await assert.rejects(s.controls.updateSettings({ expectedRevision: before.seq, ...update }), code('lead-card-too-large'))
    assert.deepEqual(s.journal.state, before)
  } finally { s.controls.close() }
  // With room for both cards, the same combination creates both reviewable proposals.
  const fresh = await rig({ configured: true })
  try {
    await fresh.controls.updateSettings({ expectedRevision: fresh.journal.state.seq, ...update })
    assert.deepEqual(fresh.journal.state.cards.map(card => card.type), ['permission-change', 'budget-change'])
    assert.deepEqual(fresh.journal.state.policy, policy)
    assert.deepEqual(fresh.journal.state.budget!.caps, contract.caps)
  } finally { fresh.controls.close() }
})

for (const stop of ['decline', 'budget'] as const) test(`a ${stop} before detached start prevents paid work and replies`, async () => {
  const s = await rig({ configured: true }); await s.journal.offerCard(plan)
  await Promise.all([s.controls.send({ idempotencyKey: 'race', text: 'Inspect' }), stop === 'decline' ?
    s.controls.decide({ ...planClick, choice: 'decline' }) : s.journal.updateBudget({ version: 1, type: 'stop', now: 100, reason: 'budget' })])
  await s.controls.idle()
  assert.equal(s.sends.length, 0)
  assert.equal(s.journal.state.messages.some(message => message.role === 'assistant'), false)
  s.controls.close()
})

for (const kind of ['result', 'person', 'expired'] as const) test(`resume agrees with null wayOut for ${kind}`, async () => {
  const s = await rig({ configured: true }); await s.journal.offerCard(plan)
  await s.journal.decideCard(planClick, kind === 'expired' ? 99 : 1000)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  if (kind === 'result') await s.journal.offerCard({ version: 1, id: 'result', revision: 1, type: 'result', contractDigest: contract.digest, outcome: 'reviewed', summary: 'Reviewed', assertions: [],
    budget: (await import('@harnessdesk/lead')).leadBudgetProjection(s.journal.state.budget!, 100) })
  if (kind === 'person') await s.journal.offerCard({ version: 1, id: 'person', revision: 1, type: 'waiting', kind: 'person', contractDigest: contract.digest, runId: 'run', personCardId: 'person', summary: 'Decide', assertions: [] })
  assert.equal((await s.controls.readThread()).wayOut, null)
  const before = s.journal.state
  await assert.rejects(s.controls.resume({ expectedRevision: before.seq }), code('lead-no-person-wait'))
  await s.controls.idle(); assert.equal(s.sends.length, 0); assert.deepEqual(s.journal.state, before); s.controls.close()
})

test('send maps a status broker failure to protection-unavailable without retaining a receipt', async () => {
  const s = await rig({ service: { async status() { throw new Error(key) } } })
  await assert.rejects(s.controls.send({ idempotencyKey: 'locked', text: 'Inspect' }), code('lead-protection-unavailable'))
  assert.equal(s.journal.state.sends.length, 0); s.controls.close()
})

for (const read of ['readThread', 'readSettings'] as const) test(`${read} bypasses a queued credential write`, async () => {
  let release!: () => void, began!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const s = await rig({ service: { async setKey() { began(); await held } } })
  const write = s.controls.updateSettings({ expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key } })
  try { await started; await within(s.controls[read]()) } finally { release(); await write; await s.controls.idle(); s.controls.close() }
})

for (const action of ['approve', 'resume'] as const) test(`${action} returns before a held continuation finishes`, async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const s = await rig({ configured: true, service: { async send() { await held; return { status: 'completed' } } } })
  await s.journal.offerCard(plan)
  if (action === 'resume') { await s.journal.decideCard(planClick, 1000); await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed') }
  const operation = action === 'approve' ? s.controls.decide(planClick) : s.controls.resume({ expectedRevision: s.journal.state.seq })
  try { await within(operation) } finally { release(); await operation; await s.controls.idle(); s.controls.close() }
})

test('a failed detached journal chain is caught and published as a typed error', async () => {
  const s = await rig({ configured: true, service: { async send() { throw new Error('synthetic failure') } } })
  s.journal.setManagementPhase = async () => { throw new Error('synthetic append failure') }
  await s.controls.send({ idempotencyKey: 'failed-chain', text: 'Inspect' }); await s.controls.idle()
  assert.equal((s.notifications.at(-1) as any).params.error, 'lead-projection-failed')
  await assert.rejects(s.controls.readThread(), code('lead-projection-failed')); s.controls.close()
})

test('the first read independently reports an unbuildable projection', async () => {
  const s = await rig(); s.controls.close()
  const large = (id: string) => ({ ...plan, id, contract: { ...contract, steps: Array.from({ length: 6 }, (_, i) => ({ ...contract.steps[0]!, id: `s${i}`,
    variables: Object.fromEntries(Array.from({ length: 8 }, (_, j) => [`v${j}`, 'x'.repeat(16000)])) })) } })
  await s.journal.offerCard(large('one')); await s.journal.offerCard(large('two'))
  const { LeadControls } = await controlsModule()
  const fresh = new LeadControls({ journal: s.journal, service: s.service, project, model: 'fixture-model', now: () => 100, nextId: () => 'card', push() {}, decidePerson: async () => {}, decideResult: async () => {} })
  await assert.rejects(fresh.readThread(), code('lead-projection-failed')); fresh.close()
})

test('continuation latch stress leaves every admitted message answered', async () => {
  for (let iter = 0; iter < 400; iter++) {
    const requests: any[] = []
    const s = await rig({ configured: true, service: { async send(request: any) { requests.push(request); await Promise.resolve(); return { status: 'completed', text: 'Reply' } } } })
    const sends = []
    for (let i = 0; i < 1 + iter % 5; i++) {
      sends.push(s.controls.send({ idempotencyKey: `k${i}`, text: `Message ${i}` }).catch((error: any) => { assert.equal(error.wireCode, 'lead-request-in-flight') }))
      for (let j = 0; j < (iter + i) % 9; j++) await Promise.resolve()
      if (iter % 3 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
    await Promise.all(sends); await s.controls.idle()
    assert.equal(s.journal.state.messages.at(-1)?.role, 'assistant')
    assert.equal(requests.length, s.journal.state.sends.length)
    assert.ok(requests.every(request => request.messages.at(-1).role === 'user'))
    s.controls.close()
  }
})

test('resuming after a reply also ends the paid request in a user turn', async () => {
  const s = await rig({ configured: true })
  await s.controls.send({ idempotencyKey: 'first', text: 'Inspect' }); await s.controls.idle()
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  await s.controls.resume({ expectedRevision: s.journal.state.seq }); await s.controls.idle()
  assert.equal(s.sends.length, 2)
  assert.ok(s.sends.every((request: any) => request.messages.at(-1).role === 'user'))
  s.controls.close()
})

for (const action of ['send', 'approve', 'resume'] as const) test(`${action} publishes in-flight at the committed revision before its held request`, async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const s = await rig({ configured: true, service: { async send() { await held; return { status: 'completed', text: 'Reply' } } } })
  if (action !== 'send') await s.journal.offerCard(plan)
  if (action === 'resume') { await s.journal.decideCard(planClick, 1000); await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed') }
  try {
    await (action === 'send' ? s.controls.send({ idempotencyKey: 'held', text: 'Inspect' }) :
      action === 'approve' ? s.controls.decide(planClick) : s.controls.resume({ expectedRevision: s.journal.state.seq }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const revision = s.journal.state.seq
    const notification = s.notifications.findLast((value: any) => value.params.revision === revision) as any
    assert.equal(notification?.params.requestInFlight, true)
    assert.equal((await s.controls.readThread()).requestInFlight, true)
  } finally { release(); await s.controls.idle(); s.controls.close() }
})

test('a repeated request failure still publishes a newer idle revision', async () => {
  const s = await rig({ configured: true, service: { async send() { throw new Error('synthetic unavailable') } } })
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  const receipt = await s.controls.send({ idempotencyKey: 'failed-again', text: 'Try again' })
  await s.controls.idle()
  assert.ok(s.journal.state.seq > receipt.revision)
  assert.equal((s.notifications.at(-1) as any).params.requestInFlight, false)
  s.controls.close()
})

test('a refused stale approval cannot restore a completed request flag', async () => {
  let releaseSend!: () => void, beganSend!: () => void, releaseWrite!: () => void, beganWrite!: () => void
  const sending = new Promise<void>(resolve => { beganSend = resolve }), heldSend = new Promise<void>(resolve => { releaseSend = resolve })
  const writing = new Promise<void>(resolve => { beganWrite = resolve }), heldWrite = new Promise<void>(resolve => { releaseWrite = resolve })
  const s = await rig({ configured: true, service: { async send() { beganSend(); await heldSend; return { status: 'completed', text: 'Reply' } } } })
  await s.journal.offerCard(plan)
  await s.controls.send({ idempotencyKey: 'first', text: 'Inspect' }); await sending
  const append = s.storage.append.bind(s.storage)
  s.storage.append = async record => {
    if (record.type === 'card' && record.card.id === plan.id && record.card.revision === 2) { beganWrite(); await heldWrite }
    await append(record)
  }
  const change = s.journal.offerCard({ ...plan, revision: 2 })
  await writing
  const click = s.controls.decide(planClick)
  const refused = assert.rejects(click, code('lead-card-stale'))
  try {
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseSend()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    releaseWrite(); await change; await refused; await s.controls.idle()
    assert.equal((s.notifications.at(-1) as any).params.requestInFlight, false)
    assert.equal((await s.controls.readThread()).requestInFlight, false)
  } finally { releaseSend(); releaseWrite(); await change; await refused; await s.controls.idle(); s.controls.close() }
})


test('an open paid reservation after restart still offers and accepts resume', async () => {
  const s = await rig({ configured: true })
  await s.journal.appendMessage('crash-reserved', 'Inspect')
  await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'interrupted', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1000000, outputUsdMicrosPerMillion: 1000000, cacheReadUsdMicrosPerMillion: 1000000, cacheWriteUsdMicrosPerMillion: 1000000 })
  s.controls.close()
  const journal = await createLeadJournal(s.storage), { LeadControls } = await controlsModule()
  const controls = new LeadControls({ journal, service: s.service, project, model: 'fixture-model', now: () => 100,
    nextId: () => 'card', push() {}, decidePerson: async () => {}, decideResult: async () => {} })
  try {
    assert.equal(journal.state.phase, 'draft')
    assert.equal(journal.state.budget!.requests.filter(request => !request.uncertain).length, 1)
    const projection = await controls.readThread()
    assert.equal(projection.wayOut, 'resume')
    await controls.resume({ expectedRevision: projection.revision }); await controls.idle()
    assert.equal(s.sends.length, 1)
    assert.equal(journal.state.messages.at(-1)?.role, 'assistant')
  } finally { controls.close() }
})

test('send after a failed request resumes and answers the new message without a separate click', async () => {
  const s = await rig({ configured: true })
  let requests = 0
  s.service.send = async () => {
    requests++
    if (requests === 1) throw new Error('synthetic interruption')
    if (s.journal.state.phase === 'waiting-for-user') return { status: 'refused', text: '' }
    return { status: 'completed', text: 'New message answered' }
  }
  try {
    await s.controls.send({ idempotencyKey: 'first-failed', text: 'Inspect' }); await s.controls.idle()
    assert.equal((await s.controls.readThread()).wayOut, 'resume')
    assert.equal(s.journal.state.managementReason, 'lead-request-failed')
    await s.controls.send({ idempotencyKey: 'continue-failed', text: 'Inspect the new check' }); await s.controls.idle()
    assert.equal(requests, 2)
    assert.deepEqual(s.journal.state.messages.slice(-2).map(message => [message.role, message.text]),
      [['user', 'Inspect the new check'], ['assistant', 'New message answered']])
    assert.equal(s.records.filter(record => record.type === 'resume').length, 1)
  } finally { s.controls.close() }
})

for (const kind of ['result', 'person', 'expired', 'plan'] as const) test(`send preserves the resume guard for ${kind}`, async () => {
  const s = await rig({ configured: true })
  try {
    await s.journal.offerCard(plan)
    if (kind !== 'plan') await s.journal.decideCard(planClick, kind === 'expired' ? 99 : 1000)
    await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
    if (kind === 'result') await s.journal.offerCard({ version: 1, id: 'result', revision: 1, type: 'result', contractDigest: contract.digest, outcome: 'reviewed', summary: 'Reviewed', assertions: [],
      budget: (await import('@harnessdesk/lead')).leadBudgetProjection(s.journal.state.budget!, 100) })
    if (kind === 'person') await s.journal.offerCard({ version: 1, id: 'person', revision: 1, type: 'waiting', kind: 'person', contractDigest: contract.digest, runId: 'run', personCardId: 'person', summary: 'Decide', assertions: [] })
    const phase = s.journal.state.phase
    await s.controls.send({ idempotencyKey: `guard-${kind}`, text: 'Inspect the new check' })
    await s.controls.idle()
    assert.equal(s.records.filter(record => record.type === 'resume').length, 0)
    assert.equal(s.journal.state.phase, phase)
  } finally { s.controls.close() }
})

test('send resumes an open paid reservation after restart', async () => {
  const s = await rig({ configured: true })
  await s.journal.appendMessage('crash-reserved', 'Inspect')
  await s.journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'interrupted', inputTokens: 1, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1000000, outputUsdMicrosPerMillion: 1000000, cacheReadUsdMicrosPerMillion: 1000000, cacheWriteUsdMicrosPerMillion: 1000000 })
  s.controls.close()
  const journal = await createLeadJournal(s.storage), { LeadControls } = await controlsModule()
  const controls = new LeadControls({ journal, service: s.service, project, model: 'fixture-model', now: () => 100,
    nextId: () => 'card', push() {}, decidePerson: async () => {}, decideResult: async () => {} })
  try {
    assert.equal(journal.state.phase, 'draft')
    assert.equal(journal.state.budget!.requests.filter(request => !request.uncertain).length, 1)
    assert.equal((await controls.readThread()).wayOut, 'resume')
    const receipt = await controls.send({ idempotencyKey: 'after-restart', text: 'Continue the check' })
    await controls.idle()
    assert.ok(receipt.messageId)
    assert.equal(s.records.filter(record => record.type === 'resume').length, 1)
    assert.equal(s.sends.length, 1)
    assert.equal(journal.state.phase, 'running')
  } finally { controls.close() }
})

test('a failed first chained request never publishes an idle gap', async () => {
  let releaseFirst!: () => void, releaseSecond!: () => void, began!: () => void, second!: () => void
  const firstStarted = new Promise<void>(resolve => { began = resolve }), secondStarted = new Promise<void>(resolve => { second = resolve })
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve }), secondHeld = new Promise<void>(resolve => { releaseSecond = resolve })
  let requests = 0
  const s = await rig({ configured: true, service: { async send() {
    if (++requests === 1) { began(); await firstHeld; throw new Error('synthetic interruption') }
    second(); await secondHeld; return { status: 'completed', text: 'Reply' }
  } } })
  try {
    await s.journal.offerCard(plan)
    const receipt = await s.controls.send({ idempotencyKey: 'held-failure', text: 'Inspect' }); await firstStarted
    await s.controls.decide(planClick)
    releaseFirst(); await within(secondStarted, 1000)
    await new Promise(resolve => setTimeout(resolve, 0))
    const during = s.notifications.filter((notification: any) => notification.params.revision >= receipt.revision)
    assert.ok(during.length > 0)
    assert.ok(during.every((notification: any) => notification.params.requestInFlight === true), 'failed chained request must not publish an idle gap')
    assert.equal((await s.controls.readThread()).requestInFlight, true)
    releaseSecond(); await s.controls.idle()
    assert.equal((s.notifications.at(-1) as any).params.requestInFlight, false)
    assert.equal((await s.controls.readThread()).requestInFlight, false)
    assert.equal(requests, 2)
  } finally { releaseFirst(); releaseSecond(); await s.controls.idle(); s.controls.close() }
})

test('send records resume despite a journal write between message append and resume', async () => {
  const s = await rig({ configured: true })
  try {
    await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000)
    await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
    const append = s.journal.appendMessage.bind(s.journal)
    s.journal.appendMessage = async (...args) => { const receipt = await append(...args); await s.journal.settingsChanged(); return receipt }
    const receipt = await s.controls.send({ idempotencyKey: 'interleaved', text: 'Continue the check' })
    await s.controls.idle()
    assert.ok(receipt.messageId)
    assert.equal(s.records.filter(record => record.type === 'resume').length, 1)
    assert.equal(s.sends.length, 1)
    assert.equal(s.journal.state.phase, 'running')
    assert.deepEqual(await s.controls.send({ idempotencyKey: 'interleaved', text: 'Continue the check' }), receipt)
    assert.equal(s.sends.length, 1)
  } finally { await s.controls.idle(); s.controls.close() }
})

test('combined policy and caps update refuses before either card when the policy card alone cannot fit', async () => {
  const { admitLeadCard } = await import('../src/lead/projection.js')
  const s = await rig({ configured: true })
  const fill = (i: number, length: number) => ({ ...plan, id: `fill-${i}`, contract: { ...contract, goal: 'g'.repeat(length) } })
  const admit = (card: LeadCard) => admitLeadCard(s.journal.state, card, project, 'fixture-model')
  let i = 0
  while (i < 64) { try { await s.journal.offerCard(fill(i, 16000), admit); i++ } catch { break } }
  let lo = 1, hi = 16000
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; try { admit(fill(i, mid)); lo = mid } catch { hi = mid - 1 } }
  await s.journal.offerCard(fill(i, lo), admit)
  const before = s.journal.state, records = s.records.length
  const proposed = { ...policy, revision: 2, mode: 'manage' as const }
  const permission = { version: 1 as const, id: 'card-1', revision: 1, type: 'permission-change' as const, contractDigest: null, previous: policy, proposed }
  assert.throws(() => admit(permission), code('lead-card-too-large'))
  try {
    // Tightening caps makes no card, so omitting policy admission cannot be masked by a caps admission failure.
    await assert.rejects(s.controls.updateSettings({ expectedRevision: before.seq, policy: proposed, caps: { usdMicros: 50000, rounds: 3 } }), code('lead-card-too-large'))
    assert.deepEqual(s.journal.state, before)
    assert.equal(s.records.length, records)
    assert.equal(s.journal.state.cards.some(card => card.type === 'budget-change'), false)
  } finally { s.controls.close() }
})
