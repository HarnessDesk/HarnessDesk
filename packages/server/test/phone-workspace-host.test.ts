import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { approvalId, itemId, runtimeId, sessionId, turnId, type Session, type SessionSummary } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { SessionIndex } from '../src/session-index.js'
import { StateStore } from '../src/state.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/** A real host over a fake agent and an index seeded the way a desk's own is, asked the phone's way. */
const desk = async (t: TestContext, bulk = false, interrupt = true) => {
  const root = tempDir('hd-phone-host-')
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false, interrupt } })
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
  assert.equal(snapshot.items[0]!.title, 'Fix the sign-in for … in …')
  assert.equal(snapshot.items[0]!.project, undefined, 'a folder that is no repository names no project, in the list or in the conversation')
  assert.equal(snapshot.deskName, 'Desk')
  assert.deepEqual(snapshot.capabilities, { startSession: true, startTeam: false, reply: true, stop: true, delete: false, chooseModel: false, choosePermissions: false, attach: false, undo: false, decide: true })
  assert.deepEqual([snapshot.models, snapshot.flows, snapshot.commands, snapshot.threads], [[], [], [], []])
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
  assert.ok(!text.includes('auth.ts failed'), 'a command’s output stays on the desk')

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
