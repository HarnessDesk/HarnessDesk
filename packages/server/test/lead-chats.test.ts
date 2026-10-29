import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { initialLeadState, reduceLeadBudget, summarizeLeadArguments, type LeadState, type LeadPermissionContext } from '@harnessdesk/lead'
import { runtimeId, sessionId, type SessionSummary } from '@harnessdesk/protocol'
import { SessionIndex } from '../src/session-index.js'

const modulePath = '../src/lead/chats.js'
const rig = async (t: TestContext) => {
  assert.ok(existsSync(new URL(modulePath, import.meta.url)), 'The host must supply the project-pinned LeadChats service')
  const { LeadChats } = await import(modulePath)
  const home = await realpath(await mkdtemp('/tmp/hd-lead-chats-')), root = join(home, 'project'), foreign = join(home, 'foreign')
  await mkdir(root); await mkdir(foreign)
  const index = new SessionIndex(':memory:')
  t.after(async () => { index.close(); await rm(home, { recursive: true, force: true }) })
  const project = { id: 'project', path: root }, runtime = runtimeId('fixture')
  let state: LeadState = { ...initialLeadState(), phase: 'planning', policy: { version: 1, revision: 1, mode: 'manage', rules: [] },
    budget: reduceLeadBudget(null, { version: 1, type: 'initialize', logicalGoalId: 'goal', now: 100, freshnessMs: 60000, caps: { usdMicros: 10000, rounds: 3 } }) }
  let queuedScope: ((cwd: string) => Promise<void>) | undefined
  let member = true, cwdRead: (() => Promise<void>) | undefined, count = 0
  const calls: { method: string; params: any }[] = []
  const published: any[] = []
  let live = { running: false, waiting: false }
  const row = (id: string, cwd = root, updatedAt = 10, extra = {}) => {
    const summary: SessionSummary = { runtime, id: sessionId(id), title: `Chat ${id}`, cwd, updatedAt, createdAt: 1, status: { type: 'idle' }, ...extra }
    index.upsert(summary); return summary
  }
  const authorize = (method: string, params: unknown) => {
    const id = `attempt-${++count}`
    const attempts = new Map(state.attempts)
    for (const [key, value] of attempts) attempts.set(key, { ...value, phase: 'finished', outcome: 'succeeded' })
    attempts.set(id, { id, correlationId: id, method, arguments: summarizeLeadArguments(params), action: null, kind: 'mutation', stepId: null,
      phase: 'started', dispatched: true, effect: 'allow', outcome: null, recoveryReported: false, evidence: null, evidenceSeq: null, resolutionPending: false, contested: false })
    state = { ...state, attempts }

    return id
  }
  const service = new LeadChats({ noteDispatchNotStarted: () => {}, project, state: () => state, member: async () => member, now: () => 100,
    context: async (): Promise<LeadPermissionContext> => ({ desk: state.policy!, projectPolicy: null, project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' }),
    index, cwd: async (runtime: any, id: any) => { await cwdRead?.(); return index.get(runtime, id)?.cwd ?? null },
    live: () => live, publish: (event: any) => { published.push(event) },
    work: {
      threadRead: async (params: any) => { calls.push({ method: 'read', params }); return { id: params.id, title: 'Project chat', agent: { name: 'Agent' }, status: 'done', turns: [] } },
      startInProject: async (params: any, root: string, admit: (id?: string) => Promise<void>) => { await admit(); calls.push({ method: 'start', params: { ...params, root } }); return { id: 'fixture:created' } },
      sessionSend: async (params: any, admit: () => Promise<void>, _effect: unknown, scope: (cwd: string) => Promise<void>) => { await admit(); queuedScope = scope; calls.push({ method: 'send', params }); return { queued: true } },
      stop: async (params: any, admit: () => Promise<void>) => { await admit(); calls.push({ method: 'stop', params }); return {} },
    },
  })
  return { service, index, root, foreign, row, calls, authorize, published, queuedScope: () => queuedScope!, setLive: (next: typeof live) => { live = next }, setState: (next: Partial<LeadState>) => { state = { ...state, ...next } }, state: () => state,
    withdraw: () => { member = false }, onCwd: (callback: () => Promise<void>) => { cwdRead = callback } }
}

test('Lead lists only canonical project ordinary sessions and reads no foreign, Team or removed session', async t => {
  const r = await rig(t)
  r.row('own'); r.row('foreign', r.foreign); r.row('nested', join(r.root, 'nested')); r.row('team'); r.index.upsert(r.row('team'), { teamId: 'team' })
  r.row('removed'); r.index.remove(runtimeId('fixture'), sessionId('removed'))
  const alias = join(r.root, '..', 'alias'); await symlink(r.root, alias); r.row('alias', alias)
  const result = await r.service.list({})
  assert.deepEqual(result.items.map((item: any) => item.id).sort(), ['fixture:alias', 'fixture:own'])
  for (const id of ['foreign', 'nested', 'team', 'removed']) await assert.rejects(r.service.read({ id: `fixture:${id}` }), /scope|project|session/i)
  assert.equal((await r.service.read({ id: 'fixture:own' })).id, 'fixture:own')
})

test('Lead bounded list cursors enumerate beyond foreign rows without revealing their identity', async t => {
  const r = await rig(t)
  for (let i = 0; i < 210; i++) r.row(`foreign-${i}`, r.foreign, 1000 - i)
  r.row('own', r.root, 1)
  const first = await r.service.list({ limit: 1 })
  assert.deepEqual(first.items, []); assert.equal(typeof first.nextCursor, 'string')
  assert.equal(Buffer.from(first.nextCursor, 'base64url').toString().includes('foreign'), false)
  const second = await r.service.list({ limit: 1, cursor: first.nextCursor })
  assert.deepEqual(second.items.map((item: any) => item.id), ['fixture:own'])
  await assert.rejects(r.service.list({ cursor: 'made-up' }), /cursor/i)
})

test('Lead list pages also fit the provider byte limit with Unicode titles and resume at the first omitted row', async t => {
  const r = await rig(t)
  for (let i = 0; i < 60; i++) r.row(`chat-${i}`, r.root, 1000 - i, { title: '研究进度'.repeat(40) })
  let cursor: string | null = null
  const ids: string[] = []
  do {
    const page: { items: readonly { id: string }[]; nextCursor: string | null } = await r.service.list({ limit: 50, ...(cursor ? { cursor } : {}) })
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 12_000)
    ids.push(...page.items.map(item => item.id))
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(ids.length, 60)
  assert.equal(new Set(ids).size, 60)
})

test('run calls require a durable allow attempt and independently enforce plan policy, budget and lifecycle', async t => {
  const r = await rig(t); r.row('own')
  const params = { id: 'fixture:own', text: 'Continue' }
  await assert.rejects(r.service.send(params), /attempt|admission/i)
  r.authorize('lead/chat/send', params)
  r.setState({ policy: { version: 1, revision: 2, mode: 'plan', rules: [] } })
  await assert.rejects(r.service.send(params), /mode|read/i)
  assert.equal(r.calls.length, 0)
  assert.equal((await r.service.list({})).items.length, 1)
  r.setState({ policy: { version: 1, revision: 3, mode: 'manage', rules: [] } })
  r.authorize('lead/chat/send', params)
  assert.deepEqual(await r.service.send(params), { queued: true })
  await assert.rejects(r.service.send(params), /attempt|admission|consumed/i)
  for (const phase of ['stopped', 'accepted', 'declined'] as const) {
    r.setState({ phase }); r.authorize('lead/chat/start', { text: 'Do work' })
    await assert.rejects(r.service.start({ text: 'Do work' }), /stopped|recovery|terminal/i)
  }
})

test('archived mutations and membership changes during I/O are refused before ordinary dispatch', async t => {
  const r = await rig(t); r.row('archived', r.root, 10, { archived: true })
  const params = { id: 'fixture:archived', text: 'Continue' }; r.authorize('lead/chat/send', params)
  await assert.rejects(r.service.send(params), /scope|project|session/i)
  assert.equal((await r.service.read({ id: params.id })).id, params.id)
  r.row('own'); r.onCwd(async () => { r.withdraw() }); r.authorize('lead/chat/stop', { id: 'fixture:own' })
  await assert.rejects(r.service.stop({ id: 'fixture:own' }), /project|scope/i)
  assert.equal(r.calls.length, 1, 'only the archive read reached the ordinary surface')
})

test('the independent host gate refuses unknown or exhausted budget but permits stop as a narrowing action', async t => {
  const r = await rig(t); r.row('own')
  r.authorize('lead/chat/start', { text: 'Do work' })
  r.setState({ budget: null })
  await assert.rejects(r.service.start({ text: 'Do work' }), /budget/i)
  const budget = reduceLeadBudget(null, { version: 1, type: 'initialize', logicalGoalId: 'goal', now: 100, freshnessMs: 60000, caps: { usdMicros: 10000, rounds: 3 } })
  r.setState({ budget: { ...budget, stop: { reason: 'budget', revision: 1 } } })
  r.authorize('lead/chat/start', { text: 'Do work' })
  await assert.rejects(r.service.start({ text: 'Do work' }), /budget/i)
  r.authorize('lead/chat/stop', { id: 'fixture:own' })
  await r.service.stop({ id: 'fixture:own' })
  assert.deepEqual(r.calls.map(call => call.method), ['stop'])
})

test('prior uncertain mutation and recovery independently prevent new chat dispatch', async t => {
  const r = await rig(t); r.row('own')
  const prior = r.authorize('lead/chat/start', { text: 'Earlier' })
  r.authorize('lead/chat/send', { id: 'fixture:own', text: 'Continue' })
  const attempts = new Map(r.state().attempts)
  attempts.set(prior, { ...attempts.get(prior)!, outcome: 'uncertain' })
  r.setState({ attempts })
  await assert.rejects(r.service.send({ id: 'fixture:own', text: 'Continue' }), /recovery/i)
  r.setState({ attempts: new Map([...attempts].filter(([id]) => id !== prior)), recoveryBlocked: true })
  r.authorize('lead/chat/send', { id: 'fixture:own', text: 'Continue' })
  await assert.rejects(r.service.send({ id: 'fixture:own', text: 'Continue' }), /recovery/i)
  assert.equal(r.calls.length, 0)
})


test('ordinary chat activity emits meaningful scoped state transitions once without transcript output', async t => {
  const r = await rig(t); r.row('own'); r.row('foreign', r.foreign)
  assert.equal(typeof r.service.changed, 'function', 'Ordinary delegation must be able to observe session completion')
  await r.service.read({ id: 'fixture:own' })
  r.setLive({ running: true, waiting: false })
  await r.service.changed(runtimeId('fixture'), sessionId('own'))
  await r.service.changed(runtimeId('fixture'), sessionId('own'))
  await r.service.changed(runtimeId('fixture'), sessionId('foreign'))
  r.setLive({ running: true, waiting: true }); await r.service.changed(runtimeId('fixture'), sessionId('own'))
  r.setLive({ running: false, waiting: false }); await r.service.changed(runtimeId('fixture'), sessionId('own'))
  assert.deepEqual(r.published, ['running', 'waiting', 'idle'].map(state => ({ id: 'fixture:own', project: r.root, state })))
  assert.equal(await r.service.canRead('fixture:own'), true)
  assert.equal(await r.service.canRead('fixture:foreign'), false)
})


test('a fast chat turn preserves running and idle transitions across asynchronous scope checks', async t => {
  const r = await rig(t); r.row('own'); await r.service.read({ id: 'fixture:own' })
  r.setLive({ running: true, waiting: false }); const started = r.service.changed(runtimeId('fixture'), sessionId('own'))
  r.setLive({ running: false, waiting: false }); const finished = r.service.changed(runtimeId('fixture'), sessionId('own'))
  await Promise.all([started, finished])
  assert.deepEqual(r.published.map(event => event.state), ['running', 'idle'])
})

test('a refused host admission consumes its durable attempt before scope or policy correction', async t => {
  const r = await rig(t); r.row('own')
  const params = { id: 'fixture:own', text: 'Continue' }
  r.authorize('lead/chat/send', params)
  r.setState({ policy: { version: 1, revision: 2, mode: 'plan', rules: [] } })
  await assert.rejects(r.service.send(params), /mode|read/i)
  r.setState({ policy: { version: 1, revision: 3, mode: 'manage', rules: [] } })
  await assert.rejects(r.service.send(params), /attempt|consumed/i)
  assert.equal(r.calls.length, 0)
  r.authorize('lead/chat/send', params)
  await r.service.send(params)
  assert.equal(r.calls.length, 1)
})

test('final queued admission ignores healthy dispatch but preserves every unresolved-effect fence', async t => {
  const r = await rig(t); r.row('own')
  const params = { id: 'fixture:own', text: 'Continue' }
  const own = r.authorize('lead/chat/send', params)
  await r.service.send(params)
  const other = r.authorize('lead/chat/start', { text: 'Other task' })
  const healthy = r.state()
  await r.queuedScope()(r.root)
  for (const id of [own, other]) for (const change of [
    { outcome: 'uncertain' as const }, { resolutionPending: true }, { contested: true },
  ]) {
    const attempts = new Map(healthy.attempts)
    attempts.set(id, { ...attempts.get(id)!, ...change })
    r.setState({ attempts })
    await assert.rejects(r.queuedScope()(r.root), /recovery/i)
  }
  r.setState(healthy)
  for (const change of [{ recoveryBlocked: true }, { stopEffectsPending: 1 }, { phase: 'stopped' as const }]) {
    r.setState(change)
    await assert.rejects(r.queuedScope()(r.root), /recovery/i)
    r.setState(healthy)
  }
})
