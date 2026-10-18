import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseClientMessage } from '@harnessdesk/protocol'
import { leadReviewedResultSource } from '@harnessdesk/lead'
import { leadRig } from './fixtures/lead.js'
import { flowMethods } from '../src/methods/flows.js'

for (const changed of ['source', 'token', 'seats', 'vars', 'sentence', 'attendance']) {
  test(`the step 7 hook refuses a substituted ${changed} before effects`, async t => {
    const s = await leadRig(t), params: any = await s.params()
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
  assert.equal(await s.authority.authorize({ id: 1, method: 'flow/start-goal', params }), null)
  s.setMember(false)
  await assert.rejects(flowMethods['flow/start-goal'](s.ctx, params), /lead-start-not-approved/)
  assert.equal(s.admitted(), 0)
  assert.equal(s.rig.events.length, 0)
})

test('unsupported held worker ceilings cannot be admitted', async t => {
  const s = await leadRig(t); s.setHeld(false)
  const params = await s.params()
  assert.equal(await s.admission.authorizeStart(params), false)
  assert.equal(s.rig.events.length, 0)
})

for (const forbidden of ['merge', 'publish', 'delete']) {
  test(`Lead cannot delegate a forbidden ${forbidden} step through a Flow`, async t => {
    const s = await leadRig(t)
    const source = leadReviewedResultSource.replace('grant: edit', `grant: ${forbidden}`).replace('Implement the approved goal', `Perform ${forbidden}`)
    await assert.rejects(s.admission.preview({ root: s.project.path, source }), /lead-preview-refused/)
    const params = await s.params()
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
