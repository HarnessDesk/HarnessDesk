import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage } from '@harnessdesk/protocol'
import { leadReviewedResultSource } from '@harnessdesk/lead'
import { leadRig } from './fixtures/lead.js'
import { flowMethods } from '../src/methods/flows.js'

for (const changed of ['source', 'token', 'seats', 'vars', 'sentence', 'attendance']) {
  test(`the step 7 hook refuses a substituted ${changed} before effects`, async t => {
    const s = await leadRig(t), params: any = await s.params()
    await s.admit(params)
    if (changed === 'source') params.source = 'version: 2\nname: Unsafe'
    if (changed === 'token') params.token = 'substituted'
    if (changed === 'seats') params.seats.implement[0].model = 'different'
    if (changed === 'vars') params.vars = { extra: 'work' }
    if (changed === 'sentence') params.sentence = 'Another goal'
    if (changed === 'attendance') params.attended = false
    assert.equal(await s.authority.authorize({ id: 1, method: 'flow/start-goal', params }), 'leadStartNotApproved')
    assert.equal(s.rig.events.length, 0)
  })
}

test('host-derived admission journals ownership and the first stable round before worker dispatch', async t => {
  const s = await leadRig(t)
  s.rig.beforeOpen = () => {
    assert.equal(s.journal.state.runs.length, 1)
    assert.equal(s.journal.state.budget!.rounds[0]!.roundId, `${s.journal.state.runs[0]!.runId}:round:1`)
    assert.equal(s.journal.state.budget!.rounds.length, 1)
  }
  const run = await s.start()
  assert.ok(s.rig.events.some(event => event.startsWith('open:')))
  assert.deepEqual(s.admission.readOwned(), [{ goal: run.goal, run: run.id }])
  assert.ok(s.rig.strictAsks.every(Boolean))
  assert.equal(s.rig.flows.leadRuns()[0]!.lead!.contractDigest, s.contract.digest)
})

test('target membership is rechecked between authorization and every start effect', async t => {
  const s = await leadRig(t), params = await s.params()
  await s.admit(params)
  assert.equal(await s.authority.authorize({ id: 1, method: 'flow/start-goal', params }), null)
  s.setMember(false)
  await assert.rejects(flowMethods['flow/start-goal'](s.ctx, params), /lead-start-not-approved/)
  assert.equal(s.admitted(), 0)
  assert.equal(s.rig.events.length, 0)
})

test('unsupported held worker ceilings cannot be admitted', async t => {
  const s = await leadRig(t); s.setHeld(false)
  const params = await s.params()
  await s.admit(params)
  assert.equal(await s.admission.authorizeStart(params), false)
  assert.equal(s.rig.events.length, 0)
})

for (const forbidden of ['merge', 'publish', 'delete']) {
  test(`Lead cannot delegate a forbidden ${forbidden} step through a Flow`, async t => {
    const s = await leadRig(t)
    const source = leadReviewedResultSource.replace('grant: edit', `grant: ${forbidden}`).replace('Implement the approved goal', `Perform ${forbidden}`)
    await assert.rejects(s.admission.preview({ root: s.project.path, source }), /lead-preview-refused/)
    const params = await s.params()
    await s.admit(params)
    assert.equal(await s.admission.authorizeStart({ ...params, source }), false)
    assert.equal(s.rig.events.length, 0)
  })
}


for (const field of ['approved', 'ceiling', 'lead']) {
  test(`the wire rejects caller-supplied ${field} authority`, async t => {
    const s = await leadRig(t), params = await s.params()
    assert.throws(() => parseClientMessage({ id: 1, method: 'flow/start-goal', params: { ...params, [field]: true } }))
    assert.equal(s.rig.events.length, 0)
  })
}

// Exercise the child port, private door hook and real Flow methods on one writer.
import { createLeadJournal, createLeadTools } from '@harnessdesk/lead'
const childTools = (s: Awaited<ReturnType<typeof leadRig>>, params: Awaited<ReturnType<Awaited<ReturnType<typeof leadRig>>['params']>>) => {
  let next = 0
  return createLeadTools({ journal: s.journal, project: s.project, now: () => 100, nextId: () => `child-${++next}`, synchronized: () => true,
    desk: { call: async (method: any, args: any) => {
      const refused = await s.authority.authorize({ id: 1, method, params: args })
      if (refused) throw new Error(refused)
      return (flowMethods as any)[method](s.ctx, args)
    } } as any,
    resolveTool: async () => ({ project: s.project, runId: null, start: s.contract.steps[0]!, stepId: 'work',
      preview: { token: params.token, source: params.source, expiresAt: 1000 },
      context: { desk: s.journal.state.policy!, projectPolicy: null, project: s.project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }) })
}

test('shared writer starts through child tools and the door, then reopens coherently', { timeout: 3000 }, async t => {
  const s = await leadRig(t), params = await s.params()
  await s.journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 100_000, rounds: 1 } })
  s.rig.beforeOpen = () => {
    assert.equal(s.journal.state.runs.length, 1)
    assert.equal(s.journal.state.steps[0]!.state, 'admitted', 'in-flight step remains reserved until its result')
    assert.equal(s.journal.state.budget!.rounds[0]!.roundId, `${s.journal.state.runs[0]!.runId}:round:1`)
  }
  const result = await childTools(s, params).execute({ method: 'flow/start-goal', params })
  assert.equal(result.outcome, 'succeeded')
  assert.equal(s.journal.state.steps[0]!.state, 'started')
  assert.equal(s.journal.state.runs.length, 1)
  assert.equal(s.journal.state.runs[0]!.correlationId, 'child-1')
  assert.equal([...s.journal.state.attempts.values()].filter(attempt => attempt.method === 'flow/start-goal' && attempt.dispatched).length, 1)
  assert.equal(s.journal.state.budget!.rounds.length, 1)
  assert.ok(s.rig.events.some(event => event.startsWith('order:')))
  const reopened = await createLeadJournal(s.storage)
  assert.deepEqual(reopened.state, s.journal.state)
})

test('a start with no in-flight journal attempt is refused before prepare', async t => {
  const s = await leadRig(t), params = await s.params()
  let prepares = 0
  t.mock.method(s.budgets, 'prepare', () => { prepares++ })
  assert.equal(await s.authority.authorize({ id: 1, method: 'flow/start-goal', params }), 'leadStartNotApproved')
  assert.equal(prepares, 0)
  assert.equal(s.rig.flows.leadRuns().length, 0)
})

test('two concurrent tokens for one in-flight attempt create exactly one owned run', { timeout: 3000 }, async t => {
  const s = await leadRig(t), a = await s.params(), b = await s.params()
  let refused: string | null = null
  const step = s.contract.steps[0]!
  const result = await s.journal.execute({ id: 'concurrent-start', stepId: step.id,
    request: { method: 'flow/start-goal', params: a, project: s.project, runId: null, start: step },
    context: { desk: s.journal.state.policy!, projectPolicy: null, project: s.project, approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }, async () => {
      const approvals = await Promise.all([a, b].map(params => s.authority.authorize({ id: 1, method: 'flow/start-goal', params })))
      assert.equal(approvals.filter(value => value === null).length, 1)
      refused = approvals.find(value => value !== null) ?? null
      const run = await flowMethods['flow/start-goal'](s.ctx, approvals[0] === null ? a : b)
      return { value: run, identity: { correlationId: 'concurrent-start', runId: run.id, teamId: run.goal } }
    })
  assert.equal(refused, 'leadStartNotApproved')
  assert.equal(result.outcome, 'succeeded')
  assert.equal(s.rig.flows.leadRuns().length, 1)
  assert.equal(s.journal.state.runs.length, 1)
})
