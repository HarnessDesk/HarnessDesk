import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FlowExecution, FlowPreview, GoalView } from '@harnessdesk/protocol'

import { Host, StateStore } from '../src/index.js'
import { makeRepo, until } from './fixtures/evidence-desk.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

test('a scripted writer resumes, commits preserved work, publishes and completes after a restart (#1403)', async (t) => {
  const repo = await makeRepo('hd-resumed-work-')
  await repo.git('config', 'user.name', 'Jane Doe')
  await repo.git('config', 'user.email', 'dev@example.com')
  await repo.git('switch', '-c', 'work')
  await writeFile(join(repo.dir, '.env'), 'LOCAL_ONLY=1\n')
  const stateDir = tempDir('hd-resumed-state-')
  const builtinAgents = tempDir('hd-resumed-builtins-')
  await mkdir(join(stateDir, 'agents', 'writer'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'writer', 'AGENT.md'),
    '---\nname: Writer\nceiling: publish\nanswers: [published]\nproduces: [diff]\nprefer: [fake]\n---\nPublish the change.\n')
  const runtime = new FakeRuntime()
  let published = false
  const makeHost = () => {
    const host = new Host({
      logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents, catalogRefreshMs: 0,
      evidence: { gh: async () => published ? {
        stdout: JSON.stringify({ number: 41, state: 'OPEN', headRefOid: await repo.git('rev-parse', 'HEAD'), url: null, statusCheckRollup: [] }),
        stderr: '', exitCode: 0,
      } : { stdout: '', stderr: 'no pull requests found', exitCode: 1 } },
    })
    host.register(runtime)
    return host
  }
  let host = makeHost()
  t.after(() => host.dispose())
  await host.start()
  await host.call('workspace/open', { path: repo.dir })
  const source = 'version: 2\nname: Resume writer\nroles:\n  author: { kind: agent, uses: writer, grant: publish }\nseed: { role: author, title: Publish it }\nrules: []\n'
  const preview = await host.call('flow/preview', { root: repo.dir, source }) as FlowPreview
  assert.ok(preview.token, JSON.stringify(preview.problems))
  const run = await host.call('flow/start-goal', { root: repo.dir, source, token: preview.token!, sentence: 'Publish it' }) as FlowExecution
  const card = await until(async () => {
    const cards = (await host.call('goal/read', { goal: run.goal }) as GoalView).board.intents
    const execution = await host.call('flow/execution', { run: run.id }) as FlowExecution
    return cards[0]?.claim && execution.operations.some((one) => one.kind === 'turn' && (one.state === 'finished' || one.state === 'prepared')) ? cards[0] : null
  }, 'writer to receive its card')
  const scope = { runtime: card.claim!.runtime, sessionId: card.claim!.sessionId }
  await writeFile(join(repo.dir, 'notes.md'), 'Preserved before restart.\n')
  assert.match(await host.teamPlane.release(card.id, {}, scope), /^Released/)
  await host.teamPlane.flush()
  await host.dispose()
  runtime.sessions.get(scope.sessionId as never)!.finish()

  host = makeHost()
  let script: Promise<void> | null = null
  let scriptProblem: unknown = null
  let blocks = 0
  runtime.onSend = (session, text) => {
    if (!text.startsWith(`Card #${card.id} on this Goal`)) return
    assert.match(text, /Your preserved work predates this claim/, 'the hand-back explains retained ownership')
    script = (async () => {
      assert.match(await host.teamPlane.claim(card.id, scope), /already hold|Claimed/)
      if (!published) {
        const committed = await host.teamPlane.commitWork(card.id, 'writer: preserve the resumed change', scope)
        assert.match(committed, /^Committed 1 file/)
        assert.match(committed, /predates this claim/)
        assert.match(committed, /notes\.md/, 'the resumed commit names the preserved paths')
        assert.equal(await repo.git('show', '--name-only', '--format=', 'HEAD'), 'notes.md')
        published = true // The scripted forge now answers with this branch's pull request.
      }
      if (blocks < 3) {
        blocks++
        assert.match(await host.teamPlane.release(card.id, { blocked: true, reason: 'publication is ready' }, scope), /^Released/)
      } else {
        assert.match(await host.teamPlane.complete(card.id, { outcome: 'published' }, scope), /^Completed/)
      }
      session.finish()
    })()
    // Keep script failures attached to the test even before it starts awaiting them.
    void script.catch((error: unknown) => { scriptProblem = error })
  }
  await host.start()
  await until(() => script, 'resumed writer script')
  await script!
  const finished = await until(async () => {
    if (scriptProblem) throw scriptProblem
    const current = await host.call('flow/execution', { run: run.id }) as FlowExecution
    assert.notEqual(current.state, 'stalled', current.reason ?? '')
    return current.state === 'settled' ? current : null
  }, 'published card to settle its run')
  assert.equal(finished.state, 'settled')
  assert.equal(published, true)
  assert.equal(blocks, 3, 'self-block hand-backs did not spend the three-turn stall budget')
  const done = (await host.call('goal/read', { goal: run.goal }) as GoalView).board.intents[0]!
  assert.equal(done.outcome, 'published')
  assert.equal(done.state, 'done')
  assert.equal(await repo.git('status', '--porcelain=v1'), '?? .env', 'pre-card work stays uncommitted')
})
