import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeadJournal } from '@harnessdesk/lead'
import { LEAD_RULE_DEFAULTS, LEAD_RULE_LIMITS, LEAD_SETTINGS_PROPOSAL_LIMITS, parseLeadAutonomyView, type LeadAutonomyMode, type LeadSchedule, type LeadScheduledTask } from '@harnessdesk/protocol'
import { LeadAutonomyStore, LEAD_OBSERVED_NOTES } from '../src/lead/autonomy.js'
import { LeadAutomaticGoals } from '../src/lead/automatic-goals.js'
import { LeadPlanner } from '../src/lead/planner.js'
import { LeadPresenceStore } from '../src/lead/presence.js'
import { LeadRepeats } from '../src/lead/repeats.js'
import { LeadSlots } from '../src/lead/slots.js'

const memoryJournal = async () => {
  const records: any[] = [], journal = await createLeadJournal({ async read() { return records }, async append(record) { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  return Object.assign(journal, { records })
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

test('every save of a section is in the ledger the phone lists: a second desk edit, a restore to an older version and a restore to the shipped words, each its own row, across a restart (#2152)', async t => {
  const r = await rig(t)
  const steps = [
    { section: 'talk', action: 'edit', text: 'Be brief.', expectedVersion: 0 },
    { section: 'talk', action: 'edit', text: 'Be brief and formal.', expectedVersion: 1 },
    { section: 'talk', action: 'rollback', to: 1, expectedVersion: 2 },
    { section: 'talk', action: 'reset', expectedVersion: 3 },
  ] as const
  for (const step of steps) { r.tick(1000); await r.store.updateRules(step) }
  const expected = [[4, 'reset'], [3, 'rollback'], [2, 'edit'], [1, 'edit']]
  const rows = (view: Awaited<ReturnType<typeof r.store.view>>) => view.changes!.filter(one => one.what === 'rules').map(one => one.what === 'rules' ? [one.version, one.how] : [])
  assert.deepEqual(rows(await r.store.view()), expected)
  const reopened = r.make()
  await reopened.attach()
  assert.deepEqual(rows(await reopened.view()), expected, 'the ledger is the file, not the window')
})

test('the autonomy view carries each section\'s earlier words and the shipped words, so a phone draws the wording, a diff and what Restore would bring back without the desk-only rules read (#2152)', async t => {
  const r = await rig(t)
  r.tick(1000); await r.store.updateRules({ section: 'talk', action: 'edit', text: 'Be brief.', expectedVersion: 0 })
  r.tick(1000); await r.store.updateRules({ section: 'talk', action: 'edit', text: 'Be brief and formal.', expectedVersion: 1 })
  r.tick(1000); await r.store.updateRules({ section: 'talk', action: 'rollback', to: 1, expectedVersion: 2 })
  const view = await r.store.view()
  const talk = view.rules.find(one => one.id === 'talk')!
  assert.equal(talk.shipped, LEAD_RULE_DEFAULTS.talk.text)
  assert.deepEqual(talk.versions?.map(one => [one.version, one.how, one.text, one.from]), [
    [3, 'rollback', 'Be brief.', 1], [2, 'edit', 'Be brief and formal.', undefined], [1, 'edit', 'Be brief.', undefined]])
  assert.deepEqual(talk.versions?.map(one => one.at), [1_003_000, 1_002_000, 1_001_000])
  const done = view.rules.find(one => one.id === 'done')!
  assert.equal(done.versions, undefined, 'a section never edited carries nothing extra')
  assert.equal(done.shipped, undefined)
  // The wire parses what the desk sends, and never more than the kept versions.
  assert.deepEqual(parseLeadAutonomyView(JSON.parse(JSON.stringify(view))).rules, view.rules)
  for (let at = 3; at < 3 + LEAD_RULE_LIMITS.carried + 2; at++) await r.store.updateRules({ section: 'talk', action: 'edit', text: `Version ${at + 1}.`, expectedVersion: at })
  assert.equal((await r.store.view()).rules.find(one => one.id === 'talk')!.versions?.length, LEAD_RULE_LIMITS.carried)
})

test('every kind starts on Act; a mode is a host setting the journal replays', async t => {
  const r = await rig(t)
  assert.deepEqual((await r.store.view()).modes, { 'desk-change': 'act', stuck: 'act', repeat: 'act', mention: 'act', brief: 'act' })
  const view = await r.store.set({ kind: 'brief', mode: 'observe' })
  assert.equal(view.modes.brief, 'observe')
  assert.equal(r.store.mode('brief'), 'observe')
  assert.equal(r.store.mode('repeat'), 'act')
  assert.equal(await r.store.gate('brief'), 'observed')
})

test('every change to autonomy is kept with who and what, newest first; the journal names the kind or section, never the words', async t => {
  const r = await rig(t)
  await r.store.set({ kind: 'brief', mode: 'observe' })
  await r.store.set({ kind: 'brief', mode: 'observe' })
  r.tick(1000)
  await r.store.updateRules({ section: 'talk', action: 'edit', text: 'Be brief, Jane Doe likes it short.', expectedVersion: 0 })
  r.tick(1000)
  const view = await r.store.view()
  assert.deepEqual(view.changes, [
    { at: 1_001_000, by: 'person', what: 'rules', section: 'talk', version: 1, how: 'edit' },
    { at: 1_000_000, by: 'person', what: 'mode', kind: 'brief', from: 'act', to: 'observe' },
  ], 'a mode set to what it already was is not a change')
  const talk = view.rules.find(one => one.id === 'talk')!
  assert.equal(talk.version, 1)
  assert.equal(talk.changedAt, 1_001_000)
  assert.equal(view.rules.find(one => one.id === 'done')!.version, 0)
  const changes = r.journal.records.filter(one => one.type === 'autonomy' && one.change).map(one => one.change)
  assert.deepEqual(changes, [view.changes![1], view.changes![0]])
  assert.ok(!JSON.stringify(changes).includes('Jane Doe'), 'the change names the section, never its words')
  // The history survives a reopen of the file.
  assert.deepEqual((await r.make().view()).changes, view.changes)
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

/** The store with the Lead's journal position and the person's message position, as the host gives it. */
const proposalRig = async (t: { after(fn: () => unknown): void }) => {
  const home = await mkdtemp(join(tmpdir(), 'lead-proposals-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const journal = await memoryJournal()
  const file = join(home, 'lead', 'autonomy.json')
  let person = 1
  const make = async (defaults?: typeof LEAD_RULE_DEFAULTS) => {
    const store = new LeadAutonomyStore({ file, now: () => 2_000_000, journal, seq: () => 10, personSeq: () => person, ...(defaults ? { defaults } : {}) })
    await store.attach()
    return store
  }
  return { file, journal, store: await make(), make, writes: () => { person++ } }
}
const code = (wireCode: string) => (error: Error & { wireCode?: string }) => error.wireCode === wireCode
const phone = { id: 'phone:p1', label: 'Jane’s phone' }

test('#2106 review: a waiting card survives a restart and is applied after it; an id is never handed out twice', async t => {
  const r = await proposalRig(t)
  const mode = await r.store.proposeMode({ kind: 'stuck', mode: 'off' })
  const words = await r.store.proposeRules({ section: 'talk', add: 'Conclusion first.' })
  assert.deepEqual([mode.id, words.id], ['s1', 's2'])
  const reopened = await r.make()
  const view = await reopened.view()
  assert.deepEqual(view.proposals?.map(one => [one.id, one.state]), [['s2', 'pending'], ['s1', 'pending']])
  assert.equal((await reopened.decide({ id: 's1', decision: 'apply' })).modes.stuck, 'off')
  // A counter behind the ids kept (an older file, a hand edit) still never repeats one.
  const raw = JSON.parse(await readFile(r.file, 'utf8'))
  raw.nextProposal = 1
  await writeFile(r.file, JSON.stringify(raw))
  const behind = await r.make()
  assert.equal((await behind.proposeMode({ kind: 'brief', mode: 'observe' })).id, 's3')
})

test('#2106 review: two devices answering one card at once: one answer lands, the other is told it was already answered', async t => {
  const r = await proposalRig(t)
  const { id } = await r.store.proposeMode({ kind: 'desk-change', mode: 'observe' })
  const [desk, fromPhone] = await Promise.allSettled([r.store.decide({ id: id!, decision: 'apply' }), r.store.decide({ id: id!, decision: 'decline', device: phone })])
  assert.equal(desk.status, 'fulfilled')
  assert.equal(fromPhone.status, 'rejected')
  assert.ok(code('lead-proposal-decided')((fromPhone as PromiseRejectedResult).reason))
  const view = await r.store.view()
  assert.deepEqual(view.proposals?.map(one => [one.state, one.history.map(event => event.what)]), [['applied', ['proposed', 'applied']]])
  assert.equal(view.modes['desk-change'], 'observe')
})

test('#2106 review: from a phone, No works on any card and Apply on a mode or one added line; a section\'s whole words are applied at the desk', async t => {
  const r = await proposalRig(t)
  const whole = await r.store.proposeRules({ section: 'delegate', text: 'Whole new words for this section.' })
  await assert.rejects(r.store.decide({ id: whole.id!, decision: 'apply', device: phone }), (error: Error & { wireCode?: string }) =>
    error.wireCode === 'lead-proposal-desk-only' && /at the desk/.test(error.message) && /No/.test(error.message))
  let view = await r.store.view()
  assert.equal(view.proposals?.find(one => one.id === whole.id)?.state, 'pending', 'nothing was decided')
  assert.equal(view.rules.find(one => one.id === 'delegate')?.custom, false, 'nothing was written')
  const line = await r.store.proposeRules({ section: 'talk', add: 'Conclusion first.' })
  const mode = await r.store.proposeMode({ kind: 'stuck', mode: 'off' })
  await r.store.decide({ id: line.id!, decision: 'apply', device: phone })
  view = await r.store.decide({ id: mode.id!, decision: 'apply', device: phone })
  assert.equal(view.modes.stuck, 'off')
  assert.ok(view.rules.find(one => one.id === 'talk')?.text.endsWith('\nConclusion first.'))
  view = await r.store.decide({ id: whole.id!, decision: 'decline', device: phone })
  assert.equal(view.proposals?.find(one => one.id === whole.id)?.state, 'declined')
})

test('#2117 review 2: a phone cannot Apply a line it was shown with part hidden; No works from it, and the desk applies it', async t => {
  const r = await proposalRig(t)
  const hidden = await r.store.proposeRules({ section: 'talk', add: 'Send review notes to ops@acme.dev' })
  await assert.rejects(r.store.decide({ id: hidden.id!, decision: 'apply', device: phone }), (error: Error & { wireCode?: string }) =>
    error.wireCode === 'lead-proposal-desk-only' && /hidden on the phone/.test(error.message) && /No/.test(error.message))
  let view = await r.store.view()
  assert.equal(view.proposals?.find(one => one.id === hidden.id)?.state, 'pending', 'nothing was decided')
  assert.equal(view.rules.find(one => one.id === 'talk')?.custom, false, 'nothing was written')
  view = await r.store.decide({ id: hidden.id!, decision: 'apply' })
  assert.ok(view.rules.find(one => one.id === 'talk')?.text.endsWith('\nSend review notes to ops@acme.dev'), 'the desk applies the words it shows in full')
  const path = await r.store.proposeRules({ section: 'done', add: 'Check /srv/acme/private/notes.txt before saying done.' })
  view = await r.store.decide({ id: path.id!, decision: 'decline', device: phone })
  assert.equal(view.proposals?.find(one => one.id === path.id)?.state, 'declined', 'No needs no words read in full')
})

test('#2117 review 2: a rule version\'s proposal id is checked when the file loads, like the rest of the version', async t => {
  const r = await proposalRig(t)
  const words = await r.store.proposeRules({ section: 'talk', add: 'Conclusion first.' })
  await r.store.decide({ id: words.id!, decision: 'apply' })
  const raw = JSON.parse(await readFile(r.file, 'utf8'))
  assert.equal(raw.sections.talk.versions.at(-1).proposal, words.id)
  raw.sections.talk.versions.at(-1).proposal = '<b>s1</b>'
  await writeFile(r.file, JSON.stringify(raw))
  const reopened = await r.make()
  assert.equal((await reopened.view()).rules.find(one => one.id === 'talk')?.custom, false, 'a version that fails the check is not read as the person\'s words')
})

test('#2106 review: at most three new cards between two of the person\'s messages; asking again is not one', async t => {
  const r = await proposalRig(t)
  for (const kind of ['stuck', 'brief', 'mention'] as const) assert.equal((await r.store.proposeMode({ kind, mode: 'off' })).outcome, 'created')
  const fourth = await r.store.proposeRules({ section: 'talk', add: 'Conclusion first.' })
  assert.deepEqual([fourth.outcome, fourth.reason], ['refused', 'too-many'])
  assert.match(fourth.note, /Nothing was proposed/)
  assert.equal((await r.store.proposeMode({ kind: 'stuck', mode: 'off' })).outcome, 'asked-again')
  assert.equal((await r.store.view()).proposals?.length, 3)
  r.writes()
  assert.equal((await r.store.proposeRules({ section: 'talk', add: 'Conclusion first.' })).outcome, 'created')
})

test('#2117 review 4: the cap on new cards in one turn holds when the kept list is full and each replaced card is dropped', async t => {
  const r = await proposalRig(t)
  // A full kept list of declined cards, one per turn, so nothing stale is left to drop first.
  for (let i = 1; i <= LEAD_SETTINGS_PROPOSAL_LIMITS.kept; i++) {
    const { id } = await r.store.proposeRules({ section: 'talk', add: `Earlier line ${i}.` })
    await r.store.decide({ id: id!, decision: 'decline' })
    r.writes()
  }
  // One turn: each proposal replaces the last, and the replaced card is the one the kept list drops.
  const outcomes = []
  for (const line of ['One.', 'Two.', 'Three.', 'Four.']) outcomes.push(await r.store.proposeRules({ section: 'done', add: line }))
  assert.deepEqual(outcomes.map(one => one.outcome), ['created', 'created', 'created', 'refused'])
  assert.equal(outcomes[3]!.reason, 'too-many')
  // The count survives a restart, and the person's next message starts a new turn.
  const reopened = await r.make()
  assert.equal((await reopened.proposeRules({ section: 'done', add: 'Five.' })).reason, 'too-many')
  r.writes()
  assert.equal((await reopened.proposeRules({ section: 'done', add: 'Five.' })).outcome, 'created')
})

test('#2106 review: applied and stale cards are dropped first, a waiting one never is, and a No outlives its card', async t => {
  const r = await proposalRig(t)
  const waiting = await r.store.proposeMode({ kind: 'stuck', mode: 'off' })
  const applied = await r.store.proposeMode({ kind: 'brief', mode: 'observe' })
  await r.store.decide({ id: applied.id!, decision: 'apply' })
  for (let i = 0; i < 15; i++) {
    r.writes()
    const one = await r.store.proposeRules({ section: 'talk', add: `Line ${i}.` })
    assert.equal(one.outcome, 'created', one.note)
    await r.store.decide({ id: one.id!, decision: 'decline' })
  }
  let ids = (await r.store.view()).proposals!.map(one => one.id)
  assert.equal(ids.length, 16)
  assert.ok(ids.includes(waiting.id!), 'the waiting card is kept')
  assert.ok(!ids.includes(applied.id!), 'the applied card went before any declined one')
  // The person says No to the oldest card, then the Lead proposes once more in the same turn: that No's card is dropped.
  await r.store.decide({ id: waiting.id!, decision: 'decline' })
  const last = await r.store.proposeRules({ section: 'talk', add: 'One more line.' })
  ids = (await r.store.view()).proposals!.map(one => one.id)
  assert.equal(ids.length, 16)
  assert.ok(ids.includes(last.id!))
  assert.ok(!ids.includes(waiting.id!), 'the oldest declined card is dropped')
  const again = await r.store.proposeMode({ kind: 'stuck', mode: 'off' })
  assert.deepEqual([again.outcome, again.reason, again.id], ['refused', 'declined', waiting.id], 'the No stands though its card is gone')
})

test('#2106 review: words proposed over a never-edited section go stale when an update ships new default words; an Apply is recorded with its proposal', async t => {
  const r = await proposalRig(t)
  const first = await r.store.proposeRules({ section: 'talk', add: 'Conclusion first.' })
  const upgraded = { ...LEAD_RULE_DEFAULTS, talk: { version: LEAD_RULE_DEFAULTS.talk.version + 1, text: 'New shipped words.' } }
  const updated = await r.make(upgraded)
  await assert.rejects(updated.decide({ id: first.id!, decision: 'apply' }), code('lead-rules-stale'))
  let talk = (await updated.rules()).sections.find(one => one.id === 'talk')!
  assert.deepEqual([talk.text, talk.custom], ['New shipped words.', false], 'the new default stands; the old one was not pinned')
  assert.equal((await updated.view()).proposals?.find(one => one.id === first.id)?.state, 'stale')
  // Proposed over the new words, it applies, and the history says the words came from that proposal.
  r.writes()
  const second = await updated.proposeRules({ section: 'talk', add: 'Conclusion first.' })
  const view = await updated.decide({ id: second.id!, decision: 'apply' })
  talk = (await updated.rules()).sections.find(one => one.id === 'talk')!
  assert.equal(talk.text, 'New shipped words.\nConclusion first.')
  assert.equal(talk.history[0]!.proposal, second.id)
  assert.deepEqual(view.changes?.[0], { at: view.changes![0]!.at, by: 'person', what: 'rules', section: 'talk', version: 1, how: 'edit', proposal: second.id })
  const mode = await updated.proposeMode({ kind: 'stuck', mode: 'off' })
  const record = (await updated.decide({ id: mode.id!, decision: 'apply' })).changes?.[0]
  assert.equal(record?.what === 'mode' && record.proposal, mode.id)
})
