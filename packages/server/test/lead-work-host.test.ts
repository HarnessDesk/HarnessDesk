import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, leadWorkCards, type LeadJournalRecord, type LeadPermissionCall, type LeadPermissionContext, type MessagesTurn } from '@harnessdesk/lead'
import { LEAD_WORK_GROUPS, LEAD_WORK_LIMITS } from '@harnessdesk/protocol'
import { LeadControls } from '../src/lead/controls.js'
import { PHONE_POLICY } from '../src/phone-link.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'

/** The real host and its context, an ordinary fake runtime and a journaled Lead; no child, model or vendor traffic. */
const workRig = async (t: TestContext) => {
  const { StateStore } = await import('../src/index.js')
  const { tempDir } = await import('./scratch.js')
  const state = new StateStore(`${tempDir('hd-lead-work-state-')}/state.json`)
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
  const execute = (call: LeadPermissionCall) => journal.execute({ id: `work-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
    async parsed => ({ value: await desk.host.call(parsed.method, parsed.params as never), identity: null }))
  const controls = (send: (messages: readonly MessagesTurn[], input: { readonly proactive?: boolean }) => Promise<{ status: 'completed'; text: string }>) => {
    const made = new LeadControls({ journal, project, model: 'fixture-model', now: () => Date.now(), nextId: () => 'fresh-logical-goal',
      push() {}, decidePerson: async () => {}, decideResult: async () => {}, stopEffects: async () => {},
      readWorkContext: async () => leadWorkCards(await desk.host.call('lead/work/list', {}), Date.now()),
      service: { status: async () => ({ configured: true, protection: 'synthetic' }), assertPublic: async () => {}, setKey: async () => {}, deleteKey: async () => {},
        send: async input => send(input.messages, input) } })
    t.after(() => made.close())
    return made
  }
  return { ...desk, project, journal, records, execute, controls, state }
}

test('a duplicate chat start is refused naming the open item; ledgerItem adds the chat to it instead', async t => {
  const r = await workRig(t)
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the retry status list' } })
  assert.equal(first.outcome, 'succeeded')
  const created = first.value as { id: string; ledgerItem?: string }
  assert.equal(created.ledgerItem, 'work-1')
  const sessions = r.runtime.sessions.size
  const again = await r.execute({ method: 'lead/chat/start', params: { text: 'fix the retry status list' } })
  assert.equal(again.outcome, 'failed')
  const problem = (again.value as { problem: string }).problem
  assert.match(problem, /work-1 "Fix the retry status list"/)
  assert.match(problem, /ledgerItem "work-1"/)
  assert.equal(r.runtime.sessions.size, sessions, 'a refused duplicate starts no chat')
  assert.equal(r.journal.state.chatEffectsSinceReply.started, 1)
  const added = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the retry status list', ledgerItem: 'work-1' } })
  assert.equal(added.outcome, 'succeeded')
  assert.equal((added.value as { ledgerItem?: string }).ledgerItem, 'work-1')
  const board = await r.host.call('lead/work/list', {})
  assert.equal(board.items.length, 1)
  assert.deepEqual(board.items[0]!.links.chats, [created.id, (added.value as { id: string }).id])
  assert.equal(board.items[0]!.project, r.project.path.split('/').at(-1), 'a project is its folder name, never a path')
})

test('the window and the phone read one projection: four groups, Needs you first, and Done or Drop closes it', async t => {
  const r = await workRig(t)
  for (const text of ['Add a snake case helper', 'Update the changelog for the retry fix', 'Rename the status column'])
    assert.equal((await r.execute({ method: 'lead/chat/start', params: { text } })).outcome, 'succeeded')
  const board = await r.host.call('lead/work/list', {})
  assert.deepEqual(board.items.map(item => item.id).sort(), ['work-1', 'work-2', 'work-3'])
  const groups = board.items.map(item => LEAD_WORK_GROUPS.indexOf(item.group))
  assert.deepEqual(groups, [...groups].sort((a, b) => a - b), 'groups arrive in Needs you, Working, In review, Done order')
  const phone = await r.host.call('workspace/read', {})
  assert.deepEqual(phone.work?.items.map(item => [item.id, item.group, item.stage]), board.items.map(item => [item.id, item.group, item.stage]))
  assert.equal(PHONE_POLICY.methods['lead/work/close'], 'run', 'the phone may close an item')
  assert.equal(PHONE_POLICY.methods['lead/work/note'], undefined, 'and only the Lead annotates one')
  const closed = await r.host.call('lead/work/close', { id: 'work-2', outcome: 'dropped' })
  assert.equal(closed.items.at(-1)?.id, 'work-2')
  assert.equal(closed.items.at(-1)?.group, 'done')
  assert.equal(closed.items.at(-1)?.outcome, 'dropped')
  assert.equal((await r.host.call('workspace/read', {})).work?.items.at(-1)?.outcome, 'dropped')
  const noted = await r.execute({ method: 'lead/work/note', params: { id: 'work-1', note: 'Waits for the column rename', after: 'work-3' } })
  assert.equal(noted.outcome, 'succeeded')
  const detail = await r.host.call('lead/work/read', { id: 'work-1' })
  assert.equal(detail.note, 'Waits for the column rename')
  assert.equal(detail.after, 'work-3')
  await assert.rejects(r.host.call('lead/work/note', { id: 'work-9', note: 'x' }), /work-9/)
})

test('the open cards reach every model request, capped, and a reminder wakes the Lead as a scheduled turn', async t => {
  const r = await workRig(t)
  for (let n = 1; n <= 24; n++)
    assert.equal((await r.execute({ method: 'lead/chat/start', params: { text: `Investigate flaky sync test number ${n} and report what fails, with the failing seed and the exact command that reproduces it on a clean checkout` } })).outcome, 'succeeded')
  const sent: { messages: readonly MessagesTurn[]; proactive: boolean }[] = []
  const controls = r.controls(async (messages, input) => {
    sent.push({ messages, proactive: input.proactive === true })
    return { status: 'completed', text: sent.length === 1 ? 'Two dozen chats are on it.' : '' }
  })
  await controls.send({ idempotencyKey: 'person-1', text: 'How is the sync work going?' }); await controls.idle()
  assert.equal(sent.length, 1)
  const words = (turns: readonly MessagesTurn[]) => turns.flatMap(turn => Array.isArray(turn.content) ? turn.content : []).map(part => 'text' in part ? part.text : '').join('\n')
  const last = sent[0]!.messages.at(-1)!
  assert.equal(last.role, 'user')
  const block = words([last]).slice(words([last]).indexOf('<work-ledger>'))
  assert.match(block, /^<work-ledger>\n/)
  assert.match(block, /\n- work-24 \[/, 'newest first inside a group')
  assert.doesNotMatch(block, /- work-1 \[/, 'the oldest is left to work_list')
  assert.match(block, /and \d+ more, use work_list\n<\/work-ledger>$/)
  assert.ok(new TextEncoder().encode(block).byteLength <= LEAD_WORK_LIMITS.cardsBytes, 'the cards stay within 3 KB')
  assert.equal(r.journal.state.messages.some(message => message.text.includes('<work-ledger>')), false, 'the cards ride the request, never the thread')

  const key = 'work-reminder-work-1-1800000000000'
  assert.equal(await controls.remind(key, 'Reminder you set for work work-1. Check on it.'), true)
  await controls.idle()
  assert.equal(sent.length, 2)
  assert.equal(sent[1]!.proactive, true, 'a reminder is a proactive wake, as a scheduled run is')
  assert.match(words(sent[1]!.messages), /Reminder you set for work work-1/)
  assert.match(words(sent[1]!.messages), /<work-ledger>/)
  assert.equal(r.journal.state.messages.at(-1)?.source, 'schedule')
  assert.equal(await controls.remind(key, 'Reminder you set for work work-1. Check on it.'), true, 'the same reminder is delivered once')
  await controls.idle()
  assert.equal(sent.length, 2)
})

test('an ask gets its expiry clock when the journal appends it, with nobody looking', async t => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const r = await workRig(t)
  await r.journal.appendReply('Start it?', undefined, { question: 'Start it?', options: [{ id: 'a', label: 'Start it' }, { id: 'b', label: 'Not now' }], recommended: 'a', expiresInMinutes: 60 })
  const id = r.journal.state.messages.at(-1)!.id
  const file = join(r.state.directory, 'lead', 'presence.json')
  let stored: { asks?: Record<string, { expiresAt?: number }> } = {}
  for (let attempt = 0; attempt < 100 && !stored.asks?.[id]; attempt++) {
    stored = await readFile(file, 'utf8').then(text => JSON.parse(text), () => ({}))
    if (!stored.asks?.[id]) await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(stored.asks?.[id]?.expiresAt, 'the clock was started by the append, not by a read')
})

// The person's room, through the real host: the cause travels with the start, and the host decides.
test('host: automatic starts stop at the cap of three; the person starts at the cap under any goal, and an automatic one under the person\'s goal still waits', async t => {
  const r = await workRig(t)
  const start = (text: string, cause?: 'person' | 'automatic') => r.execute({ method: 'lead/chat/start', params: { text, ...(cause ? { cause } : {}) } })
  for (const n of [1, 2, 3]) assert.equal((await start(`Automatic job number ${n} on ${'x'.repeat(n)}`, 'automatic')).outcome, 'succeeded')
  const refused = await start('Automatic job number four', 'automatic')
  assert.match((refused.value as { problem: string }).problem, /3 runs it started on its own/)
  assert.equal(r.runtime.sessions.size, 3, 'the refused start created nothing')
  // Under a goal that came from a schedule, the person\'s own "also do X" is still theirs.
  await r.journal.setOrigin({ source: 'schedule', event: 'repeat', subject: 'weekly', url: null })
  assert.equal((await start('Also, please look at the flaky login test', 'person')).outcome, 'succeeded')
  assert.equal(r.runtime.sessions.size, 4)
  // Under a goal the person began, a desk-change-driven start is automatic and waits at the cap.
  assert.match(((await start('Follow up on the settled run in another chat', 'automatic')).value as { problem: string }).problem, /on its own/)
})

test('host: a goal whose deadline passed stops automatic chat work and answers the person', async t => {
  const r = await workRig(t)
  const { host } = r
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the date parser', cause: 'person' } })
  const chat = (first.value as { id: string }).id
  await host.leadAutonomy.setDeadline({ logicalGoalId: 'ordinary-delegation', deadlineAt: Date.now() + 1500 })
  assert.equal((await r.execute({ method: 'lead/chat/start', params: { text: 'A second job before the time is up', cause: 'automatic' } })).outcome, 'succeeded')
  await new Promise(resolve => setTimeout(resolve, 1600))
  const late = await r.execute({ method: 'lead/chat/start', params: { text: 'A third job after the time is up', cause: 'automatic' } })
  assert.match((late.value as { problem: string }).problem, /time for this goal has run out/)
  const sent = await r.execute({ method: 'lead/chat/send', params: { id: chat, text: 'Keep going on the parser', cause: 'automatic' } })
  assert.equal(sent.outcome, 'failed', 'an automatic send for the goal stops too')
  assert.equal((await r.execute({ method: 'lead/chat/start', params: { text: 'The person asks for one more thing', cause: 'person' } })).outcome, 'succeeded')
  assert.equal((await r.execute({ method: 'lead/chat/send', params: { id: chat, text: 'The person says: continue', cause: 'person' } })).outcome, 'succeeded')
  assert.match(host.leadAutonomy.deadlineNote() ?? '', /run out/, 'the next turn the person starts is told')
})
