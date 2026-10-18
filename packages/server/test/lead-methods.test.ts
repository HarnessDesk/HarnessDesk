import assert from 'node:assert/strict'
import test from 'node:test'
import { createLeadLoop, createLeadJournal, leadCheckpoint, parseLeadCheckpoint, type LeadJournalRecord } from '@harnessdesk/lead'
import { parseLeadAcceptanceContract, type WireNotification } from '@harnessdesk/protocol'
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
const rig = async () => {
  const records: LeadJournalRecord[] = [], notifications: WireNotification[] = [], sends: unknown[] = [], answers: unknown[] = []
  const storage = { async read() { return records }, async append(record: LeadJournalRecord) { records.push(record) } }
  const journal = await createLeadJournal(storage)
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 1000 })
  let configured = false
  const service = { async status() { return { configured, protection: 'synthetic cipher' } },
    async setKey(provider: string, value: string) { assert.equal(provider, 'anthropic'); assert.equal(value, key); configured = true },
    async deleteKey() { configured = false },
    async assertPublic(value: unknown) { if (JSON.stringify(value).includes(key)) throw new Error('lead-secret-refused') },
    async send(value: unknown) { sends.push(value); return { status: 'completed', text: 'Ready to inspect' } } }
  const { LeadControls } = await controlsModule()
  const controls = new LeadControls({ journal, service, project, model: 'fixture-model', now: () => 100, nextId: () => `card-${journal.state.seq + 1}`,
    push: (value: WireNotification) => notifications.push(value), decidePerson: async (...args: unknown[]) => { answers.push(args) }, decideResult: async (...args: unknown[]) => { answers.push(args) } })
  const ctx = { leadThreadRead: () => controls.readThread(), leadThreadSend: (p: unknown) => controls.send(p),
    leadCardDecide: (p: unknown) => controls.decide(p), leadSettingsRead: () => controls.readSettings(),
    leadSettingsUpdate: (p: unknown) => controls.updateSettings(p), leadResume: (p: unknown) => controls.resume(p) } as unknown as HostContext
  const call = (method: string, params: unknown = {}) => dispatch(ctx, method as never, params as never) as Promise<any>
  return { controls, journal, records, storage, notifications, sends, answers, service, call }
}
const code = (reason: string) => (error: any) => error.wireCode === reason

test('window handlers reach named context operations and thread sends are durably idempotent', async () => {
  const s = await rig()
  const first = await s.call('lead/thread/send', { idempotencyKey: 'send-1', text: 'Inspect the check' })
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
  const s = await rig()
  for (let i = 0; i < 270; i++) await s.call('lead/thread/send', { idempotencyKey: `send-${i}`, text: 'x'.repeat(1000) })
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

test('the window resume resets the real loop no-progress counter', async () => {
  const s = await rig(), scheduled: (() => void)[] = []
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
  await s.call('lead/resume', { expectedRevision: s.journal.state.seq })
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
  const host = new Host({ logger: silent, state: new StateStore(join(home, 'state.json')), catalogRefreshMs: 0 })
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
  const first = await host.call('lead/thread/send', { idempotencyKey: 'host-send', text: 'Inspect the check' })
  assert.deepEqual(await host.call('lead/thread/send', { idempotencyKey: 'host-send', text: 'retry' }), first)
  const projection = await host.call('lead/thread/read', {})
  assert.equal(projection.thread.messages.length, 1)
  assert.equal(projection.thread.messages[0]?.text, 'Inspect the check')
  assert.equal(spawns, 0)
})
