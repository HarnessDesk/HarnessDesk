import assert from 'node:assert/strict'
import { join } from 'node:path'
import { LeadChatControlStore } from '../src/lead/chat-control.js'
import { mkdir, readFile, realpath, rename, writeFile, rm, symlink } from 'node:fs/promises'
import test from 'node:test'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createLeadJournal, type LeadPermissionContext, type LeadPermissionCall } from '@harnessdesk/lead'
import { runtimeId, sessionId, type AgentSession, type WireNotification } from '@harnessdesk/protocol'
import { clientRefusal, topicsOf } from '../src/client-door.js'
import { evidenceDesk, until } from './fixtures/evidence-desk.js'
import { silent } from './fixtures/harness.js'

const boot = async (t: import('node:test').TestContext) => {
  const warnings: string[] = []
  t.mock.method(Object.getPrototypeOf(silent), 'warn', (message: string) => { warnings.push(message) })
  const { host, runtime, repo, stateDir } = await evidenceDesk(t, { leadEnabled: true })
  const project = { id: 'project-demo', path: await realpath(repo.dir) }, now = Date.now()
  const journal = await createLeadJournal({ read: async () => [], append: async () => {} })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'ordinary-delegation', now, caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null,
    budget: null, now: Date.now(), policyInterpretation: 'idle' })
  const service = host.createLeadService({ journal, project, prices: {},
    resolveTool: async () => ({ project, runId: null, start: null, stepId: null, context: context() }),
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }),
  })
  await service.setEnabled(true)
  let attempt = 0
  const execute = async (call: LeadPermissionCall) => {
    let refusal: unknown
    const result = await journal.execute({ id: `chat-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
      async parsed => {
        try { return { value: await host.call(parsed.method, parsed.params as never), identity: null } }
        catch (error) { refusal = error; throw error }
      })
    assert.equal(result.decision.effect, 'allow', result.decision.reason)
    if (result.outcome !== 'succeeded') throw refusal ?? new Error(result.outcome)
    return result.value as any
  }
  const notifications: WireNotification[] = []
  t.after(host.addBroadcaster(n => notifications.push(n)))
  return { host, runtime, execute, notifications, journal, project, stateDir, warnings }
}

test('take over refuses Lead mutations, hand back admits send again', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'Fix the flaky test.' } })
  assert.deepEqual((await h.host.call('lead/chats/control', {})).chats.map(c => [c.id, c.holder]), [[id, 'lead']])
  const taken = await h.host.call('lead/chat/takeOver', { id })
  assert.equal(taken.chats[0]!.holder, 'person')
  const phone = await h.host.call('workspace/thread/read', { id })
  assert.equal(phone.leadChatHolder, 'person')
  const message = phone.turns.find(turn => turn.type === 'you')
  assert.equal(message?.type === 'you' && message.lead?.name, 'Dex')
  assert.equal(message?.type === 'you' && message.text, 'Fix the flaky test.')
  assert.deepEqual(h.notifications.filter(n => n.method === 'lead/chats/controlChanged').at(-1)?.params, taken)
  await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'more' } }), /taken this chat over/)
  await assert.rejects(h.execute({ method: 'lead/chat/stop', params: { id } }), /taken this chat over/)
  h.runtime.sessions.get(sessionId(id.slice(id.indexOf(':') + 1)))!.finish()
  await assert.rejects(h.execute({ method: 'lead/chat/stop', params: { id } }), /taken this chat over/)
  await h.host.call('lead/chat/handBack', { id })
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'more' } })
})

test('take over cancels only waiting verified Lead messages; typing preserves the holder', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'long task' } })
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'queued from Lead' } })
  const target = { runtime: runtimeId(id.slice(0, id.indexOf(':'))), sessionId: sessionId(id.slice(id.indexOf(':') + 1)) }
  await h.host.call('turn/queue', { ...target, input: [{ type: 'text', text: 'queued by the person' }] })
  assert.equal((await h.host.call('lead/chats/control', {})).chats[0]!.holder, 'lead')
  await h.host.call('lead/chat/takeOver', { id })
  const texts = h.host.registry.get(target.runtime, target.sessionId)!.queue.messages.map(m => m.input.map(p => p.type === 'text' ? p.text : '').join(''))
  assert.deepEqual(texts, ['queued by the person'])
  assert.ok(h.journal.state.messages.some(message => /not delivered.*taken over|not delivered.*took over/i.test(message.text)))
})

test('chat control is unavailable to the Lead client door and its event topics', () => {
  for (const method of ['lead/chats/resetControl', 'lead/chats/control', 'lead/chat/takeOver', 'lead/chat/handBack'])
    assert.equal(clientRefusal(method, true, ['read', 'run', 'answer'], { id: 'fixture:s1' }, true), 'notOnClientSurface')
  assert.deepEqual(topicsOf({ method: 'lead/chats/controlChanged', params: { project: '/w', chats: [] } }), [])
})

test('disabled Lead has no chat controls', async t => {
  const { host } = await evidenceDesk(t)
  for (const method of ['lead/chats/resetControl', 'lead/chats/control', 'lead/chat/takeOver', 'lead/chat/handBack'] as const)
    assert.deepEqual(await host.call(method, { id: 'fixture:s1' } as never), { project: null, chats: [] })
})


for (const entry of ['window', 'phone'] as const) test(`${entry} reads restore the control record before the Lead conversation is opened`, async t => {
  const h = await evidenceDesk(t, { leadEnabled: true })
  const project = await realpath(h.repo.dir)
  const created = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: project } })
  const id = `${h.runtime.info.id}:${created.id}`
  const store = new LeadChatControlStore(join(h.stateDir, 'lead', 'chat-control.json'))
  await store.noteSent(project, id, 'a'.repeat(64))
  await store.setHolder(project, id, 'person')
  // The remembered Lead selection is canonical; the generic fixture uses an OS temp alias.
  await writeFile(join(h.stateDir, 'lead', 'project.json'), JSON.stringify({ version: 1, path: project }))
  if (entry === 'window') { const list = await h.host.call('lead/chats/control', {}); assert.equal(list.project, project); assert.equal(list.chats[0]?.holder, 'person') }
  else assert.equal((await h.host.call('workspace/thread/read', { id })).leadChatHolder, 'person')
})

for (const entry of ['window', 'phone'] as const) test(`${entry} control reads do not construct the Lead or pin a project`, async t => {
  const h = await evidenceDesk(t, { leadEnabled: true })
  const created = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: h.repo.dir } })
  if (entry === 'window') assert.deepEqual(await h.host.call('lead/chats/control', {}), { project: null, chats: [] })
  else assert.equal((await h.host.call('workspace/thread/read', { id: `${h.runtime.info.id}:${created.id}` })).leadChatHolder, undefined)
  await assert.rejects(readFile(join(h.stateDir, 'lead', 'project.json')), { code: 'ENOENT' })
  // A passive read cannot consume the one service slot.
  assert.throws(() => h.host.leadChats, /unavailable/)
})

test('an unreadable control record blocks every Lead mutation until an explicit window reset', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  const file = join(h.stateDir, 'lead', 'chat-control.json')
  await writeFile(file, '{')
  for (const call of [
    { method: 'lead/chat/send', params: { id, text: 'more' } },
    { method: 'lead/chat/stop', params: { id } },
    { method: 'lead/chat/start', params: { text: 'another chat' } },
  ] as const) await assert.rejects(h.execute(call), /Reset chat control/)
  assert.equal(await readFile(file, 'utf8'), '{')
  const recovery = h.notifications.filter(n => n.method === 'lead/chats/controlChanged').at(-1)
  assert.match((recovery?.params as { problem?: { message: string } }).problem?.message ?? '', /Reset chat control/, 'a Lead refusal exposes the recovery button without reconnecting')
  const invalid = (await h.host.call('lead/chats/control', {})).problem!
  assert.equal(invalid.kind, 'invalid')
  assert.match(invalid.message, /Reset chat control/)
  // An ordinary phone read still works, with no holder assertion.
  assert.equal((await h.host.call('workspace/thread/read', { id })).leadChatHolder, undefined)
  await h.host.call('lead/chats/resetControl', {})
  assert.deepEqual((await h.host.call('lead/chats/control', {})).chats, [])
  h.runtime.sessions.get(sessionId(id.slice(id.indexOf(':') + 1)))!.finish()
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'after reset' } })
})

test('take over cancels waiting Lead messages before a failed persistence and retains the live fence', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'waiting task' } })
  const target = { runtime: runtimeId(id.slice(0, id.indexOf(':'))), sessionId: sessionId(id.slice(id.indexOf(':') + 1)) }
  const file = join(h.stateDir, 'lead', 'chat-control.json')
  await rename(file, `${file}.old`); await mkdir(file)
  await assert.rejects(h.host.call('lead/chat/takeOver', { id }))
  assert.equal(h.host.registry.get(target.runtime, target.sessionId)!.queue.messages.length, 0)
  await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'must stay blocked' } }), /taken this chat over|Reset chat control/)
})

test('take over after final async queued admission wins before agent dispatch', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'must not be delivered' } })
  const target = { runtime: runtimeId(id.slice(0, id.indexOf(':'))), sessionId: sessionId(id.slice(id.indexOf(':') + 1)) }
  const record = h.host.registry.get(target.runtime, target.sessionId)!, live = h.runtime.sessions.get(target.sessionId)!
  h.host.registry.pauseQueue(record, 'Wait for explicit delivery')
  const admission = h.host.registry.queuedAdmission.bind(h.host.registry)
  h.host.registry.queuedAdmission = (one, key) => {
    const admit = admission(one, key)
    return admit && Object.assign(async (current: AgentSession) => { await admit(current); await h.host.call('lead/chat/takeOver', { id }) }, admit)
  }
  let sends = 0
  h.runtime.onSend = () => { sends++ }
  live.finish()
  await h.host.call('turn/queue/flush', target)
  assert.equal(sends, 0)
  assert.equal((await h.host.call('lead/chats/control', {})).chats[0]!.holder, 'person')
})

test('64 person-held slots refuse a new Lead chat before allocation', async t => {
  const h = await boot(t)
  const chats = Array.from({ length: 64 }, (_, i) => ({ id: `fixture:held-${i}`, holder: 'person', sent: [] }))
  await mkdir(join(h.stateDir, 'lead'), { recursive: true })
  await writeFile(join(h.stateDir, 'lead', 'chat-control.json'), JSON.stringify({ version: 2, projects: { [h.project.path]: chats } }))
  const before = h.runtime.sessions.size
  await assert.rejects(h.execute({ method: 'lead/chat/start', params: { text: 'another chat' } }), /64.*held/)
  assert.equal(h.runtime.sessions.size, before)
  assert.equal((await h.host.call('lead/chats/control', {})).chats.filter(chat => chat.holder === 'person').length, 64)
})

for (const operation of ['send', 'stop'] as const) test(`take over during the final live path recheck fences ${operation} synchronously`, async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  const target = { runtime: runtimeId(id.slice(0, id.indexOf(':'))), sessionId: sessionId(id.slice(id.indexOf(':') + 1)) }
  const live = h.runtime.sessions.get(target.sessionId)!
  if (operation === 'send') live.finish()
  // Gate exactly after the final asynchronous scope admission, in the host's
  // synchronous handle/path recheck. The button starts without yielding here.
  const settings = live.settings.bind(live)
  let pathReads = 0, taking: Promise<unknown> | undefined
  live.settings = () => {
    const value = settings()
    if (++pathReads === (operation === 'send' ? 4 : 2)) taking = h.host.call('lead/chat/takeOver', { id })
    return value
  }
  let effects = 0
  h.runtime.onSend = () => { effects++ }
  const interrupt = live.interrupt.bind(live)
  live.interrupt = async () => { effects++; return interrupt() }
  await assert.rejects(h.execute(operation === 'send'
    ? { method: 'lead/chat/send', params: { id, text: 'must not be delivered' } }
    : { method: 'lead/chat/stop', params: { id } }), /taken this chat over/)
  assert.ok(taking, 'the path recheck reached its gate')
  await taking
  assert.equal(effects, 0)
})

test('a failing cancellation notice never prevents durable take over or controlChanged', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'waiting task' } })
  let durableAtNotice: string | null = null, publishedAtNotice = false
  t.mock.method(h.journal, 'appendReply', async () => {
    durableAtNotice = await new LeadChatControlStore(join(h.stateDir, 'lead', 'chat-control.json')).holder(h.project.path, id)
    const changed = h.notifications.filter(n => n.method === 'lead/chats/controlChanged').at(-1)
    publishedAtNotice = (changed?.params as { chats: readonly { holder: string }[] }).chats[0]?.holder === 'person'
    throw new Error('Synthetic notice unavailable')
  })
  const result = await h.host.call('lead/chat/takeOver', { id }).catch(error => error)
  assert.equal(await new LeadChatControlStore(join(h.stateDir, 'lead', 'chat-control.json')).holder(h.project.path, id), 'person')
  assert.equal(result.chats?.[0]?.holder, 'person')
  assert.equal(durableAtNotice, 'person')
  assert.equal(publishedAtNotice, true)
  assert.ok(h.warnings.includes('Lead chat cancellation notice could not be saved'))
  const changed = h.notifications.filter(n => n.method === 'lead/chats/controlChanged').at(-1)
  assert.equal((changed?.params as { chats: readonly { holder: string }[] }).chats[0]?.holder, 'person')
})

test('take over committed before the first Lead record prevents its first dispatch', async t => {
  const h = await boot(t)
  const created = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: h.project.path } })
  const id = `${h.runtime.info.id}:${created.id}`
  let entered!: () => void, release!: () => void
  const admitting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const note = LeadChatControlStore.prototype.noteSent
  t.mock.method(LeadChatControlStore.prototype, 'noteSent', async function(this: LeadChatControlStore, ...args: Parameters<typeof note>) {
    entered(); await held; return note.apply(this, args)
  })
  let sends = 0
  h.runtime.onSend = () => { sends++ }
  const sending = h.execute({ method: 'lead/chat/send', params: { id, text: 'first instruction' } }).catch(error => error)
  await admitting
  let taken
  try { taken = await h.host.call('lead/chat/takeOver', { id }).catch(error => error) }
  finally { release() }
  const refused = await sending
  assert.equal(taken.chats?.[0]?.holder, 'person')
  assert.match(String(refused), /taken this chat over/)
  assert.equal(sends, 0)
  assert.equal(await new LeadChatControlStore(join(h.stateDir, 'lead', 'chat-control.json')).holder(h.project.path, id), 'person')
})

test('take over drops an admitted stale Lead reply and drains the person tail without replay after hand back', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'stale waiting task' } })
  const target = { runtime: runtimeId(id.slice(0, id.indexOf(':'))), sessionId: sessionId(id.slice(id.indexOf(':') + 1)) }
  const record = h.host.registry.get(target.runtime, target.sessionId)!, live = h.runtime.sessions.get(target.sessionId)!
  await h.host.call('turn/queue', { ...target, input: [{ type: 'text', text: 'Person follow-up' }] })
  h.host.registry.pauseQueue(record, 'Wait for explicit delivery')
  const admission = h.host.registry.queuedAdmission.bind(h.host.registry)
  h.host.registry.queuedAdmission = (one, key) => {
    const admit = admission(one, key)
    return admit && Object.assign(async (current: AgentSession) => { await admit(current); await h.host.call('lead/chat/takeOver', { id }) }, admit)
  }
  const delivered: string[] = []
  h.runtime.onSend = (_session, text) => { delivered.push(text) }
  live.finish()
  await h.host.call('turn/queue/flush', target)
  assert.notEqual(record.queue.status, 'paused', 'a person hold must cancel rather than poison the queue')
  await until(() => delivered.length ? true : null, 'the surviving person reply')
  assert.deepEqual(delivered, ['Person follow-up'])
  assert.ok(h.journal.state.messages.some(message => /not delivered.*took over/.test(message.text)))
  await h.host.call('lead/chat/handBack', { id })
  live.finish()
  await h.host.call('turn/queue/flush', target)
  assert.deepEqual(delivered, ['Person follow-up'], 'hand back never revives a cancelled instruction')
})

for (const code of ['EMFILE', 'EBUSY']) test(`window control marks ${code} as transient and can recover without reset`, async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  const open = fsPromises.open
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    if (String(args[0]).endsWith('chat-control.json')) throw Object.assign(new Error('Synthetic read failure'), { code })
    return open(...args)
  })
  syncBuiltinESMExports()
  try {
    const list = await h.host.call('lead/chats/control', {})
    assert.equal(list.problem?.kind, 'transient')
    assert.equal(list.chats[0]?.id, id)
    await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'blocked while unknown' } }), /temporarily unavailable/)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal((await h.host.call('lead/chats/control', {})).problem, undefined)
})

test('take over saves its cancellation notice even when the subsequent control list fails', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'waiting task' } })
  t.mock.method(LeadChatControlStore.prototype, 'list', async () => { throw new Error('Synthetic list failure') })
  await assert.rejects(h.host.call('lead/chat/takeOver', { id }), /Synthetic list failure/)
  assert.ok(h.journal.state.messages.some(message => /not delivered.*took over/.test(message.text)))
})

test('take over refuses invented chat ids without filling control slots', async t => {
  const h = await boot(t)
  for (let i = 0; i < 65; i++) await assert.rejects(h.host.call('lead/chat/takeOver', { id: `fixture:invented-${i}` }))
  assert.deepEqual((await h.host.call('lead/chats/control', {})).chats, [])
  await h.execute({ method: 'lead/chat/start', params: { text: 'still has room' } })
})

for (const restart of [false, true]) test(`Lead send refuses a held chat after its stale root redirects into the selected project (restart=${restart})`, async t => {
  const h = await boot(t)
  const created = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: h.project.path } })
  const id = `${h.runtime.info.id}:${created.id}`, old = join(h.project.path, 'old')
  await mkdir(old)
  const store = new LeadChatControlStore(join(h.stateDir, 'lead', 'chat-control.json'))
  await store.noteSent(old, id, 'a'.repeat(64)); await store.setHolder(old, id, 'person')
  if (!restart) await h.host.call('lead/chats/control', {})
  await rm(old, { recursive: true }); await symlink(h.project.path, old)
  let sends = 0
  h.runtime.onSend = () => { sends++ }
  await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'must remain held' } }), /Reset chat control/)
  assert.equal(sends, 0)
  assert.equal((await h.host.call('lead/chats/control', {})).problem?.kind, 'invalid')
})

test('a missing selected project has actionable unavailable recovery and stays fenced', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  const moved = `${h.project.path}-moved`
  await rename(h.project.path, moved)
  try {
    const list = await h.host.call('lead/chats/control', {})
    assert.equal(list.problem?.kind as string, 'unavailable')
    assert.match(list.problem!.message, /restore|access/i)
    assert.doesNotMatch(list.problem!.message, /Reset chat control/)
    await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'must remain blocked' } }))
  } finally { await rename(moved, h.project.path) }
  assert.equal((await h.host.call('lead/chats/control', {})).problem, undefined)
})

for (const code of ['EACCES']) test(`persistent ${code} on the control record is invalid in lists and take-over failures`, async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  const open = fsPromises.open
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    if (String(args[0]).endsWith('chat-control.json')) throw Object.assign(new Error('Synthetic persistent failure'), { code })
    return open(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(h.host.call('lead/chat/takeOver', { id }))
    const changed = h.notifications.filter(n => n.method === 'lead/chats/controlChanged').at(-1)!
    assert.equal(changed.method === 'lead/chats/controlChanged' && changed.params.problem?.kind, 'invalid')
    assert.equal((await h.host.call('lead/chats/control', {})).problem?.kind, 'invalid')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})

test('take over admits a symlink cwd alias before the first Lead record', async t => {
  const h = await boot(t)
  const alias = join(h.project.path, 'alias'); await symlink(h.project.path, alias)
  const created = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: alias } })
  const id = `${h.runtime.info.id}:${created.id}`
  const list = await h.host.call('lead/chat/takeOver', { id })
  assert.equal(list.chats.find(chat => chat.id === id)?.holder, 'person')
  await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'must not be delivered' } }), /taken this chat over/)
})

for (const reader of ['Lead', 'phone'] as const) test(`a retryable burst involving ${reader} reads fences sends but heals without Reset`, async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  h.runtime.sessions.get(sessionId(id.slice(id.indexOf(':') + 1)))!.finish()
  let sends = 0
  h.runtime.onSend = () => { sends++ }
  const open = fsPromises.open
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    if (String(args[0]).endsWith('chat-control.json')) throw Object.assign(new Error('Synthetic descriptor burst'), { code: 'EMFILE' })
    return open(...args)
  })
  syncBuiltinESMExports()
  try {
    assert.equal((await h.host.call('lead/chats/control', {})).problem?.kind, 'transient')
    if (reader === 'phone') await h.host.call('workspace/thread/read', { id })
    else await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'refused during burst' } }))
    await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'still refused' } }))
    assert.equal(sends, 0)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  assert.equal((await h.host.call('lead/chats/control', {})).problem, undefined)
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'after recovery' } })
  assert.equal(sends, 1)
})

test('Lead cannot send when a held chat cwd alias is repointed into the selected project', async t => {
  const h = await boot(t)
  const old = join(h.project.path, 'old'), alias = join(h.project.path, 'alias')
  await mkdir(old); await symlink(old, alias)
  const created = await h.host.call('session/create', { runtime: h.runtime.info.id, options: { cwd: alias } })
  const id = `${h.runtime.info.id}:${created.id}`
  const store = new LeadChatControlStore(join(h.stateDir, 'lead', 'chat-control.json'))
  await store.noteSent(old, id, 'a'.repeat(64)); await store.setHolder(old, id, 'person')
  await h.host.call('lead/chats/control', {})
  await rm(alias); await symlink(h.project.path, alias)
  let sends = 0
  h.runtime.onSend = () => { sends++ }
  await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'must stay held' } }), /taken this chat over/)
  assert.equal(sends, 0)
})

for (const reader of ['Lead', 'phone'] as const) test(`${reader} recovery clears a published unreadable warning while preserving a person hold`, async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  await h.host.call('lead/chat/takeOver', { id })
  const open = fsPromises.open
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    if (String(args[0]).endsWith('chat-control.json')) throw Object.assign(new Error('Synthetic descriptor burst'), { code: 'EMFILE' })
    return open(...args)
  })
  syncBuiltinESMExports()
  try {
    for (let i = 0; i < 3; i++) await h.host.call('lead/chats/control', {})
    await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'publishes unreadable warning' } }))
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
  const latest = () => h.notifications.filter(n => n.method === 'lead/chats/controlChanged').at(-1)!
  assert.equal(latest().method === 'lead/chats/controlChanged' && (latest().params as { problem?: { kind: string } }).problem?.kind, 'invalid')
  if (reader === 'Lead') await assert.rejects(h.execute({ method: 'lead/chat/send', params: { id, text: 'still person-held' } }), /taken this chat over/)
  else await h.host.call('workspace/thread/read', { id })
  const changed = latest()
  assert.ok(changed.method === 'lead/chats/controlChanged')
  assert.equal(changed.params.problem, undefined)
  assert.equal(changed.params.chats.find(chat => chat.id === id)?.holder, 'person')
})

test('the selected window list and Hand back agree with a person hold under another project key', async t => {
  const h = await boot(t)
  const { id } = await h.execute({ method: 'lead/chat/start', params: { text: 'first task' } })
  h.runtime.sessions.get(sessionId(id.slice(id.indexOf(':') + 1)))!.finish()
  const old = join(h.project.path, 'old'); await mkdir(old)
  const file = join(h.stateDir, 'lead', 'chat-control.json')
  const other = new LeadChatControlStore(file)
  await other.noteSent(old, id, 'a'.repeat(64)); await other.setHolder(old, id, 'person')
  const list = await h.host.call('lead/chats/control', {})
  assert.equal(list.chats.find(chat => chat.id === id)?.holder, 'person')
  assert.equal((await h.host.call('workspace/thread/read', { id })).leadChatHolder, 'person')
  const handed = await h.host.call('lead/chat/handBack', { id })
  assert.equal(handed.chats.find(chat => chat.id === id)?.holder, 'lead')
  assert.equal(await new LeadChatControlStore(file).holder(old, id), 'lead')
  let sends = 0
  h.runtime.onSend = () => { sends++ }
  await h.execute({ method: 'lead/chat/send', params: { id, text: 'after global Hand back' } })
  assert.equal(sends, 1)
})
