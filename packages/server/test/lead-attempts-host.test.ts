import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, leadWorkCards, type LeadJournalRecord, type LeadPermissionCall, type LeadPermissionContext } from '@harnessdesk/lead'
import { evidenceDesk } from './fixtures/evidence-desk.js'

/** The real host and its context, an ordinary fake runtime and a journaled Lead; no child, model or vendor traffic. */
const rig = async (t: TestContext) => {
  const { StateStore } = await import('../src/index.js')
  const { tempDir } = await import('./scratch.js')
  const state = new StateStore(`${tempDir('hd-lead-attempts-state-')}/state.json`)
  const desk = await evidenceDesk(t, { leadEnabled: true, state })
  const project = { id: 'project-demo', path: await realpath(desk.repo.dir) }
  const records: LeadJournalRecord[] = []
  const journal = await createLeadJournal({ read: async () => [], append: async record => { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'ordinary-delegation', now: Date.now(), caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null,
    budget: null, now: Date.now(), policyInterpretation: 'idle' })
  const service = desk.host.createLeadService({ journal, project, prices: {},
    resolveTool: async () => ({ project, runId: null, start: null, stepId: null, context: context() }),
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }),
  })
  await service.setEnabled(true)
  let attempt = 0
  const execute = (call: LeadPermissionCall) => journal.execute({ id: `attempt-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
    async parsed => ({ value: await desk.host.call(parsed.method, parsed.params as never), identity: null }))
  /** The person writes to the Lead: the journal's own record of a person message, as the window's send appends it. */
  let said = 0
  const personWrites = async (text: string) => { await journal.appendMessage(`person-${++said}`, text, 'person') }
  return { ...desk, project, journal, records, execute, personWrites }
}
type Rig = Awaited<ReturnType<typeof rig>>
type Card = { id: string, stage: string, fact?: string, stoppedBy?: string }
const card = async (r: Rig, id: string, done: (card: Card) => boolean): Promise<Card> => {
  for (let tries = 0; tries < 100; tries++) {
    const found = (await r.host.call('lead/work/list', {})).items.find(item => item.id === id) as Card | undefined
    if (found && done(found)) return found
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return (await r.host.call('lead/work/list', {})).items.find(item => item.id === id) as Card
}
const stopped = (found: Card) => found.stage === 'stopped'
const session = (r: Rig, id: string) => r.runtime.sessions.get(id.slice(id.indexOf(':') + 1))!
/** The window's door: the rail's Work menu Stop sends the same interrupt as the chat's own composer. */
const windowStop = (r: Rig, id: string) => r.host.call('turn/interrupt', { runtime: id.slice(0, id.indexOf(':')) as never, sessionId: id.slice(id.indexOf(':') + 1) as never })

test('#2108: a stop from the window or the phone on a later attempt under the same item is the person\'s, and the Lead\'s cards say so', async t => {
  const r = await rig(t)
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  assert.equal(first.outcome, 'succeeded')
  const { id: one, ledgerItem: item } = first.value as { id: string, ledgerItem: string }
  assert.ok(session(r, one))
  await windowStop(r, one)
  let found = await card(r, item, stopped)
  assert.equal(found.stoppedBy, 'person', 'the window\'s stop is the person\'s')
  assert.equal(found.fact, 'Stopped: the person stopped its chat')

  // Another attempt under the same item, which the person stops from the phone's work list.
  const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  assert.equal(second.outcome, 'succeeded', JSON.stringify(second.value))
  const two = (second.value as { id: string }).id
  found = await card(r, item, one => one.stage !== 'stopped')
  await r.host.call('workspace/stop', { id: two })
  found = await card(r, item, stopped)
  assert.equal(found.stoppedBy, 'person', 'the second attempt\'s stop is the person\'s too')
  assert.equal(found.fact, 'Stopped: the person stopped its chat')

  // What the Lead reads on every request names who stopped it, so it never says it does not know.
  const block = leadWorkCards(await r.host.call('lead/work/list', {}), Date.now())!
  assert.match(block, new RegExp(`${item} \\[stopped\\][^\\n]*stopped by the person`), block)
})

/** Two attempts under one item, each stopped by the person from the window. Returns the item and the second chat. */
const twiceStopped = async (r: Rig): Promise<{ item: string, last: string }> => {
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id: one, ledgerItem: item } = first.value as { id: string, ledgerItem: string }
  await windowStop(r, one)
  await card(r, item, stopped)
  const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  const last = (second.value as { id: string }).id
  await card(r, item, found => found.stage !== 'stopped')
  await windowStop(r, last)
  await card(r, item, stopped)
  return { item, last }
}

test('#2108: a third attempt at an item stopped twice is refused until the person answers, even when the person asked for it', async t => {
  const r = await rig(t)
  const { item, last } = await twiceStopped(r)
  await r.personWrites('Try the build task again')
  const chats = r.runtime.sessions.size
  const refused = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem: item } })
  const problem = (refused.value as { problem?: string }).problem
  assert.ok(problem, `the host refuses the third attempt: ${JSON.stringify(refused.value)}`)
  assert.equal(r.runtime.sessions.size, chats, 'no chat was started')
  assert.match(problem, /stopped twice/)
  assert.match(problem, /the person stopped/)
  assert.match(problem, new RegExp(last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'it names the last chat, to continue')
  assert.match(problem, /continue/i); assert.match(problem, /fresh/i); assert.match(problem, /drop/i)
  // Asking again without the person answering is refused again: the guard is the host's, not the instruction's.
  const again = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem: item } })
  assert.ok((again.value as { problem?: string }).problem)
  // A new title for the same work is the same item: refused the same way, never a way around the guard.
  const renamed = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task again', cause: 'person' } })
  assert.ok((renamed.value as { problem?: string }).problem, JSON.stringify(renamed))
  // The person answers: start fresh. The next attempt goes ahead under the same item.
  await r.personWrites('Start it fresh')
  const third = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem: item } })
  assert.equal(typeof (third.value as { id?: string }).id, 'string', JSON.stringify(third.value))
  assert.equal((third.value as { ledgerItem?: string }).ledgerItem, item)
})

test('#2108: the stops ride the card, so the rail and the phone can say who stopped each attempt', async t => {
  const r = await rig(t)
  const { item } = await twiceStopped(r)
  const found = await card(r, item, stopped) as Card & { stops?: { by?: string }[] }
  assert.deepEqual(found.stops?.map(stop => stop.by), ['person', 'person'])
  const block = leadWorkCards(await r.host.call('lead/work/list', {}), Date.now())!
  assert.match(block, /2 attempts stopped \(the person stopped it each time\)/)
})

test('#2108 review: the Lead stopping its own chat twice is not the person saying no, so another attempt goes ahead', async t => {
  const r = await rig(t)
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id: one, ledgerItem: item } = first.value as { id: string, ledgerItem: string }
  assert.equal((await r.execute({ method: 'lead/chat/stop', params: { id: one } })).outcome, 'succeeded')
  await card(r, item, stopped)
  const second = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem: item } })
  const two = (second.value as { id: string }).id
  await card(r, item, found => found.stage !== 'stopped')
  assert.equal((await r.execute({ method: 'lead/chat/stop', params: { id: two } })).outcome, 'succeeded')
  const found = await card(r, item, stopped) as Card & { stops?: { by?: string }[] }
  assert.deepEqual(found.stops?.map(stop => stop.by), ['lead', 'lead'], 'both stops were the Lead\'s own')
  const chats = r.runtime.sessions.size
  const third = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (third attempt)', ledgerItem: item } })
  assert.equal(typeof (third.value as { id?: string }).id, 'string', `no question first: ${JSON.stringify(third.value)}`)
  assert.equal(r.runtime.sessions.size, chats + 1, 'the third attempt started')
})
