import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { createLeadJournal, type LeadJournalRecord, type LeadPermissionCall, type LeadPermissionContext } from '@harnessdesk/lead'
import type { LeadAutonomyKind, LeadAutonomyMode, LeadScheduledTask, WireNotification } from '@harnessdesk/protocol'
import { evidenceDesk } from './fixtures/evidence-desk.js'

/**
 * The autonomy table through the real host: the mode is set with the host's own settings method, the real trigger is
 * fired, and each wiring point (the repeat tick, the work reminder, the mention door, the brief) has to honour it.
 * Deleting the `gate` call at any of those points in `host.ts` makes the matching test fail.
 */
const rig = async (t: TestContext) => {
  const { StateStore } = await import('../src/index.js')
  const { tempDir } = await import('./scratch.js')
  const state = new StateStore(`${tempDir('hd-lead-autonomy-state-')}/state.json`)
  const desk = await evidenceDesk(t, { leadEnabled: true, state })
  const project = { id: 'project-demo', path: await realpath(desk.repo.dir) }
  const records: LeadJournalRecord[] = []
  const journal = await createLeadJournal({ read: async () => records, append: async record => { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'ordinary-delegation', now: Date.now(), caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null, budget: null, now: Date.now(), policyInterpretation: 'idle' })
  const service = desk.host.createLeadService({ journal, project, prices: {},
    resolveTool: async () => ({ project, runId: null, start: null, stepId: null, context: context() }),
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }),
  })
  await service.setEnabled(true)
  const notifications: WireNotification[] = []
  desk.host.addBroadcaster(notification => { notifications.push(notification) })
  let attempt = 0
  const execute = (call: LeadPermissionCall) => journal.execute({ id: `auto-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
    async parsed => ({ value: await desk.host.call(parsed.method, parsed.params as never), identity: null }))
  const setMode = (kind: LeadAutonomyKind, mode: LeadAutonomyMode) => desk.host.call('lead/autonomy/set', { kind, mode })
  const observed = () => journal.state.wakes.filter(wake => wake.observed)
  return { ...desk, project, journal, execute, notifications, setMode, observed }
}

const MODES = ['off', 'observe', 'act'] as const

test('host wiring: a due repeat honours the mode the person set', async t => {
  for (const mode of MODES) {
    const r = await rig(t)
    const set = await r.setMode('repeat', mode); assert.equal(set.modes.repeat, mode)
    const task: LeadScheduledTask = { id: 'repeat-1', project: r.project.path, title: 'Dependencies', goal: 'Update dependencies', every: 'day', at: '00:00',
      enabled: true, lastRunAt: 1, runs: [] }
    // A new task begins with today's slot only if it was made before it; make it, then let a day go by.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    await r.host.call('lead/schedule/update', { schedule: { version: 1, tasks: [task], quiet: null } })
    t.mock.timers.setTime(Date.now() + 26 * 3_600_000)
    await r.host.leadTick()
    t.mock.timers.reset()
    const run = (await r.host.call('lead/schedule/read', {})).tasks[0]!.runs!.at(-1)
    assert.ok(run, `${mode}: the due slot was taken`)
    // Act goes on to start the run (which this rig has no key to do); Off and Observe stop at the setting and say so.
    assert.equal(/Lead settings/.test(run.reason ?? ''), mode !== 'act', `${mode}: ${run.state} ${run.reason ?? ''}`)
    assert.equal(r.observed().filter(wake => wake.observed === 'repeat').length, mode === 'observe' ? 1 : 0, mode)
  }
})

test('host wiring: a due work reminder honours the mode the person set', async t => {
  for (const mode of MODES) {
    const r = await rig(t)
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    await r.setMode('repeat', mode)
    assert.equal((await r.execute({ method: 'lead/chat/start', params: { text: `Investigate the flaky sync test, ${mode}`, cause: 'person' } })).outcome, 'succeeded')
    assert.equal((await r.execute({ method: 'lead/work/note', params: { id: 'work-1', note: 'Check back', remindAt: Date.now() + 3_600_000 } })).outcome, 'succeeded')
    t.mock.timers.setTime(Date.now() + 2 * 3_600_000)
    await r.host.leadTick()
    // Off and Observe take the reminder as seen; Act tries to deliver it, and this rig has no key, so it stays due for a retry.
    const stillDue = (await r.host.leadWork.dueReminders()).length
    assert.equal(stillDue, mode === 'act' ? 1 : 0, `${mode}: ${stillDue} reminder(s) still due`)
    assert.equal(r.observed().filter(wake => wake.observed === 'repeat').length, mode === 'observe' ? 1 : 0, mode)
    t.mock.timers.reset()
  }
})

test('host wiring: a mention offered to the Lead honours the mode the person set', async t => {
  for (const mode of MODES) {
    const r = await rig(t)
    await r.setMode('mention', mode)
    const fact = { source: 'mention' as const, event: 'comment', subject: '7', url: 'https://github.com/acme/web/issues/7', title: 'Bug', body: 'Please look', action: 'commented', thread: 'issue' as const }
    const delivery = await r.host.leadOfferTrigger({ key: `k-${mode}`, project: r.project.path, sentence: '@lead look', fact: fact as never })
    const refusedByMode = !delivery.delivered && /Mention triggers/.test((delivery as { reason?: string }).reason ?? '')
    assert.equal(refusedByMode, mode !== 'act', `${mode}: ${JSON.stringify(delivery)}`)
    assert.equal(r.observed().filter(wake => wake.observed === 'mention').length, mode === 'observe' ? 1 : 0, mode)
  }
})

test('host wiring: the morning brief honours the mode the person set', async t => {
  for (const mode of MODES) {
    const r = await rig(t)
    await r.setMode('brief', mode)
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    await r.host.leadPresence.updateBrief({ enabled: true, at: '00:00' })
    t.mock.timers.setTime(Date.now() + 26 * 3_600_000)
    await r.host.leadTick()
    t.mock.timers.reset()
    const sent = r.notifications.some(one => one.method === 'lead/presence/changed' && !!one.params.notice)
    assert.equal(sent, mode === 'act', `${mode}: the brief ${sent ? 'went out' : 'stayed home'}`)
    assert.equal(r.observed().filter(wake => wake.observed === 'brief').length, mode === 'observe' ? 1 : 0, mode)
  }
})

