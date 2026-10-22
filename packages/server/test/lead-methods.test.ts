import assert from 'node:assert/strict'
import test from 'node:test'
import { createLeadLoop, createLeadJournal, leadBudgetProjection, leadCheckpoint, parseLeadCheckpoint, type LeadJournalRecord } from '@harnessdesk/lead'
import { parseLeadAcceptanceContract, type LeadCard, type WireNotification } from '@harnessdesk/protocol'
import { dispatch, type HostContext } from '../src/methods/index.js'
import { leadProgress, leadRunTeam } from '../src/lead/projection.js'

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
    leadSettingsUpdate: (p: unknown) => controls.updateSettings(p), leadResume: (p: unknown) => controls.resume(p), leadStop: (p: unknown) => controls.stop(p) } as unknown as HostContext
  const call = (method: string, params: unknown = {}) => dispatch(ctx, method as never, params as never) as Promise<any>
  return { controls, journal, records, storage, notifications, sends, answers, service, call }
}
const code = (reason: string) => (error: any) => error.wireCode === reason
const turnText = (turn: any): string => turn.content.map((block: any) => block.text).join('')
const approvedContractOf = (turn: any): unknown => {
  const line = turnText(turn).split('\n').find(one => one.startsWith('Approved contract: '))
  assert.ok(line, 'the desk message carries the approved contract')
  return JSON.parse(line.slice('Approved contract: '.length))
}

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
test('a goal that stalled with nothing started projects its own wait reason and offers Resume', async () => {
  const s = await rig({ configured: true })
  await s.journal.offerCard(plan); await s.controls.decide(planClick); await s.controls.idle()
  await s.journal.setManagementPhase('waiting-for-user', 'lead-run-not-started')
  const wait = await s.controls.readThread()
  assert.equal(wait.waitReason, 'lead-run-not-started'); assert.equal(wait.wayOut, 'resume')
  // The way on is real: Resume asks the model again, with the contract, and the wait ends.
  await s.controls.resume({ expectedRevision: s.journal.state.seq }); await s.controls.idle()
  assert.equal(s.journal.state.phase, 'running')
  assert.deepEqual(approvedContractOf((s.sends.at(-1) as any).messages.at(-1)), contract)
  s.controls.close()
})
test('consent expiry offers a fresh plan decision instead of Resume', async () => {
  const s = await rig({ controls: { now: () => 1000001 } }); await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000000)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  assert.equal((await s.controls.readThread()).wayOut, 'decide-plan')
})
for (const phase of ['accepted', 'declined', 'stopped'] as const) test(`send into ${phase} begins the next goal once nothing is left running`, async () => {
  const s = await rig({ configured: true })
  if (phase === 'stopped') await s.journal.stop()
  else if (phase === 'declined') { await s.journal.offerCard(plan); await s.journal.decideCard({ ...planClick, choice: 'decline' }) }
  else { await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000000)
    const { leadBudgetProjection } = await import('@harnessdesk/lead')
    await s.journal.offerCard({ version: 1, id: 'r', revision: 1, type: 'result', contractDigest: contract.digest, outcome: 'reviewed', summary: 'Ready', assertions: [], budget: leadBudgetProjection(s.journal.state.budget!, 100) })
    await s.journal.decideCard({ version: 1, cardId: 'r', cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' }) }
  const before = s.journal.state
  if (phase === 'stopped' && before.stopEffectsPending !== null) {
    // Stopping has not finished cleaning up owned work: the next goal waits for it.
    await assert.rejects(s.controls.send({ idempotencyKey: 'closed', text: 'Inspect' }), code('lead-thread-closed'))
    assert.deepEqual(s.journal.state, before)
    return
  }
  await s.controls.send({ idempotencyKey: 'next', text: 'Inspect the next thing' }); await s.controls.idle()
  assert.notEqual(s.journal.state.budget!.logicalGoalId, before.budget!.logicalGoalId, 'a fresh allowance for the new goal')
  assert.ok(!['accepted', 'declined', 'stopped'].includes(s.journal.state.phase))
  assert.ok(s.journal.state.messages.some(message => message.text === 'Inspect the next thing'))
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
    leadWindowThread({ ...state, seq: state.seq + 1, cardPositions: { ...state.cardPositions, [candidate.id]: state.seq + 1 }, cards: [...state.cards, candidate] }, project, { version: 1, name: 'dex', model: 'fixture-model', policy: state.policy!, caps: state.budget!.caps, key: { configured: true, protection: 'encrypted' } })
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
  const admitWithPolicy = (card: LeadCard) => admitLeadCard({ ...s.journal.state, seq: s.journal.state.seq + 1, cardPositions: { ...s.journal.state.cardPositions, [card.id]: s.journal.state.seq + 1 }, cards: [...s.journal.state.cards, card] }, permission, project, 'fixture-model')
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

for (const kind of ['result', 'person', 'expired'] as const) test(`Resume stays refused for the guarded ${kind} wayOut`, async () => {
  const s = await rig({ configured: true }); await s.journal.offerCard(plan)
  await s.journal.decideCard(planClick, kind === 'expired' ? 99 : 1000)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  if (kind === 'result') await s.journal.offerCard({ version: 1, id: 'result', revision: 1, type: 'result', contractDigest: contract.digest, outcome: 'reviewed', summary: 'Reviewed', assertions: [],
    budget: (await import('@harnessdesk/lead')).leadBudgetProjection(s.journal.state.budget!, 100) })
  if (kind === 'person') await s.journal.offerCard({ version: 1, id: 'person', revision: 1, type: 'waiting', kind: 'person', contractDigest: contract.digest, runId: 'run', personCardId: 'person', summary: 'Decide', assertions: [] })
  assert.equal((await s.controls.readThread()).wayOut, kind === 'expired' ? 'decide-plan' : null)
  const before = s.journal.state
  await assert.rejects(s.controls.resume({ expectedRevision: before.seq }), code(kind === 'expired' ? 'lead-plan-pending' : 'lead-no-person-wait'))
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

for (const action of ['approve', 'resume'] as const) test(`after ${action} the paid request ends with a desk message that carries the approved contract`, async () => {
  const s = await rig({ configured: true })
  await s.controls.send({ idempotencyKey: 'goal', text: 'Inspect the check' }); await s.controls.idle()
  await s.journal.offerCard(plan)
  await s.controls.decide(planClick); await s.controls.idle()
  if (action === 'resume') {
    await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
    await s.controls.resume({ expectedRevision: s.journal.state.seq }); await s.controls.idle()
  }
  assert.equal(s.sends.length, action === 'approve' ? 2 : 3)
  const request: any = s.sends.at(-1)
  // The standing text belongs to the child and is the same for the whole goal; the host never writes or edits it.
  assert.equal('system' in request, false)
  // History is rebuilt from the journal as plain text, so no earlier reasoning block can be replayed into it.
  assert.ok(request.messages.every((turn: any) => turn.content.every((block: any) => block.type === 'text')))
  assert.deepEqual(request.messages.slice(0, 2).map((turn: any) => [turn.role, turnText(turn)]), [['user', 'Inspect the check'], ['assistant', 'Ready to inspect']])
  assert.equal(request.messages.at(-1).role, 'user')
  assert.deepEqual(approvedContractOf(request.messages.at(-1)), contract)
  assert.match(turnText(request.messages.at(-1)), /^The person approved your plan\./)
  s.controls.close()
})

test('a message the person sends after approval is followed by the contract, so every request carries what was approved', async () => {
  const s = await rig({ configured: true })
  await s.journal.offerCard(plan)
  await s.controls.decide(planClick); await s.controls.idle()
  await s.controls.send({ idempotencyKey: 'more', text: 'Also cover the empty case' }); await s.controls.idle()
  const request: any = s.sends.at(-1)
  assert.equal(request.messages.at(-1).role, 'user')
  assert.deepEqual(approvedContractOf(request.messages.at(-1)), contract)
  assert.equal(turnText(request.messages.at(-2)), 'Also cover the empty case', 'the person\'s words stay in the history, in the order they were said')
  s.controls.close()
})

test('a request before any plan is approved asks for a plan, and does not claim a contract was approved', async () => {
  const s = await rig({ configured: true })
  await s.controls.send({ idempotencyKey: 'goal', text: 'Inspect the check' }); await s.controls.idle()
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  await s.controls.resume({ expectedRevision: s.journal.state.seq }); await s.controls.idle()
  const last: any = (s.sends.at(-1) as any).messages.at(-1)
  assert.equal(last.role, 'user')
  assert.equal(turnText(last), 'No plan is approved yet. Continue with a plan for the person to approve.')
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

for (const kind of ['result', 'person', 'plan'] as const) test(`send preserves the resume guard for ${kind}`, async () => {
  const s = await rig({ configured: true })
  try {
    await s.journal.offerCard(plan)
    if (kind !== 'plan') await s.journal.decideCard(planClick, 1000)
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

test('consent expiry re-offers the same plan revision once and projects decide-plan', async () => {
  let now = 100
  const s = await rig({ controls: { now: () => now } })
  await s.journal.offerCard(plan)
  await s.call('lead/card/decide', planClick); await s.controls.idle()
  now = s.journal.state.consent!.expiresAt
  const projection = await s.call('lead/thread/read')
  assert.equal(projection.wayOut, 'decide-plan')
  assert.equal(projection.thread.cards[0].revision, 2)
  assert.deepEqual(projection.thread.cards[0].contract, contract)
  const seq = s.journal.state.seq
  await s.call('lead/settings/read')
  assert.equal(s.journal.state.seq, seq)
  await assert.rejects(s.call('lead/resume', { expectedRevision: seq }), code('lead-plan-pending'))
  await assert.rejects(s.call('lead/card/decide', planClick))
  await s.call('lead/card/decide', { ...planClick, expectedRevision: 2 }); await s.controls.idle()
  assert.equal(s.journal.state.consent!.expiresAt > now, true)
  assert.equal((await s.call('lead/thread/read')).wayOut, null)
  assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
})

test('thread exposes journal positions and approved scope for inline replacement and evidence labels', async () => {
  const s = await rig()
  await s.journal.appendMessage('first', 'First goal')
  await s.journal.offerCard(plan)
  const position = s.journal.state.seq
  await s.journal.appendReply('Inspect the plan')
  await s.journal.offerCard({ ...plan, revision: 2 })
  const projection = await s.call('lead/thread/read')
  assert.equal(projection.thread.cardPositions.plan, position)
  assert.ok(projection.thread.messages[0].revision < position)
  assert.ok(projection.thread.messages[1].revision > position)
  await s.call('lead/card/decide', { ...planClick, expectedRevision: 2 }); await s.controls.idle()
  const approved = await s.call('lead/thread/read')
  assert.deepEqual(approved.thread.contract, contract)
  assert.equal(approved.thread.budget.leadUsdMicros, 0)
})

test('a running goal reports the step it is on and the runs it has started, and nothing in any other phase', async () => {
  const s = await rig({ configured: true })
  await s.journal.offerCard(plan)
  assert.equal(leadProgress(s.journal.state), null, 'a plan nobody approved yet is not progress')
  assert.equal((await s.controls.readThread()).progress, undefined)
  await s.controls.decide(planClick); await s.controls.idle()
  assert.deepEqual(leadProgress(s.journal.state), { step: 1, steps: 1, runs: 0 })
  assert.deepEqual((await s.controls.readThread()).progress, { step: 1, steps: 1, runs: 0 })
  const three = { ...contract, steps: ['a', 'b', 'c'].map(id => ({ ...contract.steps[0]!, id })) }
  const at = (states: string[], runs: number, phase = 'running') => ({ ...s.journal.state, phase, contract: three,
    steps: states.map((state, index) => ({ id: ['a', 'b', 'c'][index]!, state, attemptId: null, contractDigest: null })),
    runs: Array.from({ length: runs }, (_, index) => ({ correlationId: `c${index}`, runId: `r${index}`, teamId: `t${index}` })) }) as any
  assert.deepEqual(leadProgress(at(['pending', 'pending', 'pending'], 0)), { step: 1, steps: 3, runs: 0 }, 'before any step starts the Lead is on the first')
  assert.deepEqual(leadProgress(at(['started', 'pending', 'pending'], 1)), { step: 1, steps: 3, runs: 1 })
  assert.deepEqual(leadProgress(at(['started', 'started', 'pending'], 2)), { step: 2, steps: 3, runs: 2 })
  assert.deepEqual(leadProgress(at(['started', 'started', 'started'], 3)), { step: 3, steps: 3, runs: 3 })
  // A step the Lead has been admitted to start, or cannot be sure it started, is already the one it is on.
  assert.deepEqual(leadProgress(at(['admitted', 'pending', 'pending'], 0)), { step: 1, steps: 3, runs: 0 })
  assert.deepEqual(leadProgress(at(['started', 'admitted', 'pending'], 1)), { step: 2, steps: 3, runs: 1 })
  assert.deepEqual(leadProgress(at(['started', 'started', 'uncertain'], 2)), { step: 3, steps: 3, runs: 2 })
  assert.deepEqual(leadProgress(at([], 0)), { step: 1, steps: 3, runs: 0 }, 'a journal that lists no step states still reads')
  for (const phase of ['draft', 'planning', 'awaiting-plan', 'waiting-for-user', 'accepted', 'declined', 'stopped'])
    assert.equal(leadProgress(at(['started', 'pending', 'pending'], 1, phase)), null, `${phase} is not running`)
  assert.equal(leadProgress({ ...at(['started'], 1), contract: null } as any), null)
  // The window names the Team of the latest run, only while the goal runs: the board where the person's own acts live.
  assert.equal(leadRunTeam(at(['started', 'pending', 'pending'], 0)), null, 'no run yet, no Team')
  assert.equal(leadRunTeam(at(['started', 'started', 'pending'], 2)), 't1', 'the latest run')
  for (const phase of ['waiting-for-user', 'accepted', 'stopped']) assert.equal(leadRunTeam(at(['started'], 1, phase)), null, `${phase} is not running`)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-request-failed')
  assert.equal((await s.controls.readThread()).progress, undefined, 'a goal that waits for the person reports no progress')
  s.controls.close()
})


test('forty renewals leave reads Settings and key removal available', async () => {
  let now = 100
  const s = await rig({ configured: true, controls: { now: () => now } })
  try {
    await s.journal.offerCard(plan); await s.call('lead/card/decide', planClick); await s.controls.idle()
    for (let i = 0; i < 40; i++) {
      now = s.journal.state.consent!.expiresAt
      const projection = await s.call('lead/thread/read')
      const card = projection.thread.cards.find((card: any) => card.type === 'plan')
      assert.ok(card)
      await s.call('lead/card/decide', { ...planClick, cardId: card.id, expectedRevision: card.revision }); await s.controls.idle()
    }
    await s.call('lead/settings/read')
    const result = await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key: null } })
    assert.equal(result.settings.key.configured, false)
  } finally { s.controls.close() }
})

test('renewal failures cannot make reads or key removal fail', async () => {
  const s = await rig({ configured: true })
  try {
    s.journal.renewPlan = async () => { throw new Error('synthetic renewal refusal') }
    await s.call('lead/thread/read'); await s.call('lead/settings/read')
    const result = await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key: null } })
    assert.equal(result.settings.key.configured, false)
  } finally { s.controls.close() }
})


test('genuine policy tightening gives a pending plan a typed stale refusal', async () => {
  const s = await rig()
  try {
    await s.journal.offerCard(plan)
    await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, policy: { ...policy, revision: 2, mode: 'plan' } })
    await assert.rejects(s.call('lead/card/decide', planClick), code('lead-card-stale'))
    assert.equal((await s.call('lead/thread/read')).wayOut, 'decide-plan')
  } finally { s.controls.close() }
})

for (const revision of [1, 32]) test(`a full card table reports typed renewal blocking at plan revision ${revision}`, async () => {
  let now = 100
  const s = await rig({ controls: { now: () => now } })
  try {
    await s.journal.offerCard(plan); await s.call('lead/card/decide', planClick); await s.controls.idle()
    for (let i = 1; i < revision; i++) {
      const expiry = s.journal.state.consent!.expiresAt
      await s.journal.renewPlan(expiry)
      await s.journal.decideCard({ ...planClick, expectedRevision: i + 1 }, expiry + 100)
    }
    for (let i = 0; i < 63; i++) await s.journal.offerCard({ version: 1, id: `filler-${i}`, revision: 1, type: 'result', outcome: 'reviewed', contractDigest: contract.digest, summary: 'Synthetic result', assertions: [], budget: leadBudgetProjection(s.journal.state.budget!, 100) })
    assert.equal(s.journal.state.cards.length, 64)
    now = s.journal.state.consent!.expiresAt
    const before = s.journal.state.seq, projection = await s.call('lead/thread/read')
    assert.equal(projection.waitReason, 'lead-renewal-blocked'); assert.equal(projection.wayOut, null)
    assert.equal(s.journal.state.seq, before + 1); assert.equal(s.journal.state.cards.length, 64)
    assert.equal((await s.call('lead/settings/read')).waitReason, 'lead-renewal-blocked')
    assert.equal(s.journal.state.seq, before + 1)
    assert.equal((await createLeadJournal(s.storage)).state.managementReason, 'lead-renewal-blocked')
    const removed = await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key: null } })
    assert.equal(removed.settings.key.configured, false)
  } finally { s.controls.close() }
})

for (const mode of ['plan', 'default'] as const) test(`Add rule Save is retained on settings reopen in ${mode} mode`, async () => {
  const s = await rig()
  try {
    if (mode === 'plan') await s.journal.setPolicy({ ...policy, revision: 2, mode })
    const before = await s.call('lead/settings/read')
    const proposed = { ...before.settings.policy, revision: before.settings.policy.revision + 1, rules: [{ id: 'added-rule', method: 'flow/start-goal', effect: 'ask', action: null, project: null }] }
    const saved = await s.call('lead/settings/update', { expectedRevision: before.revision, policy: proposed })
    assert.deepEqual(saved.settings.policy, proposed)
    assert.deepEqual((await s.call('lead/settings/read')).settings.policy, proposed)
    assert.deepEqual((await createLeadJournal(s.storage)).state.policy, proposed)
  } finally { s.controls.close() }
})


test('live host worker relays are visible without entering the journal decision table', async () => {
  let waiting: LeadCard[] = [{ version: 1, id: 'worker-live', revision: 1, type: 'waiting', kind: 'worker-approval',
    runId: 'run-1', personCardId: null, summary: 'A worker is waiting for a command approval.', assertions: [], contractDigest: contract.digest }]
  const s = await rig({ controls: { readWorkerApprovals: () => waiting } })
  await s.journal.offerCard(plan); await s.call('lead/card/decide', planClick); await s.controls.idle()
  const projected = await s.call('lead/thread/read')
  assert.ok(projected.thread.cards.some((card: LeadCard) => card.id === 'worker-live'))
  assert.equal(s.journal.state.cards.some(card => card.id === 'worker-live'), false)
  await assert.rejects(s.call('lead/card/decide', { version: 1, cardId: 'worker-live', cardType: 'waiting', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' }), code('lead-worker-approval'))
  assert.equal(s.answers.length, 0)
  const before = s.journal.state.seq, records = s.records.length, notifications = s.notifications.length
  waiting = []
  const changed = s.controls.workerApprovalsChanged()
  const saved = s.call('lead/settings/update', { expectedRevision: before, name: 'lex' })
  await Promise.all([changed, saved]); await s.controls.idle()
  assert.equal(s.journal.state.seq, before + 1, 'only the settings save may append a journal record')
  assert.equal(s.records.length, records + 1)
  assert.ok(s.notifications.length >= notifications + 1, 'same-revision approval changes still push a projection')
  const notification = s.notifications[notifications]!
  assert.equal(notification.method, 'lead/changed')
  if (notification.method === 'lead/changed' && !('error' in notification.params)) {
    assert.equal(notification.params.revision, before)
    assert.equal(notification.params.thread.cards.some(card => card.id === 'worker-live'), false)
  }
  assert.equal(s.journal.state.name, 'lex', 'the concurrent settings save keeps its revision fence')
  assert.equal((await s.call('lead/thread/read')).thread.cards.some((card: LeadCard) => card.id === 'worker-live'), false)
})


test('Lead name defaults to Dex and saves alone without authority or a card, surviving replay and checkpoint', async () => {
  const s = await rig(), before = s.journal.state
  assert.equal((await s.call('lead/settings/read')).settings.name, 'dex')
  const result = await s.call('lead/settings/update', { expectedRevision: before.seq, name: 'lex' })
  assert.equal(result.settings.name, 'lex')
  assert.deepEqual(s.journal.state.policy, before.policy)
  assert.deepEqual(s.journal.state.budget, before.budget)
  assert.deepEqual(s.journal.state.cards, [])
  const reopened = await createLeadJournal(s.storage)
  assert.equal((reopened.state as any).name, 'lex')
  assert.equal((parseLeadCheckpoint(leadCheckpoint(reopened.state, '0'.repeat(64))).state as any).name, 'lex')
})
test('Lead name validation and credential exclusivity refuse before any side effect', async () => {
  const s = await rig(), before = s.journal.state
  for (const name of ['other', '', null, 1]) await assert.rejects(s.call('lead/settings/update', { expectedRevision: before.seq, name }))
  await assert.rejects(s.call('lead/settings/update', { expectedRevision: before.seq, name: 'lex', credential: { provider: 'anthropic', key } }), code('lead-settings-combination'))
  assert.deepEqual(s.journal.state, before)
  assert.equal((await s.call('lead/settings/read')).settings.key.configured, false)
})

test('a decided plan remains a journal-positioned message with its state through replay', async () => {
  const s = await rig(); await s.journal.offerCard(plan)
  await s.call('lead/card/decide', { ...planClick, choice: 'decline' })
  const projection = await s.call('lead/thread/read')
  assert.deepEqual(projection.thread.cards, [])
  assert.deepEqual(projection.thread.decisions, [{ card: plan, choice: 'decline', position: s.journal.state.cardPositions.plan }])
  const reopened = await createLeadJournal(s.storage)
  assert.deepEqual(reopened.state.decisionMessages, projection.thread.decisions)
})
test('a new credential present in decided message details refuses before broker storage', async () => {
  const s = await rig()
  const secretPlan = { ...plan, contract: { ...contract, goal: key } }
  await s.journal.offerCard(secretPlan)
  await s.journal.decideCard({ ...planClick, choice: 'decline' })
  await assert.rejects(s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, credential: { provider: 'anthropic', key } }), code('lead-secret-in-thread'))
  assert.equal((await s.service.status()).configured, false)
})

test('renewed decisions replace earlier prose for the same card at its original journal position', async () => {
  const s = await rig(); await s.journal.offerCard(plan)
  await s.journal.decideCard(planClick, 101)
  const position = s.journal.state.cardPositions.plan
  await s.journal.renewPlan(102)
  await s.journal.decideCard({ ...planClick, expectedRevision: 2 }, 200)
  assert.equal(s.journal.state.decisionMessages.length, 1)
  assert.equal(s.journal.state.decisionMessages[0]!.card.revision, 2)
  assert.equal(s.journal.state.decisionMessages[0]!.position, position)
})

test('name-only settings save survives unavailable key resolution without scanning', async () => {
  const calls: unknown[] = []; let locked = false
  const s = await rig({ service: { async status() { if (locked) throw new Error('keychain unavailable'); return { configured: false, protection: 'unavailable' } }, async assertPublic(value: unknown) { if (locked) { calls.push(value); throw Object.assign(new Error('locked'), { wireCode: 'lead-protection-unavailable' }) } } } })
  await s.controls.readSettings(); locked = true
  const before = s.journal.state
  const result = await s.call('lead/settings/update', { expectedRevision: before.seq, name: 'lex' })
  assert.equal(result.settings.name, 'lex'); assert.equal(calls.length, 0)
  assert.deepEqual(s.journal.state.policy, before.policy); assert.deepEqual(s.journal.state.budget, before.budget)
})
test('name combined with authority is refused atomically', async () => {
  const s = await rig(), before = s.journal.state
  for (const update of [{ name: 'lex', policy: { ...policy, revision: 2, mode: 'plan' } }, { name: 'lex', caps: { usdMicros: 1, rounds: 1 } }]) {
    await assert.rejects(s.call('lead/settings/update', { expectedRevision: before.seq, ...update }), code('lead-settings-combination'))
    assert.deepEqual(s.journal.state, before)
  }
})

test('every read projection after a name save runs assertPublic', async () => {
  const s = await rig()
  await s.controls.readSettings()
  await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, name: 'lex' })
  await s.controls.idle()
  const scan = test.mock.method(s.service, 'assertPublic')
  await s.controls.readThread()
  await s.controls.readSettings()
  assert.equal(scan.mock.callCount(), 2)
})
test('a message appended after a name change is scanned on projection', async () => {
  const s = await rig()
  await s.controls.readSettings()
  await s.call('lead/settings/update', { expectedRevision: s.journal.state.seq, name: 'lex' })
  await s.controls.idle()
  await s.journal.appendMessage('after-name', 'Inspect the newly appended message')
  await s.controls.idle()
  const scan = test.mock.method(s.service, 'assertPublic')
  const projection = await s.controls.readThread()
  assert.equal(scan.mock.callCount(), 1)
  assert.deepEqual(scan.mock.calls[0]!.arguments, [projection, s.journal.state.seq])
  assert.equal(projection.thread.messages.at(-1)?.text, 'Inspect the newly appended message')
})
test('a name-only settings save ignores a stale revision without scanning', async () => {
  const s = await rig()
  const before = s.journal.state
  const result = await s.call('lead/settings/update', { expectedRevision: 0, name: 'lex' })
  assert.deepEqual(result, { version: 1, revision: s.journal.state.seq, settings: { name: 'lex' } })
  assert.deepEqual(s.journal.state.policy, before.policy)
  assert.deepEqual(s.journal.state.budget, before.budget)
})

for (const reason of ['lead-predecessor-unavailable', 'lead-predecessor-unverifiable']) test(`${reason} refuses Resume but a message resumes with new instructions`, async () => {
  const s = await rig({ configured: true })
  try {
    await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000)
    await s.journal.setManagementPhase('waiting-for-user', reason)
    const projection = await s.call('lead/thread/read')
    assert.equal(projection.wayOut, null)
    assert.equal(projection.waitReason, reason)
    const seq = s.journal.state.seq
    await assert.rejects(s.call('lead/resume', { expectedRevision: seq }), code('lead-no-person-wait'))
    assert.equal(s.journal.state.seq, seq)
    s.service.send = async (value: any) => {
      assert.equal(s.journal.state.phase, 'running')
      // The plan was approved, so the desk's message about it follows the person's words and the request still carries the contract.
      assert.equal(value.messages.at(-2).content[0].text, 'Change the plan')
      assert.match(turnText(value.messages.at(-1)), /^The person approved your plan\./)
      return { status: 'completed', text: 'Plan change received' }
    }
    await s.call('lead/thread/send', { idempotencyKey: 'change-plan', text: 'Change the plan' }); await s.controls.idle()
    assert.equal(s.records.filter(record => record.type === 'resume').length, 1)
    assert.equal(s.journal.state.messages.at(-1)!.text, 'Plan change received')
  } finally { s.controls.close() }
})


for (const fence of ['recovery', 'expired consent'] as const) test(`a predecessor message refuses ${fence} before append or request`, async () => {
  const s = await rig({ configured: true })
  await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-predecessor-unavailable')
  if (fence === 'recovery') {
    // Replay a durable recovery fence without manufacturing any run identity.
    const record = { version: 1 as const, seq: s.journal.state.seq + 1, type: 'recovery-block' as const }
    s.records.push(record)
  }
  s.controls.close()
  const journal = await createLeadJournal(s.storage), { LeadControls } = await controlsModule()
  const controls = new LeadControls({ journal, service: s.service, project, model: 'fixture-model', now: () => fence === 'expired consent' ? 1001 : 100,
    nextId: () => 'unused', push() {}, decidePerson: async () => {}, decideResult: async () => {} })
  try {
    assert.equal(journal.state.phase, 'waiting-for-user')
    const before = journal.state
    await assert.rejects(controls.send({ idempotencyKey: fence === 'recovery' ? 'fenced-recovery' : 'fenced-expiry', text: 'Change the plan' }), code('lead-no-person-wait'))
    await controls.idle()
    assert.deepEqual(journal.state, before)
    assert.equal(s.sends.length, 0)
  } finally { controls.close() }
})


test('Stop goal latches stopped with no way out and a later message starts a fresh goal', async () => {
  let stops = 0
  const s = await rig({ configured: true, controls: { stopEffects: async () => { stops++ } } })
  await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-predecessor-unavailable')
  const oldBudget = s.journal.state.budget
  const stopped = await s.call('lead/stop', { expectedRevision: s.journal.state.seq })
  assert.equal(stopped.thread.state, 'stopped'); assert.equal(stopped.wayOut, null)
  // The person's Stop is a latched cancellation, not a stopped card: the window says the goal was stopped itself.
  assert.equal(stopped.thread.budget.stop.reason, 'cancelled'); assert.equal(stopped.thread.cards.some((card: LeadCard) => card.type === 'stopped'), false)
  assert.equal(stopped.progress, undefined)
  assert.equal(stops, 1); assert.equal(s.journal.state.stopEffectsPending, null)
  assert.equal(s.sends.length, 0); assert.deepEqual(s.answers, [])
  await s.call('lead/thread/send', { idempotencyKey: 'new-goal', text: 'Inspect another check' })
  await s.controls.idle()
  assert.equal(s.journal.state.contract, null); assert.equal(s.journal.state.consent, null)
  assert.equal(s.journal.state.budget!.stop, null)
  assert.notEqual(s.journal.state.budget!.logicalGoalId, oldBudget!.logicalGoalId)
  assert.equal(s.journal.state.completedBudgets[0]!.logicalGoalId, oldBudget!.logicalGoalId)
  assert.deepEqual(s.journal.state.completedBudgets[0]!.rounds, oldBudget!.rounds)
  assert.equal(s.journal.state.completedBudgets[0]!.leadUsdMicros, oldBudget!.leadUsdMicros)
  assert.equal(s.sends.length, 1)
  const reopened = await createLeadJournal(s.storage)
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(reopened.state, '0'.repeat(64))).state, reopened.state)
})


test('Stop goal keeps an unfinished cancellation closed to a new goal', async () => {
  const s = await rig({ configured: true, controls: { stopEffects: async () => { throw new Error('stop pending') } } })
  await s.journal.offerCard(plan); await s.journal.decideCard(planClick, 1000)
  const projection = await s.call('lead/stop', { expectedRevision: s.journal.state.seq })
  assert.equal(projection.thread.state, 'stopped'); assert.equal(projection.wayOut, null)
  assert.notEqual(s.journal.state.stopEffectsPending, null)
  const before = s.journal.state
  await assert.rejects(s.controls.send({ idempotencyKey: 'while-stopping', text: 'Another goal' }), code('lead-thread-closed'))
  assert.deepEqual(s.journal.state, before); assert.equal(s.sends.length, 0)
})


test('Stop goal ends the request even when Flow cleanup already acknowledged cancellation', async t => {
  let stops = 0
  const s = await rig({ controls: { stopEffects: async () => {}, stopRequest: async () => { stops++ } } })
  const cleanup = s.journal.runStopEffects.bind(s.journal)
  t.mock.method(s.journal, 'runStopEffects', async (effects: () => Promise<void>) => {
    await cleanup(async () => {}) // The independent Flow-only owner wins the marker.
    await cleanup(effects)
  })
  const result = await s.call('lead/stop', { expectedRevision: s.journal.state.seq })
  assert.equal(result.thread.state, 'stopped'); assert.equal(result.wayOut, null)
  assert.equal(stops, 1, 'ending the Lead request cannot depend on the Flow cleanup marker')
})

test('a failed Lead process stop refuses a new goal before resetting its accounting', async t => {
  let stopped = false
  const s = await rig({ configured: true, controls: { stopEffects: async () => {}, stopRequest: async () => { if (!stopped) throw new Error('process still live') } } })
  const cleanup = s.journal.runStopEffects.bind(s.journal)
  t.mock.method(s.journal, 'runStopEffects', async (effects: () => Promise<void>) => {
    await cleanup(async () => {})
    await cleanup(effects)
  })
  await s.call('lead/stop', { expectedRevision: s.journal.state.seq }).catch(() => {})
  const before = s.journal.state
  await assert.rejects(s.controls.send({ idempotencyKey: 'failed-process-stop', text: 'Another goal' }))
  await s.controls.idle()
  assert.deepEqual(s.journal.state, before); assert.equal(s.sends.length, 0)
  stopped = true
  await s.controls.send({ idempotencyKey: 'after-process-stop', text: 'Another goal' })
  await s.controls.idle(); assert.equal(s.sends.length, 1)
})


test('a new goal after stopping an in-flight reply plans without resuming the old goal', async t => {
  let release!: () => void, calls = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const s = await rig({ configured: true, controls: { stopEffects: async () => {}, stopRequest: async () => release() }, service: {
    async send() {
      if (++calls === 1) await held
      else if (s.journal.state.phase === 'draft') await s.journal.setManagementPhase('planning')
      return { status: 'completed', text: calls === 1 ? 'Old reply' : 'Planning the new goal' }
    },
  } })
  t.after(() => s.controls.close())
  await s.controls.send({ idempotencyKey: 'old-goal', text: 'Old goal' })
  while (!calls) await new Promise(resolve => setTimeout(resolve, 1))
  await s.call('lead/stop', { expectedRevision: s.journal.state.seq })
  assert.equal(s.journal.state.messages.at(-1)!.role, 'user')
  const start = s.records.length
  await s.controls.send({ idempotencyKey: 'fresh-goal', text: 'New goal' }); await s.controls.idle()
  assert.ok(['planning', 'awaiting-plan'].includes(s.journal.state.phase), s.journal.state.phase)
  assert.equal(s.records.slice(start).some(record => record.type === 'management' && record.reason === 'lead-request-failed'), false)
  assert.equal(s.journal.state.messages.some(message => message.text === 'Old reply'), false)
})

for (const phase of ['accepted', 'declined', 'stopped'] as const) test(`Stop goal refuses a ${phase} thread before effects`, async t => {
  let effects = 0
  const s = await rig({ controls: { stopEffects: async () => { effects++ }, stopRequest: async () => { effects++ } } })
  t.after(() => s.controls.close())
  await s.journal.offerCard(plan)
  await s.journal.decideCard({ ...planClick, choice: phase === 'declined' ? 'decline' : 'approve' }, 1000)
  if (phase === 'stopped') await s.journal.stop(async () => {})
  if (phase === 'accepted') {
    await s.journal.offerCard({ version: 1, id: 'result', revision: 1, type: 'result', outcome: 'reviewed', summary: 'Ready', assertions: [],
      budget: leadBudgetProjection(s.journal.state.budget!, 100), contractDigest: contract.digest })
    await s.journal.decideCard({ version: 1, cardId: 'result', cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept' }, 1000)
  }
  assert.equal(s.journal.state.phase, phase)
  const before = s.journal.state
  await assert.rejects(s.call('lead/stop', { expectedRevision: before.seq }), code('lead-thread-closed'))
  assert.deepEqual(s.journal.state, before); assert.equal(effects, 0)
})

test('a recovery-blocked new goal refuses before process halt or journal write', async () => {
  const s = await rig({ configured: true })
  await s.journal.stop(async () => {})
  s.records.push({ version: 1, seq: s.journal.state.seq + 1, type: 'recovery-block' })
  s.controls.close()
  const journal = await createLeadJournal(s.storage), { LeadControls } = await controlsModule()
  let effects = 0
  const controls = new LeadControls({ journal, service: s.service, project, model: 'fixture-model', now: () => 100,
    nextId: () => 'unused', push() {}, decidePerson: async () => {}, decideResult: async () => {}, stopRequest: async () => { effects++ } })
  try {
    const before = journal.state, records = s.records.length
    await assert.rejects(controls.send({ idempotencyKey: 'blocked-goal', text: 'Another goal' }), code('lead-thread-closed'))
    assert.equal(effects, 0); assert.equal(s.records.length, records); assert.deepEqual(journal.state, before)
  } finally { controls.close() }
})


test('a retried caps save re-derives concurrent widening and still needs approval', async t => {
  const s = await rig(); t.after(() => s.controls.close())
  const seen = await s.controls.readSettings(), desired = { usdMicros: 80000, rounds: 4 }
  await s.journal.changeBudgetCaps({ usdMicros: 50000, rounds: 3 }, { id: 'concurrent', revision: 1 }, 100)
  await assert.rejects(s.controls.updateSettings({ caps: desired, expectedRevision: seen.revision }), code('lead-revision-stale'))
  const fresh = await s.controls.readSettings()
  const result = await s.controls.updateSettings({ caps: desired, expectedRevision: fresh.revision })
  assert.deepEqual(s.journal.state.budget!.caps, { usdMicros: 50000, rounds: 3 })
  const card = s.journal.state.cards.at(-1)!
  assert.equal(card.type, 'budget-change')
  if (card.type === 'budget-change') { assert.deepEqual(card.previous.caps, { usdMicros: 50000, rounds: 3 }); assert.deepEqual(card.proposed, desired) }
  assert.ok('thread' in result && result.thread.cards.some((card: LeadCard) => card.type === 'budget-change'))
})

test('a Lead request re-reads worker spend first, and a refusal over unknown spend tells the person', async () => {
  const order: string[] = []
  const metered = await rig({ configured: true, service: { async send() { order.push('send'); return { status: 'completed', text: 'Ready' } } },
    controls: { meterSpend: async () => { order.push('meter') } } })
  await metered.call('lead/thread/send', { idempotencyKey: 'send-1', text: 'Inspect the check' })
  await metered.controls.idle()
  assert.deepEqual(order, ['meter', 'send'])

  const s = await rig({ configured: true, service: { async send() { return { status: 'refused', reason: 'lead-management-paused' } } } })
  await s.journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'goal-1', executionId: 'run-1' })
  assert.equal(leadBudgetProjection(s.journal.state.budget!, 100).spend, 'unknown')
  await s.call('lead/thread/send', { idempotencyKey: 'send-1', text: 'Re-plan it' })
  await s.controls.idle()
  const read = await s.call('lead/thread/read')
  assert.equal(s.journal.state.phase, 'waiting-for-user')
  assert.equal(read.waitReason, 'lead-budget-unknown')
})
