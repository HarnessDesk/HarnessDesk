import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeadJournal, leadBudgetProjection, canBeginLeadGoal, leadCheckpoint, parseLeadCheckpoint } from '@harnessdesk/lead'
import { LEAD_CONTROL_REFUSALS, parseLeadAcceptanceContract, type LeadSchedule, type LeadScheduledTask } from '@harnessdesk/protocol'
import { LeadPlanner, leadDueTask } from '../src/lead/planner.js'
import { LeadRepeats } from '../src/lead/repeats.js'
import { LeadFileJournal } from '../src/lead/journal.js'
import { LeadControls } from '../src/lead/controls.js'
import { freezeLeadPlan, leadContractDigest } from '../src/lead/assembly.js'

const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Update dependencies in acme-web',
  project: { id: 'acme-web', path: '/workspace/acme-web' }, policyRevision: 1, repeat: { every: 'mondays', at: '09:00' },
  steps: [{ id: 'step-1', title: 'Update dependencies', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'implementer', seat: { runtime: 'fixture' }, ceiling: 'edit' }, { role: 'review', agent: 'code-reviewer', seat: { runtime: 'reviewer' }, ceiling: 'read' }] }],
  assertions: [{ id: 'check', kind: 'check', description: 'Checks pass' }], caps: { usdMicros: 3_000_000, rounds: 3 } })
const approved = { ...contract, digest: leadContractDigest(contract) }
const task: LeadScheduledTask = { id: 'repeat-1', project: approved.project.path, title: 'Dependencies', goal: approved.goal,
  every: 'mondays', at: '09:00', enabled: true, lastRunAt: new Date(2026, 9, 5, 9).getTime(), approved: { contract: approved, contractDigest: approved.digest }, perRunCaps: approved.caps, runs: [] }
const memoryJournal = async () => {
  const records: any[] = [], journal = await createLeadJournal({ async read() { return records }, async append(record) { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'goal-1', caps: approved.caps, freshnessMs: 60_000 })
  return journal
}

test('a fresh approval of a stopped repeat turns it back on, keeping its history; a renewal does not', async () => {
  const planner = new LeadPlanner(await mkdtemp(join(tmpdir(), 'lead-repeat-')))
  await planner.approveRepeat(task.id, approved, 'goal-first', 100)
  await planner.control(task.id, 'stop')
  await planner.approveRepeat('repeat-other', approved, 'goal-second', 200, false)
  assert.equal((await planner.readSchedule()).tasks[0]!.enabled, false, 'a consent renewal leaves a stopped repeat stopped')
  const saved = (await planner.approveRepeat('repeat-other', approved, 'goal-third', 300)).tasks
  assert.equal(saved.length, 1)
  assert.equal(saved[0]!.id, task.id)
  assert.equal(saved[0]!.enabled, true)
  assert.equal(saved[0]!.paused, false)
  assert.deepEqual(saved[0]!.runs!.map(run => run.logicalGoalId), ['goal-first', 'goal-second', 'goal-third'])
})

test('a desk asleep over several slots coalesces to one newest slot, including a wake on another day', () => {
  const schedule: LeadSchedule = { version: 1, tasks: [task], quiet: null }, wake = new Date(2026, 9, 27, 8)
  const due = leadDueTask(schedule, wake)!
  assert.equal(due.slot, new Date(2026, 9, 26, 9).getTime())
  assert.equal(leadDueTask({ ...schedule, tasks: [{ ...task, lastRunAt: due.slot }] }, wake), null)
})

test('busy and paused slots are recorded once and never queue; stop ends the repeat', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lead-repeat-')), planner = new LeadPlanner(home), journal = await memoryJournal()
  await planner.writeSchedule({ version: 1, tasks: [{ ...task, approved: undefined, perRunCaps: undefined }], quiet: null })
  await planner.markRan(task.id, task.lastRunAt!)
  let starts = 0, now = new Date(2026, 9, 26, 10).getTime()
  const repeats = new LeadRepeats({ planner, journal, now: () => now, async start() { starts++; return { logicalGoalId: 'run-goal', approved: true } } })
  await journal.appendMessage('person', 'Existing work')
  await repeats.tick(); await repeats.tick()
  assert.equal(starts, 0)
  assert.equal((await planner.readSchedule()).tasks[0]!.runs!.length, 1)
  assert.equal((await planner.readSchedule()).tasks[0]!.runs![0]!.state, 'skipped')
  await assert.rejects(repeats.runNow(task.id), { wireCode: 'lead-request-in-flight' })
  await planner.control(task.id, 'pause')
  now = new Date(2026, 10, 2, 10).getTime(); await repeats.tick()
  assert.equal((await planner.readSchedule()).tasks[0]!.runs![1]!.reason, 'Paused')
  await planner.control(task.id, 'resume'); await planner.control(task.id, 'stop')
  assert.equal((await planner.readSchedule()).tasks[0]!.enabled, false)
  await assert.rejects(planner.control(task.id, 'resume'), /lead-repeat-missing/)
})

test('only the host retains digest-bound approvals and the last twelve runs across person edits', async () => {
  const planner = new LeadPlanner(await mkdtemp(join(tmpdir(), 'lead-repeat-')))
  await planner.approveRepeat(task.id, approved, 'goal-first', 100)
  for (let slot = 1; slot <= 13; slot++) await planner.recordRun(task.id, { slot, at: slot, state: 'started', logicalGoalId: `goal-${slot}` })
  await planner.settleRun('goal-13', 'accepted', 500_000, 2)
  let saved = (await planner.readSchedule()).tasks[0]!
  assert.equal(saved.runs!.length, 12)
  assert.equal(saved.runs!.at(-1)!.outcome, 'accepted')
  assert.equal(saved.runs!.at(-1)!.usdMicros, 500_000)
  const edited = await planner.writeSchedule({ version: 1, tasks: [{ ...saved, title: 'Renamed', runs: [] }], quiet: null })
  assert.equal(edited.tasks[0]!.runs!.length, 12)
  assert.equal(edited.tasks[0]!.approved!.contractDigest, approved.digest)
  saved = { ...edited.tasks[0]!, goal: 'Different work' }
  assert.equal((await planner.writeSchedule({ ...edited, tasks: [saved] })).tasks[0]!.approved, undefined)
})

test('a refused scheduled start consumes its slot once with fixed, safe prose', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lead-repeat-refused-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const planner = new LeadPlanner(home), journal = await memoryJournal()
  await planner.writeSchedule({ version: 1, tasks: [{ ...task, approved: undefined, perRunCaps: undefined }], quiet: null })
  await planner.markRan(task.id, task.lastRunAt!)
  const now = new Date(2026, 9, 26, 10).getTime(), slot = new Date(2026, 9, 26, 9).getTime()
  let starts = 0
  const refusal = Object.assign(new Error('<script>private user input</script>'), { wireCode: 'lead-key-missing' })
  const repeats = new LeadRepeats({ planner, journal, now: () => now, async start() { starts++; throw refusal } })
  await repeats.tick()
  const schedule = await planner.readSchedule()
  assert.deepEqual(JSON.parse(JSON.stringify(schedule.tasks[0]!.runs)), [{ slot, at: now, state: 'skipped', reason: 'The Lead could not start' }])
  assert.equal(schedule.tasks[0]!.lastRunAt, slot)
  assert.equal(leadDueTask(schedule, new Date(now)), null)
  await repeats.tick()
  assert.equal(starts, 1)
  assert.equal((await planner.readSchedule()).tasks[0]!.runs!.length, 1)
  await assert.rejects(repeats.runNow(task.id), error => error === refusal)
  assert.deepEqual((await planner.readSchedule()).tasks[0]!.runs, schedule.tasks[0]!.runs, 'a refused person attempt leaves schedule history untouched')
})

test('a scheduled title or goal that holds a secret is refused before anything reaches the thread', async () => {
  for (const edit of [{ goal: 'Update dependencies with sk-ant-synthetic-key' }, { title: 'Bearer sk-ant-synthetic-key' }]) {
    const journal = await memoryJournal(); let statusRead = false
    const controls = new LeadControls({ journal, project: approved.project, model: 'fixture', now: () => 100, nextId: () => 'unused', push() {},
      service: { async status() { statusRead = true; return { configured: true, protection: 'encrypted' as const } }, async assertPublic() {}, async send() { return { status: 'completed' as const } } } as any,
      async decidePerson() {}, async decideResult() {} })
    try {
      await assert.rejects(controls.runScheduled({ ...task, ...edit, approved: undefined }, 100), { wireCode: 'lead-secret-refused' })
      assert.equal(statusRead, false); assert.equal(journal.state.messages.length, 0); assert.equal(journal.state.origin, null)
    } finally { controls.close() }
  }
})

test('a pause or schedule edit made while a scheduled start is admitted waits for that start', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lead-repeat-serial-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const planner = new LeadPlanner(home), journal = await memoryJournal()
  await planner.writeSchedule({ version: 1, tasks: [{ ...task, approved: undefined, perRunCaps: undefined }], quiet: null })
  await planner.markRan(task.id, task.lastRunAt!)
  let release!: () => void, entered!: () => void
  const admitted = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const seen: (boolean | undefined)[] = []
  const repeats = new LeadRepeats({ planner, journal, now: () => new Date(2026, 9, 26, 10).getTime(), async start(started) {
    entered(); await held
    seen.push((await planner.readSchedule()).tasks.find(one => one.id === started.id)!.paused)
    return { logicalGoalId: 'run-goal', approved: true }
  } })
  const tick = repeats.tick(); await admitted
  const edit = repeats.write({ version: 1, tasks: [{ ...task, approved: undefined, perRunCaps: undefined, title: 'Renamed' }], quiet: null })
  const pause = repeats.control(task.id, 'pause')
  await new Promise(resolve => setTimeout(resolve, 20))
  const during = (await planner.readSchedule()).tasks[0]!
  assert.equal(during.paused ?? false, false, 'the pause has not overtaken the start being admitted'); assert.equal(during.title, task.title)
  release(); await tick; await pause; await edit
  assert.deepEqual(seen.map(value => value ?? false), [false])
  const after = (await planner.readSchedule()).tasks[0]!
  assert.equal(after.paused, true); assert.equal(after.title, 'Renamed'); assert.equal(after.runs!.at(-1)!.state, 'started')
})

test('changed policy, seats or source invoke fresh planning without freezing the stale approval', async () => {
  for (const reason of ['The permissions changed', 'The seats changed', 'The Flow source changed']) {
    const journal = await memoryJournal(); let frozen = false, calls = 0
    const controls = new LeadControls({ journal, project: approved.project, model: 'fixture', now: () => 100, nextId: () => `id-${++calls}`, push() {},
      service: { async status() { return { configured: true, protection: 'encrypted' as const } }, async setKey() {}, async deleteKey() {}, async assertPublic() {}, async send() { return { status: 'completed' as const, text: 'A fresh plan is needed' } } } as any,
      async decidePerson() {}, async decideResult() {}, async validateRepeat() { return reason }, async freezeRepeat() { frozen = true; throw new Error('stale seats refused') } })
    const result = await controls.runScheduled(task, 100)
    assert.equal(result.approved, false); assert.equal(result.reason, reason); assert.equal(frozen, false)
    await controls.idle(); controls.close()
    assert.ok(journal.state.messages.some(message => message.text.includes(reason)))
  }
})

test('a redeemed repeat gets fresh ids, revision, per-run budget and slot-local consent', async () => {
  const journal = await memoryJournal(); let calls = 0
  const controls = new LeadControls({ journal, project: approved.project, model: 'fixture', now: () => 100, nextId: () => `id-${++calls}`, push() {},
    service: { async status() { return { configured: true, protection: 'encrypted' as const } }, async setKey() {}, async deleteKey() {}, async assertPublic() {}, async send() { return { status: 'completed' as const } } } as any,
    async decidePerson() {}, async decideResult() {}, async validateRepeat() { return null }, async freezeRepeat(contract) { return { ...contract, digest: leadContractDigest(contract) } } })
  assert.equal((await controls.runScheduled(task, 100)).approved, true)
  await controls.idle(); controls.close()
  assert.notEqual(journal.state.contract!.steps[0]!.id, approved.steps[0]!.id)
  assert.ok(journal.state.contract!.revision > approved.revision)
  assert.equal(journal.state.consent!.expiresAt, 100 + 86_400_000)
  assert.deepEqual(journal.state.budget!.caps, approved.caps)
  assert.equal(journal.state.budget!.roundsAdmitted, 0)
})

test('a repeat can start again after its first goal is accepted', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lead-repeat-restart-')), disk = await LeadFileJournal.open(home, 'thread')
  t.after(async () => { await disk.close(); await rm(home, { recursive: true, force: true }) })
  const journal = await createLeadJournal(disk)
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'goal-1', caps: approved.caps, freshnessMs: 60_000 })
  let calls = 0, now = 100
  const controls = new LeadControls({ journal, project: approved.project, model: 'fixture', now: () => now, nextId: () => `id-${++calls}`, push() {},
    service: { async status() { return { configured: true, protection: 'encrypted' as const } }, async setKey() {}, async deleteKey() {}, async assertPublic() {}, async send() { return { status: 'completed' as const } } } as any,
    async stopRequest() { await journal.recover(async attempt => journal.state.runs.filter(run => run.correlationId === attempt.correlationId).map(run => ({ ...run, firstRoundId: 'run-1:round:1', terminal: true }))) },
    async decidePerson() {}, async decideResult() {}, async validateRepeat() { return null }, async freezeRepeat(contract) { return { ...contract, digest: leadContractDigest(contract) } } })
  try {
    await journal.offerCard({ version: 1, id: 'person-plan', revision: 1, type: 'plan', contractDigest: approved.digest, contract: approved })
    await controls.decide({ version: 1, cardId: 'person-plan', cardType: 'plan', expectedRevision: 1, contractDigest: approved.digest, choice: 'approve' })
    await controls.idle()
    const first = journal.state.contract!, firstGoal = journal.state.budget!.logicalGoalId
    await journal.offerCard({ version: 1, id: 'first-warning', revision: 1, type: 'allowance-warning', contractDigest: first.digest,
      logicalGoalId: firstGoal, usdMicros: 2400000, caps: first.caps })
    await journal.offerCard({ version: 1, id: 'first-look', revision: 1, type: 'second-look', contractDigest: first.digest,
      logicalGoalId: firstGoal, runId: 'run-1', stopKey: 'stop-1', said: 'Blocked on #231', found: '#231 merged', did: 'Restarted' })
    const step = first.steps[0]!, run = { correlationId: 'start-1', runId: 'run-1', teamId: 'team-1' }
    const result = await journal.execute({ id: run.correlationId, stepId: step.id,
      request: { method: 'flow/start-goal', params: { root: first.project.path, source: 'synthetic recipe', token: 'preview-1', sentence: first.goal, vars: {}, attended: true,
        seats: Object.fromEntries(step.assignments.map(one => [one.role, [one.seat]])) }, project: first.project, runId: null, start: step },
      context: { desk: journal.state.policy!, projectPolicy: null, project: first.project, approved: null, now, policyInterpretation: 'idle', budget: null } }, async () => {
        await journal.updateBudget({ version: 1, type: 'bind', now, startId: run.correlationId, goalId: run.teamId, executionId: run.runId, firstRoundId: 'run-1:round:1' })
        return { value: null, identity: run }
      })
    assert.equal(result.outcome, 'succeeded')
    await journal.updateBudget({ version: 1, type: 'observe', now, at: now, revision: 1, source: 'worker-samples', sourceIds: ['sample-1'], goalId: run.teamId, executionIds: [run.runId], quality: 'known', usdMicros: 0, terminal: true })
    await journal.offerCard({ version: 1, id: 'first-result', revision: 1, type: 'result', contractDigest: first.digest, outcome: 'reviewed', summary: 'Checks pass',
      assertions: [{ assertionId: 'check', status: 'passed', revision: 1, contractRevision: first.revision, evidence: [{ kind: 'check', id: 'check-1', revision: 'head-1' }], reason: null }], budget: leadBudgetProjection(journal.state.budget!, now) })
    await journal.decideCard({ version: 1, cardId: 'first-result', cardType: 'result', expectedRevision: 1, contractDigest: first.digest, choice: 'accept' })
    assert.equal(canBeginLeadGoal(journal.state), true)
    await assert.rejects(controls.raiseBudget({ logicalGoalId: firstGoal, caps: { ...first.caps, usdMicros: first.caps.usdMicros + 100 }, expectedRevision: journal.state.seq }), { wireCode: 'lead-thread-closed' })
    now = 200
    const second = await controls.runScheduled(task, now)
    assert.equal(second.approved, true)
    assert.notEqual(second.logicalGoalId, firstGoal)
    await controls.idle()
    const thread = (await controls.readThread()).thread
    assert.deepEqual(thread.decisions!.filter(one => one.choice === undefined).map(one => one.card.id), ['first-warning', 'first-look'])
    assert.equal(thread.budget!.logicalGoalId, second.logicalGoalId)
    const replayed = await createLeadJournal(disk)
    assert.deepEqual(replayed.state.decisionMessages, journal.state.decisionMessages)
    assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(journal.state, '0'.repeat(64))).state.decisionMessages, journal.state.decisionMessages)
  } finally { controls.close() }
})

test('a scheduled origin keeps its readable event separate from the idempotency key and omits a duplicate goal line', async () => {
  for (const goal of [task.title, 'Update the dependencies in acme-web']) {
    const journal = await memoryJournal()
    const controls = new LeadControls({ journal, project: approved.project, model: 'fixture', now: () => 100, nextId: () => 'unused', push() {},
      service: { async status() { return { configured: true, protection: 'encrypted' as const } }, async assertPublic() {}, async send() { return { status: 'completed' as const } } } as any,
      async decidePerson() {}, async decideResult() {} })
    try {
      await controls.runScheduled({ ...task, goal, approved: undefined }, 100)
      await controls.idle()
      assert.deepEqual(journal.state.origin, { source: 'schedule', event: 'scheduled-run', subject: '100', url: null })
      assert.equal(journal.state.originKey, `schedule-${task.id}-100`)
      assert.equal(journal.state.messages[0]!.text, goal === task.title ? `Scheduled: ${task.title}` : `Scheduled: ${task.title}\n${goal}`)
    } finally { controls.close() }
  }
})


test('a new repeat catches its first Monday slot when the desk wakes Tuesday', () => {
  const createdAt = new Date(2026, 9, 23, 12).getTime(), wake = new Date(2026, 9, 27, 8)
  const due = leadDueTask({ version: 1, tasks: [{ ...task, createdAt, lastRunAt: null }], quiet: null }, wake)
  assert.equal(due!.slot, new Date(2026, 9, 26, 9).getTime())
  assert.equal(leadDueTask({ version: 1, tasks: [{ ...task, createdAt: new Date(2026, 9, 27, 7).getTime(), lastRunAt: null }], quiet: null }, wake), null)
})

test('a stopped run history accepts late final usage after its outcome was recorded', async () => {
  const planner = new LeadPlanner(await mkdtemp(join(tmpdir(), 'lead-repeat-final-')))
  await planner.approveRepeat(task.id, approved, 'goal-first', 100)
  await planner.settleRun('goal-first', 'stopped', undefined, 1)
  assert.equal((await planner.readSchedule()).tasks[0]!.runs![0]!.usdMicros, undefined)
  await planner.settleRun('goal-first', 'stopped', 750_000, 1)
  assert.equal((await planner.readSchedule()).tasks[0]!.runs![0]!.usdMicros, 750_000)
  await planner.settleRun('goal-first', 'stopped', 700_000, 1)
  assert.equal((await planner.readSchedule()).tasks[0]!.runs![0]!.usdMicros, 750_000, 'cumulative final cost cannot move backwards')
})


test('run-now exposes closed, actionable missing-repeat and quiet-hours refusals', async () => {
  const planner = new LeadPlanner(await mkdtemp(join(tmpdir(), 'lead-repeat-refusal-'))), journal = await memoryJournal()
  const repeats = new LeadRepeats({ planner, journal, now: () => new Date(2026, 9, 26, 10).getTime(),
    async start() { throw new Error('Refused runs must not start') } })
  for (const enabled of [true, false]) {
    await planner.writeSchedule({ version: 1, tasks: enabled ? [] : [{ ...task, enabled }], quiet: null })
    await assert.rejects(repeats.runNow(task.id), { wireCode: 'lead-repeat-missing' })
  }
  await planner.writeSchedule({ version: 1, tasks: [task], quiet: { from: '09:00', to: '11:00' } })
  await assert.rejects(repeats.runNow(task.id), { wireCode: 'lead-repeat-quiet' })
  await planner.control(task.id, 'stop')
  await assert.rejects(planner.control(task.id, 'resume'), { wireCode: 'lead-repeat-missing' })
  for (const code of ['lead-repeat-missing', 'lead-repeat-quiet']) assert.ok((LEAD_CONTROL_REFUSALS as readonly string[]).includes(code))
})


test('a frozen repeat keeps its digest through approval and disk read, but refuses disk tampering', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lead-repeat-digest-')), project = { id: 'acme-web', path: join(home, 'acme-web') }
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(project.path)
  const frozen = await freezeLeadPlan({ ...contract, project })
  assert.equal(frozen.publicationRepository, null, 'a local-only plan freezes an explicit no-publication pin')
  const journal = await memoryJournal(), planner = new LeadPlanner(home)
  // The loop parses the freezer output before offering the ordinary plan card.
  const card = await journal.offerCard({ version: 1, id: 'repeat-plan', revision: 1, type: 'plan', contractDigest: frozen.digest, contract: parseLeadAcceptanceContract(frozen) })
  assert.ok(card.type === 'plan')
  await journal.decideCard({ version: 1, cardId: card.id, cardType: 'plan', expectedRevision: 1, contractDigest: card.contractDigest, choice: 'approve' }, 1000)
  await planner.approveRepeat('repeat-1', card.contract, journal.state.budget!.logicalGoalId, 100)
  const stored = (await planner.readSchedule()).tasks[0]!
  assert.equal(leadContractDigest(stored.approved!.contract), stored.approved!.contract.digest, 'the host integrity check must accept the saved approval')
  assert.deepEqual(stored.approved!.contract, frozen)
  assert.equal(stored.approved!.contractDigest, frozen.digest)

  const file = join(home, 'lead', 'schedule.json'), edited = JSON.parse(await readFile(file, 'utf8'))
  edited.tasks[0].approved.contract.steps[0].title = 'Different work in acme-web'
  await writeFile(file, JSON.stringify(edited))
  const tampered = (await planner.readSchedule()).tasks[0]!
  assert.notEqual(leadContractDigest(tampered.approved!.contract), tampered.approved!.contract.digest)
  const nextJournal = await memoryJournal()
  const controls = new LeadControls({ journal: nextJournal, project, model: 'fixture', now: () => 101, nextId: () => 'unused', push() {},
    service: { async status() { return { configured: true, protection: 'encrypted' as const } }, async setKey() {}, async deleteKey() {}, async assertPublic() {}, async send() { return { status: 'completed' as const } } } as any,
    async decidePerson() {}, async decideResult() {},
    async validateRepeat(value) { return leadContractDigest(value) === value.digest ? null : 'The approved contract could not be verified' },
    async freezeRepeat() { throw new Error('A tampered approval must never be redeemed') } })
  t.after(() => controls.close())
  const result = await controls.runScheduled(tampered, 101)
  assert.equal(result.approved, false)
  assert.equal(result.reason, 'The approved contract could not be verified')
  assert.equal(nextJournal.state.consent, null)
  assert.equal(nextJournal.state.contract, null)
  await controls.idle()
})
