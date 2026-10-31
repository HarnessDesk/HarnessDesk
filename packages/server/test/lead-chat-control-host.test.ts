import assert from 'node:assert/strict'
import { join } from 'node:path'
import { LeadChatControlStore } from '../src/lead/chat-control.js'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { createLeadJournal, type LeadPermissionContext, type LeadPermissionCall } from '@harnessdesk/lead'
import { runtimeId, sessionId, type AgentSession, type WireNotification } from '@harnessdesk/protocol'
import { clientRefusal, topicsOf } from '../src/client-door.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'

const boot = async (t: import('node:test').TestContext) => {
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
  return { host, runtime, execute, notifications, journal, project, stateDir }
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
  assert.match((recovery?.params as { problem?: string }).problem ?? '', /Reset chat control/, 'a Lead refusal exposes the recovery button without reconnecting')
  assert.match((await h.host.call('lead/chats/control', {})).problem!, /Reset chat control/)
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
