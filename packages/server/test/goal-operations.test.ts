import assert from 'node:assert/strict'
import { test } from 'node:test'

import { recoverOperation, type GoalOperation, type GoalOperationPort } from '../src/goals/operations.js'
import { seat } from './fixtures/goals.js'

const opening = () => {
  const { closed: _closed, ...record } = seat('fixed-opening')
  return record
}

const assignment = (): GoalOperation => ({
  kind: 'assignment', id: 'fixed-operation', goal: 'g1', card: 1, opening: opening(), close: ['standalone'],
})

const rig = (failAt: string | null) => {
  const calls: string[] = []
  const openings = new Set<string>()
  const closings = new Set<string>()
  let failed = false
  let finished = false
  const step = (name: string) => {
    calls.push(name)
    if (name === failAt && !failed) { failed = true; throw new Error(`cut at ${name}`) }
  }
  const port: GoalOperationPort = {
    importOpening: async (_project, record) => { step('import'); openings.add(record.id) },
    closeId: async (id) => { step('close'); closings.add(id) },
    claim: async () => { step('claim') },
    releaseClaim: async () => { step('release') },
    refuseMail: async () => { step('mail') },
    retainLane: async () => { step('lane') },
    finish: async () => { step('finish'); finished = true },
    wake: () => { step('wake') },
    finishWrap: async () => { throw new Error('wrap is not part of this operation') },
  }
  return { port, calls, openings, closings, finished: () => finished }
}

test('assignment closes only named standalone records, imports once, claims, then clears its journal', async () => {
  const proof = rig(null)
  await recoverOperation(assignment(), proof.port)
  assert.deepEqual(proof.calls, ['close', 'import', 'claim', 'finish', 'wake'])
  assert.deepEqual([...proof.closings], ['standalone'])
  assert.deepEqual([...proof.openings], ['fixed-opening'])
  assert.equal(proof.finished(), true)
})

test('assignment recovery after every awaited boundary retains the original opening id', async () => {
  for (const boundary of ['close', 'import', 'claim', 'finish']) {
    const proof = rig(boundary)
    await assert.rejects(recoverOperation(assignment(), proof.port), new RegExp(`cut at ${boundary}`))
    assert.equal(proof.finished(), false)
    await recoverOperation(assignment(), proof.port)
    assert.equal(proof.finished(), true)
    assert.deepEqual([...proof.openings], ['fixed-opening'])
    assert.deepEqual([...proof.closings], ['standalone'])
  }
})

test('release closes the requested Seat, releases its claim and mail, then wakes waiters', async () => {
  const proof = rig(null)
  const release: GoalOperation = { kind: 'release', id: 'release-1', goal: 'g1', seat: 'only-this-seat', reason: 'released' }
  await recoverOperation(release, proof.port)
  assert.deepEqual(proof.calls, ['close', 'release', 'mail', 'finish', 'wake'])
  assert.deepEqual([...proof.closings], ['only-this-seat'])
  assert.deepEqual([...proof.openings], [])
})

test('release recovery remains repeatable after each awaited boundary', async () => {
  const release: GoalOperation = { kind: 'release', id: 'release-1', goal: 'g1', seat: 'only-this-seat', reason: 'released' }
  for (const boundary of ['close', 'release', 'mail', 'finish']) {
    const proof = rig(boundary)
    await assert.rejects(recoverOperation(release, proof.port), new RegExp(`cut at ${boundary}`))
    await recoverOperation(release, proof.port)
    assert.equal(proof.finished(), true)
    assert.deepEqual([...proof.closings], ['only-this-seat'])
  }
})
