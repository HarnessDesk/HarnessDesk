import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeRepo } from './fixtures/evidence-desk.js'
import { readChecks } from '../src/evidence/checks-file.js'
import test from 'node:test'
import { createLeadJournal, evaluateLeadAcceptance, type LeadJournalRecord, type LeadPermissionCall } from '@harnessdesk/lead'
import { LEAD_LIMITS, parseLeadAcceptanceContract } from '@harnessdesk/protocol'
import { freezeLeadPlan, LEAD_DEFAULT_CAPS, LEAD_LEGACY_DEFAULT_USD_MICROS, LeadAssembly, leadSpendLimitMigration, leadPreviewUnfit, leadProjectOf, leadSeatable, leadSeatChoices, readLeadEvidence, type LeadAssemblyOptions } from '../src/lead/assembly.js'
import { tempDir } from './scratch.js'

const project = { id: 'acme', path: '/work/acme' }
const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Make the retry list complete', project, policyRevision: 1,
  steps: [{ id: 'work', title: 'Complete the list', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'implementer', seat: { runtime: 'fixture' }, ceiling: 'edit' }, { role: 'review', agent: 'code-reviewer', seat: { runtime: 'fixture' }, ceiling: 'read' }] }],
  assertions: [{ id: 'unit', kind: 'check', description: 'Tests pass' }, { id: 'review', kind: 'review', description: 'Review approves' }, { id: 'blockers', kind: 'blocking-findings', description: 'No blockers' }],
  caps: { usdMicros: 1_000_000, rounds: 16 } })
const evidenceJournal = async () => {
  const records: LeadJournalRecord[] = []
  const journal = await createLeadJournal({ async read() { return records }, async append(record) { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 60_000 })
  return journal
}
const fact = (id: string, kind: 'check' | 'review', at: string, freshness: 'fresh' | 'stale', more: object = {}) =>
  ({ record: { id, fact: { kind, at, ...more } }, freshness: { state: freshness } })
const reads = (cards: unknown[], blocking = false, embargoed = false) => async (call: LeadPermissionCall): Promise<unknown> => {
  if (call.method === 'goal/read') return { board: { intents: [{ id: 1, state: 'done', note: 'Verified from tests and diff.' }] } }
  if (call.method === 'flow/execution') return { rounds: [{ cards: [1] }] }
  if (call.method === 'evidence/board') return { cards }
  if (call.method === 'finding/run') return { blocking, embargoed }
  throw new Error(`unexpected read ${call.method}`)
}

test('evidence preserves missing and stale facts separately from complete negative verdicts', async () => {
  const journal = await evidenceJournal()
  const repo = await makeRepo('lead-required-checks-')
  await mkdir(join(repo.dir, '.harnessdesk'))
  await writeFile(join(repo.dir, '.harnessdesk/checks.yml'), 'unit: { run: node unit.mjs }\nlint: { run: node lint.mjs }\n')
  await repo.git('add', '.harnessdesk')
  await repo.git('commit', '-qm', 'Declare required checks')
  const revision = await repo.git('rev-parse', 'HEAD'), file = await readChecks(repo.dir)
  const check = (name: string, more: object = {}) => fact(name, 'check', revision, 'fresh', { name, run: `node ${name}.mjs`, digest: file.digest, exit: 0, counted: true, ...more })
  const reviewed = fact('r1', 'review', revision, 'fresh', { verdict: 'approve' })
  // No run or contract yet: nothing to read, nothing guessed.
  assert.equal((await readLeadEvidence(journal, 'run-1', reads([]), () => 1000)).complete, false)
  const withRun = { state: { ...journal.state, contract: { ...contract, project: { ...project, path: repo.dir } }, runs: [{ runId: 'run-1', teamId: 'team-1', correlationId: 'c1' }] } } as unknown as Pick<typeof journal, 'state'>
  const read = (cards: unknown[]) => readLeadEvidence(withRun, 'run-1', reads(cards), () => 1000)
  assert.equal((await read([])).revision, '', 'no review yet')
  assert.equal((await read([{ card: 1, facts: [reviewed] }])).checks.length, 0, 'no check fact')
  assert.equal((await read([{ card: 1, facts: [fact('r1', 'review', revision, 'fresh', { verdict: 'approve' }), fact('c1', 'check', revision, 'stale', { exit: 0 })] }])).checks[0]!.complete, false, 'a stale check')
  assert.equal((await read([{ card: 1, facts: [fact('r1', 'review', revision, 'fresh', { verdict: 'approve' }), fact('c0', 'check', 'old', 'fresh', { exit: 0 })] }])).checks[0]!.revision, 'old', 'a check for another revision')
  for (const facts of [
    [reviewed, check('unit')],
    [reviewed, check('unit'), check('lint', { run: 'node another.mjs' })],
    [reviewed, check('unit'), check('lint', { digest: 'wrong' })],
  ]) assert.equal((await read([{ card: 1, facts }])).checks.every(check => check.complete), false, 'every declared check needs matching evidence')
  const complete = await read([{ card: 1, facts: [reviewed, check('unit'), check('lint')] }])
  for (const patch of [{ counted: false }, { exit: 1 }, { timedOut: true }, { exit: null }]) {
    const negative = await read([{ card: 1, facts: [reviewed, check('unit'), check('lint', patch)] }])
    assert.equal(negative.complete, true, 'a negative verdict does not make the read incomplete')
    assert.ok(negative.checks.every(check => check.complete))
  }
  assert.equal(complete.reviews[0]!.text, 'Verified from tests and diff.')
  assert.equal(complete.complete, true)
  assert.equal(complete.revision, revision)
  assert.equal(complete.checks.length, 2)
  assert.deepEqual(complete.reviews.map(one => [one.assertionId, one.verdict]), [['review', 'approve']])
  const incomplete = await read([{ card: 1, facts: [reviewed, check('unit', { exit: 1 })] }])
  const unknown = evaluateLeadAcceptance(withRun.state.contract!, incomplete, { now: 1000, freshnessMs: 50, revision: 1 })
  assert.equal(unknown.assertions[0]!.status, 'unknown', 'the missing lint sibling makes the failed unit fact incomplete')
  assert.equal(unknown.checksCouldNotRun, false, 'an incomplete negative verdict is not runner-only trouble')

  const rereviewCards = [{ card: 1, facts: [reviewed, check('unit'), check('lint')] },
    { card: 2, facts: [fact('r2', 'review', revision, 'fresh', { verdict: 'approve' })] },
    { card: 3, facts: [fact('r3', 'review', revision, 'fresh', { verdict: 'approve' })] }]
  const rereviewed = await readLeadEvidence(withRun, 'run-1', async call => {
    if (call.method === 'flow/execution') return { rounds: [{ cards: [1] }, { cards: [2, 3] }] }
    if (call.method === 'goal/read') return { board: { intents: [
      { id: 1, state: 'done', note: 'This should work.' },
      { id: 2, state: 'done', note: 'Verified the required checks.' },
      { id: 3, state: 'done', note: 'Verified the committed diff.' },
    ] } }
    return reads(rereviewCards)(call)
  }, () => 1000)
  assert.deepEqual(rereviewed.reviews.map(review => review.id), ['r2', 'r3'], 'all reviewers in the new round supersede the earlier hedge at the same commit')
  assert.equal(evaluateLeadAcceptance(withRun.state.contract!, rereviewed, { now: 1000, freshnessMs: 50, revision: 1 }).status, 'reviewed')
})

test('plans freeze to the sha256 of their canonical JSON, projects are named by path and seats come from ready runtimes', async () => {
  const frozen = await freezeLeadPlan({ ...contract, digest: '0'.repeat(64) })
  assert.match(frozen.digest, /^[0-9a-f]{64}$/)
  assert.notEqual(frozen.digest, '0'.repeat(64))
  assert.deepEqual(leadProjectOf('/work/acme'), leadProjectOf('/work/acme'))
  assert.notEqual(leadProjectOf('/work/acme').id, leadProjectOf('/work/other').id)
  assert.equal(leadSeatChoices([]), undefined)
  assert.deepEqual(leadSeatChoices(['fixture'])?.implement.map(seat => seat.runtime), ['fixture'])
})

test('a plan that could never be accepted is refused before any card, with its own code', async t => {
  const home = tempDir('lead-assembly-seats-'), checked: string[] = []
  let freeze!: (value: typeof contract) => Promise<typeof contract>
  let unfit: 'lead-plan-unseatable' | 'lead-plan-not-independent' | null = 'lead-plan-unseatable'
  const assembly = new LeadAssembly({ home, now: () => 1, workspace: async () => contract.project.path, readySeats: () => ['fixture'], heldPreview: () => null,
    seatsHold: async (_root, step) => { checked.push(step.id); return unfit }, create: async inputs => { freeze = inputs.freezePlan } })
  t.after(() => assembly.close())
  await assembly.ensure()
  await assert.rejects(freeze(contract), (error: any) => error.wireCode === 'lead-plan-unseatable')
  unfit = 'lead-plan-not-independent'
  await assert.rejects(freeze(contract), (error: any) => error.wireCode === 'lead-plan-not-independent')
  unfit = null
  assert.match((await freeze(contract)).digest, /^[0-9a-f]{64}$/)
  assert.deepEqual(checked, [contract.steps[0]!.id, contract.steps[0]!.id, ...contract.steps.map(step => step.id)])
})

test('a seat passed over only for its provider is a plan that is not independent, not one that cannot hold', () => {
  const held = { level: 'read', hold: 'held' }
  const writer = { role: 'implement', plan: { id: 'implementer', from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'edit', hold: 'held' },
    candidates: [{ seat: { runtime: 'fixture' }, label: 'Fixture', runtimeName: 'Fixture', state: 'taken', reason: null, fix: null, ceiling: { level: 'edit', hold: 'held' } }] } }
  const reviewer = (reasons: readonly (string | null)[], winner: number | null) => ({ role: 'review', plan: { id: 'code-reviewer', from: 'prefer', winner, blocked: null, ceiling: winner === null ? null : held,
    candidates: reasons.map(kind => ({ seat: { runtime: 'fixture' }, label: 'Fixture', runtimeName: 'Fixture', state: kind ? 'passed' : 'taken', reason: kind ? { kind } : null, fix: null, ceiling: held })) } })
  const preview = (review: object, token: string | null = null): any => ({ token, seats: [writer, review] })
  assert.equal(leadPreviewUnfit(preview(reviewer(['sameProvider'], null))), 'lead-plan-not-independent')
  assert.equal(leadPreviewUnfit(preview(reviewer(['unknownProvider', 'sameProvider'], null))), 'lead-plan-not-independent')
  // A seat that also failed for another reason is still a permissions answer.
  assert.equal(leadPreviewUnfit(preview(reviewer(['sameProvider', 'readOnlyUnheld'], null))), 'lead-plan-unseatable')
  assert.equal(leadPreviewUnfit(null), 'lead-plan-unseatable')
  assert.equal(leadPreviewUnfit(preview(reviewer([null], 0))), 'lead-plan-unseatable')
  assert.equal(leadPreviewUnfit(preview(reviewer([null], 0), 'token')), null)
})

test('a Lead plan may name a runtime stopped while idle, never one that cannot start', () => {
  assert.equal(leadSeatable({ state: 'ready' }), true)
  assert.equal(leadSeatable({ state: 'idle' }), true)
  assert.equal(leadSeatable({ state: 'starting' }), true)
  assert.equal(leadSeatable({ state: 'unavailable' }), false)
})

test('restoring an existing Lead starts its host owners without creating a fresh thread or provider request', async () => {
  const home = tempDir('hd-lead-restore-'), project = tempDir('hd-lead-project-')
  let created = 0
  const options = { home, now: () => 100, workspace: async () => project, readySeats: () => [], heldPreview: () => null,
    async create() { created++ } }
  const fresh = new LeadAssembly(options)
  assert.equal(typeof (fresh as any).restore, 'function')
  await (fresh as any).restore()
  assert.equal(created, 0)
  await fresh.ensure(); await fresh.close()
  assert.equal(created, 1)
  const restored = new LeadAssembly({ ...options, workspace: async () => null })
  await (restored as any).restore()
  assert.equal(created, 2)
  await restored.close()
})

test('assembly resolves ordinary chat tools without a Flow step while an approved step is running', async t => {
  let inputs!: Parameters<LeadAssemblyOptions['create']>[0]
  const assembly = new LeadAssembly({ home: tempDir('lead-assembly-chat-step-'), now: () => 100,
    workspace: async () => contract.project.path, readySeats: () => ['fixture'], heldPreview: () => null,
    create: async value => { inputs = value } })
  t.after(() => assembly.close())
  await assembly.ensure()
  const approved = await inputs.freezePlan({ ...contract, project: inputs.project })
  await inputs.journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: approved.digest, contract: approved })
  await inputs.journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: approved.digest, choice: 'approve' }, 1000)
  const call = { method: 'flow/start-goal' as const, params: { root: inputs.project.path, source: 'synthetic recipe', token: 'preview-1',
    sentence: approved.goal, vars: {}, attended: true, seats: { implement: [{ runtime: 'fixture' }], review: [{ runtime: 'fixture' }] } } }
  const resolved = await inputs.resolveTool(call)
  assert.equal(resolved.stepId, 'work')
  assert.equal(resolved.start?.id, 'work')
  const started = await inputs.journal.execute({ id: 'flow-start', request: { ...call, ...resolved }, context: resolved.context, stepId: resolved.stepId },
    async () => ({ value: {}, identity: { correlationId: 'flow-start', runId: 'run-1', teamId: 'team-1' } }))
  assert.equal(started.outcome, 'succeeded')
  assert.equal(inputs.journal.state.steps[0]!.state, 'started')
  const flow = await inputs.resolveTool({ method: 'flow/execution/stop', params: { run: 'run-1' } })
  assert.equal(flow.stepId, 'work')
  assert.equal(flow.runId, 'run-1')
  const chats = await Promise.all((['list', 'read', 'start', 'send', 'stop'] as const).map(async method => {
    const tool = await inputs.resolveTool({ method: `lead/chat/${method}`, params: { id: 'fixture:chat', text: 'Inspect' } })
    return { method, stepId: tool.stepId, start: tool.start }
  }))
  assert.deepEqual(chats, ['list', 'read', 'start', 'send', 'stop'].map(method => ({ method, stepId: null, start: null })))
})

test('a new desk records the spending limit Off, and a plan frozen there carries no dollar limit', async t => {
  let inputs!: Parameters<LeadAssemblyOptions['create']>[0]
  const assembly = new LeadAssembly({ home: tempDir('lead-assembly-spend-off-'), now: () => 100,
    workspace: async () => contract.project.path, readySeats: () => ['fixture'], heldPreview: () => null,
    create: async value => { inputs = value } })
  t.after(() => assembly.close())
  await assembly.ensure()
  assert.deepEqual(inputs.journal.state.spendLimit, { usdMicros: null })
  assert.deepEqual(inputs.journal.state.budget!.caps, LEAD_DEFAULT_CAPS)
  assert.equal(LEAD_DEFAULT_CAPS.usdMicros, LEAD_LIMITS.maxUsdMicros)
  const frozen = await inputs.freezePlan({ ...contract, project: inputs.project, caps: { usdMicros: 1_000_000, rounds: 4 } })
  assert.deepEqual(frozen.caps, { usdMicros: LEAD_LIMITS.maxUsdMicros, rounds: 4 }, 'the card shows the plan with no limit, not the Lead\'s figure')
  await inputs.journal.setSpendLimit(3_000_000, inputs.journal.state.seq, 100)
  assert.deepEqual((await inputs.freezePlan({ ...contract, project: inputs.project, caps: { usdMicros: 9_000_000, rounds: 4 } })).caps, { usdMicros: 3_000_000, rounds: 4 })
  assert.deepEqual((await inputs.freezePlan({ ...contract, project: inputs.project, caps: { usdMicros: 1_000_000, rounds: 4 } })).caps, { usdMicros: 1_000_000, rounds: 4 })
})

test('an older desk migrates its spending limit: the untouched default becomes Off, a chosen figure is kept', async () => {
  const desk = async (caps: { usdMicros: number; rounds: number }, edit?: (journal: Awaited<ReturnType<typeof createLeadJournal>>) => Promise<void>) => {
    const records: LeadJournalRecord[] = []
    const journal = await createLeadJournal({ async read() { return records }, async append(record: LeadJournalRecord) { records.push(record) } })
    await journal.setPolicy({ version: 1, revision: 1, mode: 'default', rules: [] })
    await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'goal-1', caps, freshnessMs: 1000 })
    await edit?.(journal)
    const migrated = leadSpendLimitMigration(journal.state)
    await journal.recordSpendLimit(migrated.usdMicros, migrated.applyToGoal, 100)
    return { migrated, journal }
  }
  const legacy = LEAD_LEGACY_DEFAULT_USD_MICROS
  const untouched = await desk({ usdMicros: legacy, rounds: 16 })
  assert.deepEqual(untouched.migrated, { usdMicros: null, applyToGoal: true })
  assert.deepEqual(untouched.journal.state.budget!.caps, { usdMicros: LEAD_LIMITS.maxUsdMicros, rounds: 16 }, 'the goal in hand is widened: nobody chose its figure')
  const custom = await desk({ usdMicros: 7_000_000, rounds: 16 })
  assert.deepEqual(custom.migrated, { usdMicros: 7_000_000, applyToGoal: false })
  assert.deepEqual(custom.journal.state.spendLimit, { usdMicros: 7_000_000 })
  assert.deepEqual(custom.journal.state.budget!.caps, { usdMicros: 7_000_000, rounds: 16 })
  const closed = await desk({ usdMicros: 0, rounds: 16 })
  assert.deepEqual(closed.journal.state.spendLimit, { usdMicros: 0 }, 'a closed allowance is a chosen figure too')
  const ceiling = await desk({ usdMicros: LEAD_LIMITS.maxUsdMicros, rounds: 16 })
  assert.deepEqual(ceiling.migrated, { usdMicros: null, applyToGoal: false }, 'a desk already at the ceiling is Off, not a limit the method refuses')
  assert.deepEqual(ceiling.journal.state.spendLimit, { usdMicros: null })
  assert.deepEqual(ceiling.journal.state.budget!.caps, { usdMicros: LEAD_LIMITS.maxUsdMicros, rounds: 16 })
  // A raise is for its goal alone: what stood before it decides, and the raised goal keeps its raise to the end.
  const raised = await desk({ usdMicros: legacy, rounds: 16 }, journal => journal.raiseBudget('goal-1', { usdMicros: 4_000_000, rounds: 16 }, journal.state.seq, 100))
  assert.deepEqual(raised.migrated, { usdMicros: null, applyToGoal: false })
  assert.deepEqual(raised.journal.state.budget!.caps, { usdMicros: 4_000_000, rounds: 16 })
  // A goal approved with the default on its card keeps that cap; the next goal has no limit.
  const approved = await desk({ usdMicros: legacy, rounds: 16 }, async journal => {
    const plan = parseLeadAcceptanceContract({ ...contract, caps: { usdMicros: legacy, rounds: 4 } })
    await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: plan.digest, contract: plan })
    await journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: plan.digest, choice: 'approve' }, 1000)
  })
  assert.deepEqual(approved.migrated, { usdMicros: null, applyToGoal: false })
  assert.equal(approved.journal.state.budget!.caps.usdMicros, legacy)
  await approved.journal.stop(async () => {})
  await approved.journal.beginGoal('goal-2', 200)
  assert.equal(approved.journal.state.budget!.caps.usdMicros, LEAD_LIMITS.maxUsdMicros)
  const seq = approved.journal.state.seq
  await approved.journal.recordSpendLimit(5, false, 300)
  assert.equal(approved.journal.state.seq, seq, 'the migration runs once')
})
