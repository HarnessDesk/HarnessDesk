import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import type { FlowExecution, FlowPreview, GoalView } from '@harnessdesk/protocol'

import { Host, StateStore } from '../src/index.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/*
 * Issue #1074, on the real path: an isolated role — UC1's dev works this way —
 * gets a real lane per Seat, and `commit_work` has to be able to commit there.
 * That needs each lane's claim to have recorded what was already dirty when
 * it was claimed, and the commit to land on that lane's own branch. A real
 * `Host`, a real repository and real worktrees; the agents are fakes.
 */

const run = promisify(execFile)

test('each Seat of an isolated pair commits its own work in its own lane through commit_work', async (t) => {
  const repo = await makeRepo('hd-flow-commit-lane-')
  await repo.git('config', 'user.name', 'Jane Doe')
  await repo.git('config', 'user.email', 'dev@example.com')
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-flow-commit-lane-state-'))
  const builtinAgents = tempDir('hd-flow-commit-lane-builtins-')
  await mkdir(join(stateDir, 'agents', 'implementer'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'implementer', 'AGENT.md'), [
    '---', 'name: implementer', 'ceiling: edit', 'produces: [diff]', 'prefer: [fake]', '---', 'Do the work.', '',
  ].join('\n'), 'utf8')
  const source = [
    'version: 2', 'name: Two writers', 'roles:',
    '  writer: { kind: agent, uses: implementer, grant: edit, count: 2, isolate: true }',
    'seed: { role: writer, title: Write something }', 'rules: []', '',
  ].join('\n')

  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents, catalogRefreshMs: 0 })
  const runtime = new FakeRuntime()
  Object.assign(runtime.info.presentation, { coAuthor: { name: 'Jane Doe', email: 'dev@example.com' } })
  host.register(runtime)
  // Disposed before its state folder goes: `t.after` hooks run in the order they are registered.
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  await host.call('workspace/open', { path: repo.dir })

  const preview = await host.call('flow/preview', { root: repo.dir, source }) as FlowPreview
  assert.ok(preview.token, `the flow previews clean: ${JSON.stringify(preview.problems)}`)
  const started = await host.call('flow/start-goal', { root: repo.dir, source, token: preview.token!, sentence: 'Write it' }) as FlowExecution
  const goal = started.goal

  const deadline = Date.now() + 15_000
  let intents = (await host.call('goal/read', { goal }) as GoalView).board.intents
  while (intents.length !== 2 || intents.some((one) => one.state !== 'claimed')) {
    if (Date.now() > deadline) throw new Error(`the cards never claimed: ${JSON.stringify(intents)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    intents = (await host.call('goal/read', { goal }) as GoalView).board.intents
  }
  for (const card of intents) {
    const forge = await host.forgePlane.seat({runtime: card.claim!.runtime, sessionId: card.claim!.sessionId})
    assert.equal(forge?.role, 'writer')
    assert.equal(forge?.team, host.teamPlane.stateFor(goal).name)
    assert.equal(forge?.round, null)
    assert.deepEqual(host.teamPlane.dirtyPathsOf(goal, card.id), [], `card #${card.id}'s lane claim recorded its snapshot`)
  }

  const main = (await repo.git('rev-parse', 'main')).trim()
  const lanes = (await repo.git('worktree', 'list', '--porcelain'))
    .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length)).slice(1)
  assert.equal(lanes.length, 2, 'one lane per Seat')
  for (const lane of lanes) await writeFile(join(lane, 'answer.md'), `# ${lane}\n`)

  for (const card of intents) {
    const answer = await host.teamPlane.commitWork(card.id, `Answer for #${card.id}`, { runtime: card.claim!.runtime, sessionId: card.claim!.sessionId })
    assert.match(answer, /^Committed 1 file as [0-9a-f]{40}\.$/, `card #${card.id}: ${answer}`)
  }
  for (const lane of lanes) {
    const git = async (...args: string[]) => (await run('git', ['-C', lane, ...args])).stdout.trim()
    assert.notEqual(await git('rev-parse', 'HEAD'), main, `${lane} moved`)
    assert.equal(await git('show', '--name-only', '--format=', 'HEAD'), 'answer.md')
    assert.equal(await git('status', '--porcelain=v1'), '', 'and is clean')
    assert.equal(await git('log', '-1', '--format=%an <%ae>%n%cn <%ce>'),
      'Jane Doe <dev@example.com>\nJane Doe <dev@example.com>', 'the person owns both identities')
    const trailers = (await git('log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)')).split('\n').sort()
    assert.deepEqual(trailers, [
      'HarnessDesk Agent <agent@harnessdesk.app>',
      'Jane Doe <dev@example.com>',
    ].sort(), 'the commit keeps both the desk and runtime credits once')
  }
  assert.equal((await repo.git('rev-parse', 'main')).trim(), main, 'the main checkout did not move')
})
