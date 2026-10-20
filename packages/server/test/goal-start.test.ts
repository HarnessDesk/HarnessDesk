import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { clientTierFor, parseClientMessage, type GoalView, type SeatRecord } from '@harnessdesk/protocol'

import { StateStore } from '../src/state.js'
import { Client, halt, start } from './fixtures/harness.js'
import { makeRepo, writeAgent } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

const rig = async (t: TestContext) => {
  const repo = await makeRepo('hd-plain-team-project-')
  const stateDir = tempDir('hd-plain-team-state-')
  const state = new StateStore(join(stateDir, 'state.json'))
  await state.load()
  await state.touchWorkspace({ path: repo.dir, name: basename(repo.dir), lastOpenedAt: 1 })
  await writeAgent(stateDir)
  const harness = await start({ state, builtinAgents: join(stateDir, 'builtins'), catalogRefreshMs: 0 }, stateDir)
  const client = await Client.connect(harness.server)
  t.after(async () => {
    client.close()
    await halt(harness)
    await rm(stateDir, { recursive: true, force: true })
    await rm(repo.dir, { recursive: true, force: true })
  })
  return { ...harness, client, repo, state }
}

test('plain Team start admits its remembered project before a selected Agent is seated', async (t) => {
  const { client, repo, state } = await rig(t)
  const generic = await client.call('goal/create', { root: repo.dir, sentence: 'No implicit authority' }) as GoalView
  assert.equal(state.state.workspaces[0]?.shellIdentity, undefined)
  await assert.rejects(client.call('goal/seat', { goal: generic.goal.id, agent: 'scout' }), /outside every project opened here/)
  const team = await client.call('goal/start', { root: repo.dir, sentence: 'Inspect the cart', checkout: 'shared' }) as GoalView
  assert.ok(state.state.workspaces.find(entry => entry.path === repo.dir)?.shellIdentity)
  const seat = await client.call('goal/seat', { goal: team.goal.id, agent: 'scout' }) as SeatRecord
  assert.equal(seat.checkout.project, team.goal.root)
  assert.equal(seat.agent?.id, 'scout')
})

test('plain Team start refuses an unknown folder without granting authority or creating a Team', async (t) => {
  const { client, state } = await rig(t)
  const other = await makeRepo('hd-plain-team-other-')
  t.after(() => rm(other.dir, { recursive: true, force: true }))
  await assert.rejects(client.call('goal/start', { root: other.dir, sentence: 'Unknown project' }), /outside every folder and repository opened here/)
  assert.equal(state.state.workspaces.some(entry => entry.path === other.dir), false)
  assert.deepEqual(await client.call('goal/list', {}), [])
})

test('plain Team start refuses a changed captured checkout until the person opens it again', async (t) => {
  const { client, repo, state } = await rig(t)
  await client.call('workspace/open', { path: repo.dir })
  const saved = structuredClone(state.state.workspaces.find(entry => entry.path === repo.dir)?.shellIdentity)
  const replacement = await makeRepo('hd-plain-team-replacement-')
  t.after(() => rm(replacement.dir, { recursive: true, force: true }))
  await repo.git('config', 'core.worktree', replacement.dir)
  await assert.rejects(client.call('goal/start', { root: repo.dir, sentence: 'Changed project' }), /project checkout changed/i)
  assert.deepEqual(state.state.workspaces.find(entry => entry.path === repo.dir)?.shellIdentity, saved)
  assert.deepEqual(await client.call('goal/list', {}), [])
})

test('plain Team start is renderer-only and rejects caller-supplied checkout paths', () => {
  assert.equal(clientTierFor('goal/start'), null)
  const params = { root: '/repo', sentence: 'Inspect the cart', checkout: 'isolated' }
  assert.deepEqual(parseClientMessage({ id: 1, method: 'goal/start', params }).params, params)
  assert.throws(() => parseClientMessage({ id: 1, method: 'goal/start', params: { ...params, cwd: '/other' } }), /cwd/)
  assert.throws(() => parseClientMessage({ id: 1, method: 'goal/start', params: { ...params, sentence: ' ' } }), /sentence/)
})
