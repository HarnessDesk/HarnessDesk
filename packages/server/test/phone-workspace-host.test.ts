import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { approvalId, itemId, runtimeId, sessionId, turnId, usageCrossingKey, type Session, type SessionSummary } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { SessionIndex } from '../src/session-index.js'
import { StateStore } from '../src/state.js'
import { createChatFolder, rememberChatFolder } from '../src/chats.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/** A real host over a fake agent and an index seeded the way a desk's own is, asked the phone's way. */
const desk = async (t: TestContext, bulk = false, interrupt = true, startTimes?: boolean, metered = false, deleteHistory: false | 'trash' | 'erase' = 'trash') => {
  const root = tempDir('hd-phone-host-')
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false, interrupt, metered, deleteHistory, ...(startTimes === undefined ? {} : { startTimes }) } })
  const row = (id: string, over: Partial<SessionSummary>): SessionSummary =>
    ({ runtime: runtime.info.id, id: sessionId(id), title: id, cwd: join(root, 'acme-api'), createdAt: 10, updatedAt: 20, status: { type: 'notLoaded' }, archived: false, ...over })
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.upsert(row('priced', { title: `Fix the sign-in for dev@example.com in ${root}/acme-api/src/auth.ts`, updatedAt: 30 }), { archived: false })
  index.upsert(row('free', { title: 'Tidy the settings page', updatedAt: 20 }), { archived: false })
  index.upsert(row('shelved', { title: 'Old idea', updatedAt: 10 }), { archived: true })
  index.upsert(row('seat', { title: 'A Team seat', updatedAt: 40 }), { archived: false, teamId: 'team-1' })
  index.upsert(row('removed', {}), { archived: false })
  index.remove(runtime.info.id, sessionId('removed'))
  if (bulk) {
    for (let i = 0; i < 196; i++) index.upsert(row(`bulk-${i}`, { updatedAt: 50 + Math.floor(i / 3) }), { archived: false })
    for (let i = 0; i < 12; i++) index.upsert(row(`old-${i}`, { updatedAt: 5 }), { archived: true })
  }
  index.close()
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  db.prepare('UPDATE sessions SET usage=? WHERE id=?').run(JSON.stringify({ total: { totalTokens: 5 }, last: { totalTokens: 5 }, cost: { amount: 0.75, currency: 'USD' } }), 'priced')
  db.close()
  // The price catalogue the ledger would otherwise fetch from the network: cached, fresh and empty.
  await mkdir(join(root, 'cache'), { recursive: true })
  await writeFile(join(root, 'cache', 'model-pricing.json'), JSON.stringify({ fetchedAt: Date.now(), catalogue: {} }))
  const state = new StateStore(join(root, 'state.json'))
  const host = new Host({ state, logger: silent, builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') })
  host.register(runtime)
  await host.start()
  t.after(() => host.dispose())
  return { host, root, runtime, state }
}

// The phone uses these request names at the host boundary, rather than invoking projection internals.
const phoneCall = (host: Host, method: string, params: unknown): Promise<any> => host.call(method as never, params as never)

test('the phone hears when a session began only from an agent that records starts', async t => {
  const startOf = async (startTimes?: boolean) => {
    const { host } = await desk(t, false, true, startTimes)
    const page = await phoneCall(host, 'workspace/sessions/list', { limit: 50 })
    return page.items.find((item: any) => item.title === 'Tidy the settings page')?.startedAt
  }
  assert.equal(await startOf(true), 10, 'a measured start is passed on')
  assert.equal(await startOf(false), undefined, 'an agent that lists only its last activity gives no start')
  assert.equal(await startOf(), undefined, 'and neither does one that does not say')
})

test('phone workspace pages cover all 198 active sessions and the archive, without duplicates or Team seats', async t => {
  const { host, runtime } = await desk(t, true)
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = await phoneCall(host, 'workspace/sessions/list', { limit: 37, ...(cursor ? { cursor } : {}) })
    assert.ok(page.items.length <= 37)
    assert.ok(page.items.every((item: any) => item.kind === 'session' && !item.archived))
    ids.push(...page.items.map((item: any) => item.id))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(ids.length, 198)
  assert.equal(new Set(ids).size, 198)
  assert.ok(ids.includes(`${runtime.info.id}:free`))
  const archiveIds: string[] = []
  do {
    const page = await phoneCall(host, 'workspace/sessions/list', { archived: true, limit: 5, ...(cursor ? { cursor } : {}) })
    assert.ok(page.items.every((item: any) => item.archived === true))
    archiveIds.push(...page.items.map((item: any) => item.id))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(archiveIds.length, 13)
  assert.equal(new Set([...ids, ...archiveIds]).size, 211)
  assert.ok(archiveIds.includes(`${runtime.info.id}:shelved`))
  const first = await phoneCall(host, 'workspace/sessions/list', { limit: 2 })
  await assert.rejects(phoneCall(host, 'workspace/sessions/list', { archived: true, cursor: first.nextCursor }), /Invalid session index cursor/)
})

test('phone reads archived transcripts while refusing archived, Team, removed and unknown mutation targets', async t => {
  const { host, root, runtime } = await desk(t)
  runtime.minted.set('shelved', join(root, 'acme-api'))
  assert.equal((await host.call('workspace/thread/read', { id: `${runtime.info.id}:shelved` })).title, 'Old idea')
  for (const target of ['shelved', 'seat', 'removed', 'unknown']) {
    for (const method of ['workspace/session/send', 'workspace/stop']) {
      await assert.rejects(phoneCall(host, method, { id: `${runtime.info.id}:${target}`, ...(method.endsWith('send') ? { text: 'Hello' } : {}) }), /archived|not a session this desk can show/, `${method} ${target}`)
    }
  }
  for (const target of ['seat', 'removed', 'unknown']) await assert.rejects(host.call('workspace/thread/read', { id: `${runtime.info.id}:${target}` }), /not a session this desk can show/)
})

test('phone starts on the preferred runtime and sends and interrupts through the real host without changing defaults', async t => {
  const { host, root, runtime, state } = await desk(t)
  const preferred = new FakeRuntime({ id: runtimeId('preferred') })
  host.register(preferred)
  await state.setPreferences({ activeRuntime: preferred.info.id })
  await state.setPreferences({ chatsFolder: join(root, 'chats') })
  const messages: string[] = []
  preferred.onSend = (live, text) => { messages.push(text); live.finish() }
  const created = await phoneCall(host, 'workspace/session/start', { text: '  Start the importer\n' })
  assert.match(created.id, /^preferred:/)
  assert.deepEqual(messages, ['  Start the importer\n'])
  assert.equal(runtime.lastCreateOptions, null)
  assert.ok(preferred.lastCreateOptions?.cwd.startsWith(join(root, 'chats')))
  for (const hidden of ['model', 'effort', 'requestedCeiling', 'permissions', 'fast', 'plan']) assert.ok(!(hidden in preferred.lastCreateOptions!))
  await phoneCall(host, 'workspace/session/send', { id: created.id, text: 'Keep the text\n' })
  assert.deepEqual(messages, ['  Start the importer\n', 'Keep the text\n'])
  preferred.onSend = null
  await phoneCall(host, 'workspace/session/send', { id: created.id, text: 'Work until stopped' })
  assert.equal((await host.call('workspace/thread/read', { id: created.id })).status, 'running')
  assert.deepEqual(await phoneCall(host, 'workspace/stop', { id: created.id }), {})
  assert.equal((await host.call('workspace/thread/read', { id: created.id })).status, 'done')
})

test('phone starts use the desktop opening-message name in the list and header without renaming the agent history', async t => {
  const { host, root, runtime, state } = await desk(t)
  await state.setPreferences({ chatsFolder: join(root, 'chats') })
  runtime.onSend = live => live.finish()
  const created = await host.call('workspace/session/start', { text: '  Fix /Users/jane/proj/src/a.ts for dev@example.com TOKEN=placeholder\nIgnore this second line' })
  assert.ok(!created.problem)
  const expected = 'Fix … for … TOKEN=…'
  const item = (await host.call('workspace/read', {})).items.find(item => item.id === created.id)
  assert.equal(item?.title, expected)
  const page = await host.call('workspace/sessions/list', {})
  assert.equal(page.items.find(item => item.id === created.id)?.title, expected)
  assert.equal((await host.call('workspace/thread/read', { id: created.id })).title, expected)
  await host.call('workspace/session/send', { id: created.id, text: 'A different follow-up' })
  assert.equal((await host.call('workspace/thread/read', { id: created.id })).title, expected)
  const id = sessionId(created.id.slice(created.id.indexOf(':') + 1))
  assert.equal(runtime.sessions.get(id)?.title, null, 'the opening is a display fallback, as on the desktop')
  await host.call('session/setTitle', { runtime: runtime.info.id, sessionId: id, title: 'Chosen title' })
  assert.equal((await host.call('workspace/read', {})).items.find(item => item.id === created.id)?.title, 'Chosen title')
  assert.equal((await host.call('workspace/thread/read', { id: created.id })).title, 'Chosen title')
  const long = await host.call('workspace/session/start', { text: 'Fix the importer '.repeat(30) })
  const longTitle = (await host.call('workspace/thread/read', { id: long.id })).title
  assert.ok(longTitle.length <= 120)
  assert.ok(longTitle.endsWith('…'))
  assert.equal((await host.call('workspace/read', {})).items.find(item => item.id === long.id)?.title, longTitle)
})

test('phone project selection accepts a known displayed name and refuses unknown or ambiguous names', async t => {
  const { host, root, runtime, state } = await desk(t)
  const project = join(root, 'acme-api')
  await mkdir(project, { recursive: true })
  await state.touchWorkspace({ path: project, name: 'acme-api', lastOpenedAt: 1 })
  await state.setPreferences({ activeRuntime: 'removed-agent' })
  await phoneCall(host, 'workspace/session/start', { text: 'Hello', project: 'acme-api' })
  assert.equal(runtime.lastCreateOptions?.cwd, project)
  await assert.rejects(phoneCall(host, 'workspace/session/start', { text: 'Hello', project: 'missing' }), /project.*available|known project/i)
  await assert.rejects(phoneCall(host, 'workspace/session/start', { text: 'Hello', project }), /project.*available|known project/i)
  await state.touchWorkspace({ path: join(root, 'other', 'acme-api'), name: 'acme-api', lastOpenedAt: 2 })
  await assert.rejects(phoneCall(host, 'workspace/session/start', { text: 'Hello', project: 'acme-api' }), /more than one|ambiguous/i)
})

test('phone stop refuses a runtime that does not support interrupt', async t => {
  const { host, runtime } = await desk(t, false, false)
  await assert.rejects(phoneCall(host, 'workspace/stop', { id: `${runtime.info.id}:priced` }), /cannot stop|does not support/i)
})

test('the host lists the person’s own sessions for a phone, priced by the desk and named by the agent’s own presentation', async t => {
  const { host, root, runtime } = await desk(t)
  const list = await host.call('phone/sessions/list', {})
  assert.deepEqual(list.rows.map(one => [one.id, one.state, one.cost, one.seat]), [
    [`${runtime.info.id}:priced`, 'done', 0.75, runtime.info.presentation.name],
    [`${runtime.info.id}:free`, 'done', null, runtime.info.presentation.name],
  ])
  assert.equal(list.rows[0]!.title, 'Fix the sign-in for … in …')
  assert.deepEqual(list.counts, { running: 0, needsYou: 0, done: 2, archived: 1 })
  assert.equal(list.next, null)
  const text = JSON.stringify(list)
  assert.ok(!text.includes(root), 'no path of the desk’s own leaves in a response')
  assert.ok(!text.includes('@'))
  assert.deepEqual((await host.call('phone/sessions/list', { state: 'archived' })).rows.map(one => one.title), ['Old idea'])
})

test('the host answers an empty Teams list for a desk with no Team', async t => {
  const { host } = await desk(t)
  assert.deepEqual(await host.call('phone/teams/list', {}), { rows: [] })
})

test('the host answers the phone’s snapshot of the work in the phone’s own units, without a path or an address', async t => {
  const { host, root, runtime } = await desk(t)
  const snapshot = await host.call('workspace/read', {})
  assert.deepEqual(snapshot.items.map(one => [one.id, one.kind, one.phase, one.line, one.cost, one.agent]), [
    [`${runtime.info.id}:priced`, 'session', 'done', 'Done', { micros: 750_000 }, { name: runtime.info.presentation.name }],
    [`${runtime.info.id}:free`, 'session', 'done', 'Done', undefined, { name: runtime.info.presentation.name }],
  ])
  assert.ok(snapshot.items.every(item => item.canDelete === (runtime.info.capabilities.deleteHistory === 'trash')))
  assert.equal(snapshot.items[0]!.title, 'Fix the sign-in for … in …')
  assert.equal(snapshot.items[0]!.project, undefined, 'a folder that is no repository names no project, in the list or in the conversation')
  assert.equal(snapshot.deskName, 'Desk')
  assert.deepEqual(snapshot.capabilities, { startSession: true, startTeam: false, reply: true, stop: true, delete: runtime.info.capabilities.deleteHistory === 'trash', rename: true, archive: true, pin: true, chooseModel: true, chooseAgent: false, choosePermissions: false, attach: false, undo: false, decide: true })
  assert.deepEqual(snapshot.models.map(model => model.id), runtime.models.map(model => model.id))
  // The desk starts its default agent in the background; once it answers it is listed with its own models.
  const ready = await host.call('workspace/read', {})
  assert.deepEqual(ready.agents?.map(agent => [agent.id, agent.name, agent.default, agent.models.map(model => model.id)]), [[String(runtime.info.id), runtime.info.presentation.name, true, runtime.models.map(model => model.id)]])
  assert.deepEqual([snapshot.flows, snapshot.commands, snapshot.threads], [[], [], []])
  // The usage scan may or may not have finished; when it has, it is seven days and no account.
  if (snapshot.usage) assert.equal(snapshot.usage.days.length, 7)
  const text = JSON.stringify(snapshot)
  assert.ok(!text.includes(root), 'no path of the desk’s own leaves in a response')
  assert.ok(!text.includes('@'))
})

test('the host reads one conversation for the phone as what was said and done, and nothing of the machine', async t => {
  const { host, root, runtime } = await desk(t)
  const cwd = join(root, 'acme-api')
  runtime.minted.set('priced', cwd)
  runtime.stored.set('priced', [{
    id: turnId('t1'), status: 'completed',
    items: [
      { id: itemId('u1'), type: 'userMessage', content: [{ type: 'text', text: `Fix ${cwd}/src/auth.ts for dev@example.com` }] },
      { id: itemId('c1'), type: 'command', command: 'pnpm test', cwd, origin: 'agent', status: 'completed', actions: [], output: `${cwd}/src/auth.ts failed`, exitCode: 0 },
      { id: itemId('a1'), type: 'assistantMessage', text: `All green in ${cwd}/src.`, phase: 'final' },
    ],
  }] as Session['turns'])
  const thread = await host.call('workspace/thread/read', { id: `${runtime.info.id}:priced` })
  assert.equal(thread.title, 'Fix the sign-in for … in …')
  assert.equal(thread.project, undefined)
  assert.equal(thread.status, 'done')
  assert.deepEqual(thread.turns.map(turn => turn.type), ['you', 'work', 'agent'])
  const text = JSON.stringify(thread)
  assert.ok(!text.includes(root), 'no path of the desk’s own leaves in a response')
  assert.ok(!text.includes('@'))
  assert.ok(text.includes('auth.ts failed'), 'the scrubbed output tail reaches the phone')

  for (const id of [`${runtime.info.id}:seat`, `${runtime.info.id}:nope`, 'nope']) {
    await assert.rejects(host.call('workspace/thread/read', { id }), /not a session this desk can show/, id)
  }
})

test('the host lets a phone answer an approval through the window’s own path, and shows what it answered', async t => {
  const { host, root, runtime } = await desk(t)
  const created = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: join(root, 'acme-api') } })
  const id = `${runtime.info.id}:${created.id}`
  const live = runtime.sessions.get(created.id)!

  const asked = live.askApproval(approvalId('ap-deny'))
  const waiting = await host.call('workspace/thread/read', { id })
  assert.equal(waiting.status, 'asksYou')
  const turn = waiting.turns.at(-1)!
  assert.deepEqual(turn.type === 'approval' ? [turn.id, turn.state, turn.highRisk, turn.command, 'sessionGrant' in turn] : null, ['ap-deny', 'pending', true, 'rm -rf build', false])
  assert.equal((await host.call('workspace/read', {})).items.find(one => one.id === id)?.phase, 'needsYou')

  await assert.rejects(host.call('workspace/approval/decide', { id: 'ap-deny', session: id, allow: true, scope: 'session' }), /cannot be allowed for the whole session/)
  await assert.rejects(host.call('workspace/approval/decide', { id: 'unknown', session: id, allow: false }), /not waiting any more/)
  assert.deepEqual(await host.call('workspace/approval/decide', { id: 'ap-deny', session: id, allow: false, scope: 'once' }), {})
  assert.deepEqual(await asked, { type: 'option', optionId: 'opt-1' })
  const after = await host.call('workspace/thread/read', { id })
  assert.equal(after.status, 'done')
  assert.deepEqual(after.turns.map(one => one.type === 'approval' ? [one.id, one.state] : one.type), [['ap-deny', 'denied']])

  const allowed = live.askApproval(approvalId('ap-once'))
  await host.call('workspace/approval/decide', { id: 'ap-once', session: id, allow: true })
  assert.deepEqual(await allowed, { type: 'option', optionId: 'opt-0' })
})


test('phone replies queue behind a running turn', { timeout: 10000 }, async t => {
  const { host, runtime } = await desk(t)
  runtime.refusesWhileBusy = true
  const messages: string[] = []
  let finishQueued!: () => void
  const queued = new Promise<void>(resolve => { finishQueued = resolve })
  runtime.onSend = (live, text) => {
    messages.push(text)
    if (text === 'Second') { live.finish(); finishQueued() }
  }
  const created = await host.call('workspace/session/start', { text: 'First' })
  await host.call('workspace/session/send', { id: created.id, text: 'Second' })
  assert.deepEqual(messages, ['First'])
  const record = host.registry.get(runtime.info.id, sessionId(created.id.split(':').slice(1).join(':')))!
  assert.equal(record.queue.messages.length, 1)
  runtime.sessions.get(record.session.id)!.finish()
  await queued
  assert.deepEqual(messages, ['First', 'Second'])
})

test('phone starts honor saved runtime options and refuse obsolete saved choices', async t => {
  const { host, runtime, state } = await desk(t)
  await state.setPreferences({ draftValues: { [runtime.info.id]: { model: 'fake-2', tone: 'cheerful', uppercase: true } } })
  await host.call('workspace/session/start', { text: 'Saved settings' })
  assert.deepEqual(runtime.lastCreateOptions?.options, { model: 'fake-2', tone: 'cheerful', uppercase: true })
  const count = runtime.sessions.size
  await state.setPreferences({ draftValues: { [runtime.info.id]: { model: 'gone' } } })
  await assert.rejects(host.call('workspace/session/start', { text: 'Refuse stale defaults' }), /saved|option|model/i)
  assert.equal(runtime.sessions.size, count)
})

test('phone project names follow repository metadata while live cwd alone grants no project', async t => {
  const { host, runtime, root, state } = await desk(t)
  const repository = join(root, 'acme-api'), admitted = join(repository, 'packages', 'web')
  await mkdir(admitted, { recursive: true })
  await state.touchWorkspace({ path: admitted, name: 'web', lastOpenedAt: 1 })
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.putRepo(admitted, { repo: { root: repository, worktree: false }, exists: true, checkedAt: Date.now() })
  index.close()
  await host.call('workspace/session/start', { text: 'Use displayed repository', project: 'acme-api' })
  assert.equal(runtime.lastCreateOptions?.cwd, admitted)
  await host.call('session/create', { runtime: runtime.info.id, options: { cwd: join(root, 'unadmitted-seat') } })
  await assert.rejects(host.call('workspace/session/start', { text: 'No', project: 'unadmitted-seat' }), /not available/i)
})

test('phone stop on an idle indexed session does not reopen an agent handle', async t => {
  const { host, runtime } = await desk(t)
  assert.equal(runtime.sessions.size, 0)
  assert.deepEqual(await host.call('workspace/stop', { id: `${runtime.info.id}:priced` }), {})
  assert.equal(runtime.sessions.size, 0)
})


test('phone reply opens a cold indexed session before entering the ordinary queue', async t => {
  const { host, runtime, root } = await desk(t)
  runtime.minted.set('priced', join(root, 'acme-api'))
  const messages: string[] = []
  runtime.onSend = (live, text) => { messages.push(text); live.finish() }
  await host.call('workspace/session/send', { id: `${runtime.info.id}:priced`, text: 'Reply to the older session' })
  assert.deepEqual(messages, ['Reply to the older session'])
})

for (const method of ['workspace/session/send', 'workspace/thread/read']) test(`removing a session during cold ${method} keeps the removal authoritative`, { timeout: 10000 }, async t => {
  const { host, runtime, root } = await desk(t)
  const id = sessionId('priced')
  runtime.minted.set(id, join(root, 'acme-api'))
  let readStarted!: () => void
  let releaseRead!: () => void
  const started = new Promise<void>(resolve => { readStarted = resolve })
  const release = new Promise<void>(resolve => { releaseRead = resolve })
  const read = runtime.readSession.bind(runtime)
  runtime.readSession = async target => {
    const transcript = await read(target)
    readStarted()
    await release
    return transcript
  }
  const messages: string[] = []
  runtime.onSend = (live, text) => { messages.push(text); live.finish() }
  const reply = phoneCall(host, method, { id: `${runtime.info.id}:${id}`, ...(method.endsWith('send') ? { text: 'Do not restore me' } : {}) })
  const refusal = assert.rejects(reply, /not a session this desk can show/)
  await started
  await host.call('session/remove', { runtime: runtime.info.id, sessionId: id, removed: true })
  releaseRead()
  await refusal
  assert.deepEqual(messages, [])
  assert.equal(host.registry.get(runtime.info.id, id)?.queue.messages.length ?? 0, 0)
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  try { assert.ok(db.prepare('SELECT removed_at FROM sessions WHERE runtime=? AND id=?').get(runtime.info.id, id)?.removed_at != null) }
  finally { db.close() }
})


test('phone replies refuse a paused queue after interruption or failure without appending another message', async t => {
  for (const end of ['stop', 'failure']) {
    const { host, runtime } = await desk(t)
    const created = await host.call('workspace/session/start', { text: 'First' })
    const id = sessionId(created.id.split(':').slice(1).join(':'))
    assert.deepEqual(await host.call('workspace/session/send', { id: created.id, text: 'Queued reply' }), { queued: true })
    if (end === 'stop') assert.deepEqual(await host.call('workspace/stop', { id: created.id }), { queued: true })
    else runtime.sessions.get(id)!.fail('Synthetic runtime failure')
    const record = host.registry.get(runtime.info.id, id)!
    assert.equal(record.queue.status, 'paused')
    const count = record.queue.messages.length
    await assert.rejects(host.call('workspace/session/send', { id: created.id, text: 'Keep this new draft' }), /paused.*desk/i)
    assert.equal(record.queue.messages.length, count)
  }
})

for (const operation of ['snapshot', 'start'] as const) test(`phone ${operation} starts a cold runtime before reading its model catalogue`, async t => {
  const { host, root, state } = await desk(t)
  class ColdModelsRuntime extends FakeRuntime {
    override async listModels() {
      if (this.health().state !== 'ready') throw new Error('Models are not known yet; start the runtime first.')
      return super.listModels()
    }
  }
  const runtime = new ColdModelsRuntime({ id: runtimeId(`cold-${operation}`) })
  host.register(runtime)
  await state.setPreferences({ activeRuntime: runtime.info.id, chatsFolder: join(root, 'chats') })
  runtime.onSend = live => live.finish()
  if (operation === 'snapshot') {
    const snapshot = await host.call('workspace/read', {})
    assert.equal(snapshot.capabilities.chooseModel, true)
    assert.equal(snapshot.models[0]!.id, 'fake-1')
  } else {
    const result = await host.call('workspace/session/start', { text: 'Hello', model: 'fake-1' })
    assert.equal(result.problem, undefined)
    assert.ok(result.id.startsWith(`${runtime.info.id}:`))
  }
  assert.equal(runtime.health().state, 'ready')
})

test('a phone snapshot lists an idle agent without starting it, and a start on that agent does', async t => {
  const { host, root, runtime, state } = await desk(t)
  const calls: string[] = []
  class IdleRuntime extends FakeRuntime {
    override async start() { calls.push('start'); return super.start() }
    override async listModels() { calls.push('models'); return super.listModels() }
  }
  const idle = new IdleRuntime({ id: runtimeId('idle-agent') })
  host.register(idle)
  idle.setHealth({ state: 'idle' })
  idle.onSend = live => live.finish()
  await state.setPreferences({ activeRuntime: runtime.info.id, chatsFolder: join(root, 'chats') })
  await host.call('workspace/read', {})
  const snapshot = await host.call('workspace/read', {})
  assert.deepEqual(snapshot.agents?.find(agent => agent.id === 'idle-agent'), { id: 'idle-agent', name: idle.info.presentation.name, models: [] })
  assert.equal(snapshot.capabilities.chooseAgent, true)
  assert.deepEqual(calls, [], 'no start and no model read for an agent that is not running')
  const started = await host.call('workspace/session/start', { text: 'Hello', agent: 'idle-agent', model: 'fake-1' })
  assert.equal(started.problem, undefined)
  assert.ok(started.id.startsWith('idle-agent:'))
  assert.equal(calls[0], 'start')
})

test('a phone offers the admitted projects to start in, never a folder the host made for a no-folder chat', async t => {
  const { host, root, state } = await desk(t)
  const project = join(root, 'acme-api')
  await mkdir(project, { recursive: true })
  await state.touchWorkspace({ path: project, name: 'acme-api', lastOpenedAt: 1 })
  const chat = await createChatFolder(state)
  await rememberChatFolder(state, chat)
  await state.touchWorkspace({ path: chat, name: 'chat', lastOpenedAt: 2 })
  assert.equal(state.state.workspaces.length, 2)
  const snapshot = await phoneCall(host, 'workspace/read', {})
  assert.deepEqual(snapshot.projects, ['acme-api'])
  assert.ok(!JSON.stringify(snapshot.projects).includes(root))
})

test('Lead allowance uses only cached Dashboard reports and never asks a runtime', async t => {
  const { host, runtime } = await desk(t, false, true, undefined, true)
  // Populate the same cache the Dashboard uses, through a scripted runtime only.
  await host.call('usage/reports', {})
  let calls = 0
  runtime.getRateLimits = async () => { calls++; throw new Error('Lead must not refresh allowance') }
  const result = await host.call('lead/usage/summary', {})
  assert.equal(calls, 0)
  assert.equal(typeof result.asOf, 'number')
  assert.equal(result.accounts.length, 1)
  assert.equal(result.accounts[0]!.windows[0]!.remaining, 42)
})

test('the Lead and the phone list the accounts the Dashboard lists: nothing read is Not reporting, a stopped agent is left out', async t => {
  // Not metered: the scripted agent reports no allowance, as an agent nobody can read does.
  const { host, runtime, state } = await desk(t)
  // Straight after a start nothing has been read: an empty cache is not an agent that says nothing (#2111 review).
  assert.deepEqual((await host.call('lead/usage/summary', {})).accounts, [])
  await host.call('usage/reports', {})
  const summary = await host.call('lead/usage/summary', {})
  assert.deepEqual(summary.accounts.map(account => [account.runtime, account.notReporting, account.windows.length]), [[runtime.info.presentation.name, true, 0]])
  const usage = (await phoneCall(host, 'workspace/read', {})).usage
  if (usage) assert.deepEqual(usage.runtimes.map((row: any) => [row.name, row.status, row.notReporting, row.readAt]), [[runtime.info.presentation.name, 'Not reporting', true, undefined]])
  // Stopped tracking on the desk: no surface lists it any more.
  await state.setPreferences({ usageOff: [runtime.info.id] })
  assert.deepEqual((await host.call('lead/usage/summary', {})).accounts, [])
})

test('the bell and the phone drop an allowance notice a newer read no longer bears out (#2111)', async t => {
  const { host, state, runtime } = await desk(t, false, true, undefined, true)
  const resetsAt = Date.now() + 4 * 24 * 3_600_000
  runtime.getRateLimits = async () => ({ lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 60, windowMinutes: 7 * 24 * 60, resetsAt }] })
  const read = (await host.call('usage/reports', {})).find(one => one.lanes.some(lane => lane.usageKnown !== false))
  const lane = read!.lanes.find(one => one.usageKnown !== false)!
  assert.ok(lane.usedPercent >= 50 && lane.usedPercent < 80, `the scripted reading sits between the two lines (${lane.usedPercent}%)`)
  const crossed = (threshold: number) => usageCrossingKey({ runtime: read!.runtime, account: read!.account, lane: lane.id, resetsAt: lane.resetsAt, threshold })
  const notice = (id: string, title: string) => ({ id, contentKey: id, kind: 'usage:crossing', title, tone: 'warning', at: read!.fetchedAt - 3 * 24 * 3_600_000, read: false })
  // Three days old: one says a line the newer read is under, one says a line it is still over.
  // From before notices carried figures: one names this agent, which has been read since; one names an agent that has not.
  const legacy = (id: string, title: string) => ({ id, kind: 'usage:crossing', title, tone: 'warning', at: read!.fetchedAt - 3 * 24 * 3_600_000, read: false })
  await state.setPreferences({ inbox: [notice(crossed(80), 'Weekly is 80% used'), notice(crossed(50), 'Weekly is 50% used'),
    legacy('old-own', `${runtime.info.presentation.name} — Weekly is 80% used.`), legacy('old-other', 'Another agent — Weekly is 80% used.')] })
  const items = (await host.call('lead/inbox/read', {})).items.filter(item => item.kind === 'notice')
  assert.deepEqual(items.map(item => item.title).sort(), ['Another agent — Weekly is 80% used.', 'Weekly is 50% used'])
})

for (const capability of [false, 'erase', 'trash'] as const) test(`phone rows follow runtime deletion capability: ${capability}`, async t => {
  const { host } = await desk(t, false, true, undefined, false, capability)
  const snapshot = await host.call('workspace/read', {})
  assert.equal(snapshot.capabilities.delete, capability === 'trash')
  assert.ok(snapshot.items.every(item => item.canDelete === (capability === 'trash')))
  const rows = await host.call('phone/sessions/list', {})
  assert.ok(rows.rows.every(row => row.canDelete === (capability === 'trash')))
})

test('desk transcript reads and background attachment do not mark a conversation opened', async t => {
  const { host, runtime, root } = await desk(t)
  const id = sessionId('priced')
  runtime.minted.set(id, join(root, 'acme-api'))
  const indexed = async () => (await host.call('session/index', {})).data.find(row => row.id === id)!
  assert.equal((await indexed()).lastOpenedAt ?? 0, 0)
  await host.call('session/read', { runtime: runtime.info.id, sessionId: id })
  assert.equal((await indexed()).lastOpenedAt ?? 0, 0)
  await host.call('session/resume', { runtime: runtime.info.id, sessionId: id })
  assert.equal((await indexed()).lastOpenedAt ?? 0, 0)
  await host.call('session/opened', { runtime: runtime.info.id, sessionId: id })
  assert.ok((await indexed()).lastOpenedAt! > 0)
})

test('host migrates only existing pins after seeding and clears the legacy preference', async t => {
  const root = tempDir('hd-pin-migration-')
  const state = new StateStore(join(root, 'state.json'))
  await state.load()
  await state.setPreferences({ listPrefs: { sort: 'name', pinnedSessions: ['fake:kept', 'fake:seeded', 'fake:missing'] } })
  await mkdir(join(root, 'transcripts', 'fake'), { recursive: true })
  await writeFile(join(root, 'transcripts', 'fake', 'seeded.json'), JSON.stringify({ version: 1, runtime: 'fake', id: 'seeded', savedAt: 1, turns: [] }))
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.upsert({ runtime: runtimeId('fake'), id: sessionId('kept'), cwd: root, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 })
  index.close()
  const host = new Host({ state, logger: silent, builtinAgents: root, catalogRefreshMs: 0 })
  host.register(new FakeRuntime())
  t.after(() => host.dispose())
  await host.start()
  const deadline = Date.now() + 5_000
  while (Object.hasOwn(state.state.preferences['listPrefs'] as object, 'pinnedSessions')) {
    assert.ok(Date.now() < deadline, 'migration finishes after the index seed')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(await host.call('session/pins', {}), ['fake:kept', 'fake:seeded'])
  assert.deepEqual(state.state.preferences['listPrefs'], { sort: 'name' })
  const savedList = async () => {
    const saved = new StateStore(join(root, 'state.json'))
    await saved.load()
    return saved.state.preferences['listPrefs'] as object
  }
  let persisted = await savedList()
  while (Object.hasOwn(persisted, 'pinnedSessions')) {
    assert.ok(Date.now() < deadline, 'legacy pins are removed from durable preferences')
    await new Promise(resolve => setTimeout(resolve, 10))
    persisted = await savedList()
  }
  assert.deepEqual(persisted, { sort: 'name' })
})

test('legacy pins survive a list preference write during the index seed', async t => {
  const root = tempDir('hd-pin-race-')
  const state = new StateStore(join(root, 'state.json'))
  await state.load()
  await state.setPreferences({ listPrefs: { sort: 'name', pinnedSessions: ['fake:kept', 'fake:unpin', 'fake:seeded'] } })
  await mkdir(join(root, 'transcripts', 'fake'), { recursive: true })
  await writeFile(join(root, 'transcripts', 'fake', 'seeded.json'), JSON.stringify({ version: 1, runtime: 'fake', id: 'seeded', savedAt: 1, turns: [] }))
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  for (const id of ['kept', 'unpin', 'new']) index.upsert({ runtime: runtimeId('fake'), id: sessionId(id), cwd: root, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 })
  index.close()
  let release!: () => void
  let entered!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  let migrated!: () => void
  const migrationFinished = new Promise<void>(resolve => { migrated = resolve })
  const migratePins = SessionIndex.prototype.migratePins
  t.mock.method(SessionIndex.prototype, 'migratePins', function (this: SessionIndex, ...args: Parameters<SessionIndex['migratePins']>) {
    try { return migratePins.apply(this, args) } finally { if (args[1] !== false) migrated() }
  })
  const seed = SessionIndex.prototype.seed
  t.mock.method(SessionIndex.prototype, 'seed', async function (this: SessionIndex, ...args: Parameters<SessionIndex['seed']>) {
    entered()
    await barrier
    return seed.apply(this, args)
  })
  const host = new Host({ state, logger: silent, builtinAgents: root, catalogRefreshMs: 0 })
  host.register(new FakeRuntime())
  t.after(async () => { release(); await host.dispose() })
  await host.start()
  await reached
  await host.call('app/state/set', { patch: { listPrefs: { sort: 'recent' } } })
  assert.deepEqual(await host.call('session/pins', {}), ['fake:kept', 'fake:unpin'])
  await host.call('session/pin', { runtime: runtimeId('fake'), sessionId: sessionId('unpin'), pinned: false })
  await host.call('session/pin', { runtime: runtimeId('fake'), sessionId: sessionId('new'), pinned: true })
  release()
  await migrationFinished
  assert.deepEqual(await host.call('session/pins', {}), ['fake:kept', 'fake:new', 'fake:seeded'])
  assert.deepEqual(state.state.preferences['listPrefs'], { sort: 'recent' })
})

test('legacy pins survive preference replacement until a slow seed completes', async t => {
  const root = tempDir('hd-pin-seed-race-')
  const state = new StateStore(join(root, 'state.json'))
  await state.load()
  await state.setPreferences({ listPrefs: { sort: 'name', pinnedSessions: ['fake:kept', 'fake:seeded'] } })
  await mkdir(join(root, 'transcripts', 'fake'), { recursive: true })
  await writeFile(join(root, 'transcripts', 'fake', 'seeded.json'), JSON.stringify({ version: 1, runtime: 'fake', id: 'seeded', savedAt: 1, turns: [] }))
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.upsert({ runtime: runtimeId('fake'), id: sessionId('kept'), cwd: root, status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 2 })
  index.close()
  let release!: () => void
  let entered!: () => void
  let migrated!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { entered = resolve })
  const migrationFinished = new Promise<void>(resolve => { migrated = resolve })
  const migratePins = SessionIndex.prototype.migratePins
  t.mock.method(SessionIndex.prototype, 'migratePins', function (this: SessionIndex, ...args: Parameters<SessionIndex['migratePins']>) {
    try { return migratePins.apply(this, args) } finally { if (args[1] !== false) migrated() }
  })
  const seed = SessionIndex.prototype.seed
  t.mock.method(SessionIndex.prototype, 'seed', async function (this: SessionIndex, ...args: Parameters<SessionIndex['seed']>) {
    entered()
    await barrier
    return seed.apply(this, args)
  })
  const host = new Host({ state, logger: silent, builtinAgents: root, catalogRefreshMs: 0 })
  host.register(new FakeRuntime())
  t.after(async () => { release(); await host.dispose() })
  await host.start()
  await reached
  await host.call('app/state/set', { patch: { listPrefs: { sort: 'recent' } } })
  release()
  await migrationFinished
  assert.deepEqual(await host.call('session/pins', {}), ['fake:kept', 'fake:seeded'])
  assert.deepEqual(state.state.preferences['listPrefs'], { sort: 'recent' })
})
