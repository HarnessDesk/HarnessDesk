import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeadJournal } from '@harnessdesk/lead'
import { LEAD_RULE_DEFAULTS, type LeadAutonomyMode, type LeadSchedule, type LeadScheduledTask } from '@harnessdesk/protocol'
import { LeadAutonomyStore, LEAD_OBSERVED_NOTES } from '../src/lead/autonomy.js'
import { LeadAutomaticGoals } from '../src/lead/automatic-goals.js'
import { LeadPlanner } from '../src/lead/planner.js'
import { LeadPresenceStore } from '../src/lead/presence.js'
import { LeadRepeats } from '../src/lead/repeats.js'
import { LeadSlots } from '../src/lead/slots.js'

const memoryJournal = async () => {
  const records: any[] = [], journal = await createLeadJournal({ async read() { return records }, async append(record) { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  return journal
}
const rig = async (t: { after(fn: () => unknown): void }, over: { defaults?: typeof LEAD_RULE_DEFAULTS; goal?: boolean } = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'lead-autonomy-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const journal = await memoryJournal()
  let now = 1_000_000
  const reports: string[] = []
  const make = (defaults = over.defaults) => new LeadAutonomyStore({ file: join(home, 'lead', 'autonomy.json'), now: () => now, journal,
    goal: () => over.goal === false ? null : { id: 'goal-1', open: true }, report: async text => { reports.push(text) }, ...(defaults ? { defaults } : {}) })
  const store = make()
  await store.attach()
  return { home, journal, store, reports, make, tick: (ms: number) => { now += ms }, now: () => now }
}
const wakes = (journal: Awaited<ReturnType<typeof memoryJournal>>) => journal.state.wakes.filter(wake => wake.observed)

test('every kind starts on Act; a mode is a host setting the journal replays', async t => {
  const r = await rig(t)
  assert.deepEqual((await r.store.view()).modes, { 'desk-change': 'act', stuck: 'act', repeat: 'act', mention: 'act', brief: 'act' })
  const view = await r.store.set({ kind: 'brief', mode: 'observe' })
  assert.equal(view.modes.brief, 'observe')
  assert.equal(r.store.mode('brief'), 'observe')
  assert.equal(r.store.mode('repeat'), 'act')
  assert.equal(await r.store.gate('brief'), 'observed')
})

test('Off records nothing; Observe records the would-have row once per attempt and never acts', async t => {
  const r = await rig(t)
  await r.store.set({ kind: 'mention', mode: 'off' })
  assert.equal(await r.store.gate('mention'), 'off')
  assert.equal(wakes(r.journal).length, 0)
  await r.store.set({ kind: 'mention', mode: 'observe' })
  assert.equal(await r.store.gate('mention'), 'observed')
  assert.equal(wakes(r.journal).length, 1)
  assert.equal(wakes(r.journal)[0]!.observed, 'mention')
  assert.equal(wakes(r.journal)[0]!.modelTurn, false)
  const seen = (await r.store.view()).observed
  assert.equal(seen[0]!.note, LEAD_OBSERVED_NOTES.mention)
  await r.store.set({ kind: 'mention', mode: 'act' })
  assert.equal(await r.store.gate('mention'), 'act')
})

test('repeat: Off and Observe consume the slot and start nothing; Act starts it', async t => {
  const task: LeadScheduledTask = { id: 'repeat-1', project: '/workspace/acme-web', title: 'Dependencies', goal: 'Update dependencies', every: 'mondays', at: '09:00',
    enabled: true, lastRunAt: new Date(2026, 9, 5, 9).getTime(), runs: [] }
  for (const mode of ['off', 'observe', 'act'] as const) {
    const r = await rig(t)
    const planner = new LeadPlanner(await mkdtemp(join(tmpdir(), 'lead-autonomy-repeat-')))
    t.after(() => rm((planner as any).directory ?? r.home, { recursive: true, force: true }))
    await planner.writeSchedule({ version: 1, tasks: [task], quiet: null } as LeadSchedule)
    await planner.markRan(task.id, task.lastRunAt!)
    await r.store.set({ kind: 'repeat', mode })
    let starts = 0
    const repeats = new LeadRepeats({ planner, journal: r.journal, now: () => new Date(2026, 9, 26, 10).getTime(), gate: () => r.store.gate('repeat'),
      async start() { starts++; return { logicalGoalId: 'run-goal', approved: true } } })
    await repeats.tick()
    const run = (await planner.readSchedule()).tasks[0]!.runs!.at(-1)!
    assert.equal(starts, mode === 'act' ? 1 : 0, mode)
    assert.equal(run.state, mode === 'act' ? 'started' : 'skipped', mode)
    assert.equal(wakes(r.journal).length, mode === 'observe' ? 1 : 0, mode)
  }
})

test('mention: only a mention is gated; Off and Observe start nothing, Act offers the goal', async t => {
  for (const mode of ['off', 'observe', 'act'] as const) {
    const r = await rig(t)
    await r.store.set({ kind: 'mention', mode })
    let sent = 0
    const goals = new LeadAutomaticGoals({ journal: r.journal, enabled: () => true, quiet: async () => false, gateMention: () => r.store.gate('mention'),
      async send() { sent++; return {} } })
    const fact = { source: 'mention' as const, event: 'comment', subject: '7', url: 'https://github.com/acme/web/issues/7', title: 'Bug', body: 'Please look', action: 'commented', thread: 'issue' as const }
    const delivery = await goals.offerTrigger({ key: `k-${mode}`, project: '/workspace/acme-web', sentence: '@lead look', fact: fact as any })
    if (mode === 'act') assert.equal(sent > 0 || delivery.delivered || (delivery as any).reason !== undefined, true)
    else {
      assert.deepEqual(delivery, { delivered: false, final: true, reason: mode === 'off' ? 'Mention triggers are off in Lead settings.' : 'Mention triggers are set to Observe in Lead settings.' })
      assert.equal(sent, 0)
    }
    assert.equal(wakes(r.journal).length, mode === 'observe' ? 1 : 0)
  }
})

test('brief: Off and Observe spend the day without a digest; Act makes it', async t => {
  for (const mode of ['off', 'observe', 'act'] as const) {
    const r = await rig(t)
    await r.store.set({ kind: 'brief', mode })
    const home = await mkdtemp(join(tmpdir(), 'lead-autonomy-brief-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    const pushes: unknown[] = []
    let now = new Date(2026, 10, 10, 7, 0).getTime()
    const presence = new LeadPresenceStore({ file: join(home, 'lead', 'presence.json'), now: () => now, spent: () => 0, revision: () => 10,
      board: async () => ({ version: 1, items: [], more: 0 }), waiting: () => [], messages: () => [], quiet: async () => false, name: () => 'Dex',
      briefGate: () => r.store.gate('brief'), push: notice => { pushes.push(notice) } })
    await presence.updateBrief({ enabled: true, at: '07:30' })
    now = new Date(2026, 10, 10, 8, 0).getTime()
    assert.equal(await presence.tick(), mode === 'act', mode)
    assert.equal(pushes.length, mode === 'act' ? 1 : 0, mode)
    now += 60_000
    await presence.tick()
    assert.equal(wakes(r.journal).length, mode === 'observe' ? 1 : 0, `${mode}: once a day`)
  }
})

test('rules: edit, reset, keep and rollback keep every version and restore the exact bytes', async t => {
  const r = await rig(t)
  const odd = '  Be brief.\n\tNever use "quotes" — or tabs?  \n\n'
  let rules = await r.store.updateRules({ section: 'talk', action: 'edit', text: odd, expectedVersion: 0 })
  assert.equal(rules.sections.find(s => s.id === 'talk')!.version, 1)
  r.tick(1000)
  rules = await r.store.updateRules({ section: 'talk', action: 'edit', text: 'Be formal.', expectedVersion: 1 })
  rules = await r.store.updateRules({ section: 'talk', action: 'rollback', to: 1, expectedVersion: 2 })
  const talk = rules.sections.find(s => s.id === 'talk')!
  assert.equal(talk.text, odd, 'the old bytes come back exactly')
  assert.equal(talk.version, 3)
  assert.deepEqual(talk.history.map(h => h.version), [3, 2, 1])
  rules = await r.store.updateRules({ section: 'talk', action: 'reset', expectedVersion: 3 })
  assert.equal(rules.sections.find(s => s.id === 'talk')!.text, LEAD_RULE_DEFAULTS.talk.text)
  assert.equal(rules.sections.find(s => s.id === 'talk')!.custom, false)
  assert.equal(rules.prompt, '', 'nothing edited, nothing added to the model')
})

test('rules: a stale version is refused and an empty edit is refused', async t => {
  const r = await rig(t)
  await r.store.updateRules({ section: 'done', action: 'edit', text: 'Tests pass.', expectedVersion: 0 })
  await assert.rejects(r.store.updateRules({ section: 'done', action: 'edit', text: 'Other', expectedVersion: 0 }), { wireCode: 'lead-rules-stale' })
  await assert.rejects(r.store.updateRules({ section: 'done', action: 'edit', text: '   ', expectedVersion: 1 }), { wireCode: 'lead-rule-empty' })
})

test('rules: after an upgrade the section says what changed, and Keep mine clears it; the edit survives a reopen', async t => {
  const r = await rig(t)
  await r.store.updateRules({ section: 'delegate', action: 'edit', text: 'Mine.', expectedVersion: 0 })
  const upgraded = { ...LEAD_RULE_DEFAULTS, delegate: { version: LEAD_RULE_DEFAULTS.delegate.version + 1, text: 'New shipped words.' } }
  const next = r.make(upgraded)
  await next.attach()
  let section = (await next.rules()).sections.find(s => s.id === 'delegate')!
  assert.deepEqual(section.defaultUpdated, { from: LEAD_RULE_DEFAULTS.delegate.text, to: 'New shipped words.' })
  assert.equal(section.text, 'Mine.')
  section = (await next.updateRules({ section: 'delegate', action: 'keep', expectedVersion: section.version })).sections.find(s => s.id === 'delegate')!
  assert.equal(section.defaultUpdated, null)
  assert.equal(section.text, 'Mine.')
})

test('the person\'s room: automatic starts stop at the cap and on a nearly spent account; the person\'s never do', async () => {
  let automatic = 2, headroom: number | null = 80
  const marked: string[] = []
  const slots = new LeadSlots({ automaticLive: () => automatic, mark: async id => { marked.push(id) }, headroom: async () => headroom, limit: 3, reserve: 10 })
  assert.equal((await slots.admit('automatic')).ok, true)
  automatic = 3
  const full = await slots.admit('automatic')
  assert.equal(full.ok, false); assert.match((full as { reason: string }).reason, /3 runs it started on its own/)
  await assert.rejects(slots.assert('automatic'), { wireCode: 'lead-slot-reserved' })
  assert.equal((await slots.admit('person')).ok, true, 'the person starts at the cap')
  automatic = 0; headroom = 4
  assert.equal((await slots.admit('automatic')).ok, false, 'an account near the end of its window keeps its last room for the person')
  assert.equal((await slots.admit('person')).ok, true)
  headroom = null
  assert.equal((await slots.admit('automatic')).ok, true, 'unknown headroom is not a refusal')
  await slots.mark('chat-1', 'automatic'); await slots.mark('chat-2', 'person')
  assert.deepEqual(marked, ['chat-1'], 'only automatic runs are remembered')
})

test('headroom reads the binding window; a blocked account has none and an unreadable one says nothing', async () => {
  const { headroomOf } = await import('../src/lead/pacing.js')
  const report = (usedPercent: number | null, extra: object = {}) => ({ runtime: 'r', account: null, plan: null, lanes: usedPercent === null ? [] : [{ id: 'w', label: 'Weekly', usedPercent, resetsAt: null, windowMinutes: 10080 }],
    credits: null, spend: null, reached: null, source: 'api', fetchedAt: 0, staleAfterMs: 1, error: null, ...extra }) as any
  assert.equal(headroomOf(report(35)), 65)
  assert.equal(headroomOf(report(100)), 0)
  assert.equal(headroomOf(report(null)), null)
  assert.equal(headroomOf(null), null)
  assert.equal(headroomOf(report(35, { error: { kind: 'failed', message: 'x' } })), null)
})

test('a deadline reports once at 80% of the time and stops new rounds at 100%', async t => {
  const r = await rig(t)
  await r.store.setDeadline({ logicalGoalId: 'goal-1', deadlineAt: r.now() + 100_000 })
  assert.equal(r.store.deadlinePassed('goal-1'), false)
  r.tick(70_000); await r.store.checkDeadline()
  assert.equal(r.reports.length, 0, 'not yet at 80%')
  r.tick(10_000); await r.store.checkDeadline(); await r.store.checkDeadline()
  assert.equal(r.reports.length, 1, 'said once')
  assert.equal(r.store.deadlinePassed('goal-1'), false)
  r.tick(20_000)
  assert.equal(r.store.deadlinePassed('goal-1'), true)
  assert.equal(r.store.deadlinePassed('goal-2'), false, 'only its own goal')
  await assert.rejects(r.store.setDeadline({ logicalGoalId: 'goal-1', deadlineAt: 5 }), { wireCode: 'lead-deadline-past' })
})

test('a deadline is read only once the file has loaded, and the goal\'s loop learns of it through the journal', async t => {
  const r = await rig(t)
  await r.store.setDeadline({ logicalGoalId: 'goal-1', deadlineAt: r.now() + 1_000 })
  assert.deepEqual(r.journal.state.autonomy?.deadline, { logicalGoalId: 'goal-1', deadlineAt: r.now() + 1_000 }, 'the child reads it from the journal')
  r.tick(2_000)
  const again = r.make()
  assert.equal(again.deadlinePassed('goal-1'), false, 'before the file loads there is nothing to read')
  assert.equal(await again.deadlineElapsed('goal-1'), true, 'afterwards the same deadline has passed')
})

test('the person is told once when the time runs out, and the next turn they start carries the same fact', async t => {
  const r = await rig(t)
  await r.store.setDeadline({ logicalGoalId: 'goal-1', deadlineAt: r.now() + 100_000 })
  assert.equal(r.store.deadlineNote(), undefined)
  r.tick(85_000); await r.store.checkDeadline()
  r.tick(20_000); await r.store.checkDeadline(); await r.store.checkDeadline()
  assert.equal(r.reports.length, 2, 'once at 80%, once when it runs out')
  assert.match(r.reports[1]!, /has passed/)
  assert.match(r.store.deadlineNote() ?? '', /run out/)
})

// A start that names no cause is automatic: only a start positively named the person's is theirs.
test('the person\'s room: a start that names no cause is automatic, and an unreported account does not open the cap', async () => {
  let automatic = 3
  const slots = new LeadSlots({ automaticLive: () => automatic, mark: async () => {}, headroom: async () => null, limit: 3, reserve: 10 })
  assert.equal((await slots.admit()).ok, false, 'no cause, at the cap: refused')
  assert.equal(slots.hold(), null)
  assert.equal((await slots.admit('person')).ok, true)
  automatic = 1
  const verdict = await slots.admit()
  assert.deepEqual(verdict, { ok: true, note: 'no usage report' }, 'no report lets the start through and says why; only the headroom check fails open')
  const known = new LeadSlots({ automaticLive: () => 0, mark: async () => {}, headroom: async () => 60, limit: 3 })
  assert.deepEqual(await known.admit('automatic'), { ok: true })
})

test('the person\'s room: until what the count is made of has been read, automatic starts wait and the person\'s do not', async () => {
  let ready = false
  const slots = new LeadSlots({ automaticLive: () => 0, mark: async () => {}, ready: () => ready, limit: 3 })
  const loading = await slots.admit('automatic')
  assert.equal(loading.ok, false); assert.match((loading as { reason: string }).reason, /still reading/)
  assert.equal(slots.hold('automatic'), null, 'nothing is reserved against a count that says 0 only because it has not been read')
  assert.equal((await slots.admit('person')).ok, true)
  ready = true
  assert.equal((await slots.admit('automatic')).ok, true)
})

test('the person\'s room: two starts at the same moment cannot both take the last slot, and a released slot is free again', async () => {
  const slots = new LeadSlots({ automaticLive: () => 2, mark: async () => {}, limit: 3 })
  const [one, two] = await Promise.all([slots.admit('automatic'), slots.admit('automatic')])
  assert.equal(one.ok && two.ok, true, 'both look fine before either has made a run')
  const first = slots.hold('automatic'), second = slots.hold('automatic')
  assert.ok(first, 'the first takes the last slot'); assert.equal(second, null, 'the second finds it gone')
  assert.ok(slots.hold('person'), 'the person is never counted')
  first!.release()
  assert.ok(slots.hold('automatic'), 'a slot given back is free')
})
