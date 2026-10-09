import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFlowRig, startFlowScene } from './shots/flow-rig.mjs'
import { scriptedFlow, scriptedFlowPrompt } from '../packages/adapter-codex/test/fixtures/scripted-flow.mjs'


test('the opt-in native fake runs write/check/review/repair to a person handoff on the seeded rig', { timeout: 600000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-shots-flow-'))
  const home = join(directory, 'home')
  const work = join(directory, 'work')
  const rig = await createFlowRig({ home, work })
  const { host, repo, errors } = rig
  t.after(async () => { await rig.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const original = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  assert.deepEqual((await rig.codex.listSessions()).data, [], 'a fresh Flow scene has no adapter-test history')
  const run = await startFlowScene(rig)
  let view, execution
  const until = Date.now() + 90000
  do {
    view = await host.call('goal/read', { goal: run.goal })
    execution = await host.call('flow/execution', { run: run.id })
    if (view.board.intents.some((one) => one.role === 'land')) break
    if (execution.state === 'stalled') break
    await new Promise((done) => setTimeout(done, 100))
  } while (Date.now() < until)
  assert.ok(view.board.intents.some((one) => one.role === 'land'), JSON.stringify({ state: execution.state, reason: execution.reason, cards: view.board.intents, errors }))
  assert.deepEqual(execution.rounds.map((one) => one.role), ['write', 'check', 'review', 'write', 'check', 'review', 'land'])
  assert.deepEqual(view.board.intents.map((one) => [one.role, one.state, one.outcome]), [
    ['write', 'done', 'committed'], ['check', 'done', 'pass'], ['review', 'done', 'request-changes'],
    ['write', 'done', 'committed'], ['check', 'done', 'pass'], ['review', 'done', 'approve'], ['land', 'open', null],
  ])
  assert.ok(view.members.every((one) => one.ceiling.hold === 'held'))
  assert.deepEqual(errors, [], 'no scripted tool failure was swallowed')
  const evidence = await host.call('evidence/board', { room: run.goal })
  const fact = (card, kind) => evidence.cards.find((one) => one.card === card)?.facts.find((one) => one.record.fact.kind === kind)?.record
  for (const [writer, check, reviewer] of [[1, 2, 3], [4, 5, 6]]) {
    const diff = fact(writer, 'diff')
    assert.ok(diff?.fact.files > 0, 'the writer made a committed change')
    assert.equal(fact(check, 'check')?.fact.at, diff.fact.to)
    assert.equal(fact(reviewer, 'review')?.fact.at, diff.fact.to)
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: diff.checkout.cwd, encoding: 'utf8' }), '')
  }
  assert.match(readFileSync(join(fact(4, 'diff').checkout.cwd, 'rig-retry.txt'), 'utf8'), /502, 503, 504/)

  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), original, 'the person checkout never moved')
})

const worker = (t, steps, response = () => 'OK', options = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-flow-worker-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const state = join(directory, 'passes.json')
  const calls = [], events = []
  const tools = ['claim_work', 'commit_work', 'review_candidates', 'record_review', 'complete_claim', 'pr_create'].map((name) => ({ namespace: 'team', name }))
  const flow = scriptedFlow(JSON.stringify({ state, steps, ...options }), {
    send(message) {
      calls.push(message.params)
      queueMicrotask(() => flow.answer({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: response(message.params) }] } }))
    },
    notify: (method, params) => events.push({ method, params }),
  })
  const play = (intent, marker, extra = {}) => flow.play({
    threadId: `thread-${intent}`, turnId: `turn-${intent}`, cwd: directory, tools,
    prompt: `Card #${intent} on this Goal is yours: Work\n\n${marker}\n\nFlow run scene.`, ...extra,
  })
  return { state, directory, calls, events, flow, play }
}

test('the script is opt-in and standing prompts cannot claim or advance a pass', async (t) => {
  assert.equal(scriptedFlow(undefined, {}), null)
  const rig = worker(t, { WRITE: { kind: 'write', file: 'retry.txt', outcomes: ['committed'] } })
  await rig.play(1, 'WRITE', { prompt: 'The standing order mentions WRITE, before a card exists.' })
  assert.deepEqual(rig.calls, [])
  assert.equal(rig.events.at(-2).params.turn.status, 'completed')
})

test('a built-in template card matches its title and the judge records one offered candidate', async (t) => {
  const rig = worker(t, { PICK: { kind: 'review', title: 'Pick the best attempt', outcomes: ['picked'] } },
    ({ tool }) => tool === 'review_candidates' ? 'attempt-a — at abc123def456\nattempt-b — at def123abc456' : 'OK')
  await rig.play(3, 'ignored', { prompt: 'Card #3 on this Goal is yours: Pick the best attempt\n\nFlow run scene.' })
  assert.deepEqual(rig.calls.map(one => one.tool), ['claim_work', 'review_candidates', 'record_review', 'complete_claim'])
  assert.equal(rig.calls.find(one => one.tool === 'record_review').arguments.candidate, 'attempt-a')
  assert.equal(rig.calls.find(one => one.tool === 'record_review').arguments.verdict, 'picked')
})

test('template attempts write different content in their own checkout', async (t) => {
  const rig = worker(t, { WRITE: { kind: 'write', title: 'Repair checkout retry', file: 'retry.txt', contents: 'Attempt {{intent}}\n', outcomes: ['committed'] } })
  await rig.play(2, 'ignored', { prompt: 'Card #2 on this Goal is yours: Repair checkout retry\n\nFlow run scene.' })
  assert.equal(readFileSync(join(rig.directory, 'retry.txt'), 'utf8'), 'Attempt 2\n')
})

test('a template card after a separate desk context text part still completes', async t => {
  const rig = worker(t, { WRITE: { kind: 'write', title: 'Repair checkout retry', file: 'retry.txt', outcomes: ['committed'] } })
  const prompt = scriptedFlowPrompt([
    { type: 'text', text: '<desk-context>Work within this project.</desk-context>' },
    { type: 'text', text: 'Card #2 on this Goal is yours: Repair checkout retry\n\nFlow run scene.' },
  ])
  await rig.play(2, 'ignored', { prompt })
  assert.deepEqual(rig.calls.map(one => one.tool), ['claim_work', 'commit_work', 'complete_claim'])
})

test('two template attempts claim distinct paths while each commits its own card', async t => {
  const rig = worker(t, { WRITE: { kind: 'write', title: 'Repair checkout retry', file: 'retry-{{intent}}.txt', contents: 'Attempt {{intent}}\n', outcomes: ['committed'] } })
  for (const intent of [1, 2]) await rig.play(intent, 'ignored', { prompt: `Card #${intent} on this Goal is yours: Repair checkout retry\n\nFlow run scene.` })
  assert.deepEqual(rig.calls.filter(one => one.tool === 'claim_work').map(one => one.arguments), [
    { intent: 1, files: ['retry-1.txt'] }, { intent: 2, files: ['retry-2.txt'] },
  ])
  assert.equal(readFileSync(join(rig.directory, 'retry-1.txt'), 'utf8'), 'Attempt 1\n')
  assert.equal(readFileSync(join(rig.directory, 'retry-2.txt'), 'utf8'), 'Attempt 2\n')
})

test('the scripted publisher keeps the branch its Seat opened on and pushes only its local remote', async t => {
  let git
  const rig = worker(t, { WRITE: { kind: 'write', title: 'Repair checkout retry for review', file: 'retry.txt', outcomes: ['published'], publish: true } },
    ({ tool }) => { if (tool === 'commit_work') { git('add', 'retry.txt'); git('commit', '-m', 'rig: retry'); } return 'OK' })
  git = (...args) => execFileSync('git', args, { cwd: rig.directory, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-b', 'rig-write-review-1')
  git('config', 'user.name', 'Jane Doe')
  git('config', 'user.email', 'dev@example.com')
  writeFileSync(join(rig.directory, 'base.txt'), 'A checkout ready for review.\n')
  git('add', 'base.txt')
  git('commit', '-m', 'rig: base')
  const remote = join(rig.directory, '.git', 'remote.git')
  git('init', '--bare', remote)
  git('remote', 'add', 'origin', remote)
  await rig.play(1, 'ignored', { prompt: 'Card #1 on this Goal is yours: Repair checkout retry for review\n\nFlow run scene.' })
  assert.equal(rig.events.at(-2).params.turn.status, 'completed')
  assert.equal(git('branch', '--show-current'), 'rig-write-review-1')
  assert.equal(git('rev-parse', 'HEAD'), git('--git-dir', remote, 'rev-parse', 'refs/heads/rig-write-review-1'))
  assert.deepEqual(rig.calls.map(one => one.tool), ['claim_work', 'commit_work', 'pr_create', 'complete_claim'])
})

test('the template camera gate holds the real scripted write until it is released', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-template-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let claimed
  const claim = new Promise(done => { claimed = done })
  const rig = worker(t, { WRITE: { kind: 'write', file: 'retry.txt', outcomes: ['committed'] } }, ({ tool }) => { if (tool === 'claim_work') claimed(); return 'OK' }, { gates: directory })
  const playing = rig.play(1, 'WRITE')
  await claim
  assert.throws(() => readFileSync(join(rig.directory, 'retry.txt')), { code: 'ENOENT' })
  writeFileSync(join(directory, 'WRITE'), '')
  await playing
  assert.match(readFileSync(join(rig.directory, 'retry.txt'), 'utf8'), /Retryable statuses/)
  assert.equal(rig.events.at(-2).params.turn.status, 'completed')
})

test('a refused commit fails the turn without completing or advancing the script', async (t) => {
  const rig = worker(t, { WRITE: { kind: 'write', file: 'retry.txt', outcomes: ['committed'] } },
    ({ tool }) => tool === 'commit_work' ? 'Nothing to commit: refused.' : 'OK')
  await rig.play(1, 'WRITE')
  assert.deepEqual(rig.calls.map((one) => one.tool), ['claim_work', 'commit_work'])
  assert.equal(rig.events.at(-2).params.turn.status, 'failed')
  assert.throws(() => readFileSync(rig.state), { code: 'ENOENT' })
})

test('concurrent reviews keep their thread tools and candidates and do not replay completed cards', async (t) => {
  const rig = worker(t, {
    API: { kind: 'review', outcomes: ['approve'] }, PERF: { kind: 'review', outcomes: ['request-changes'] },
  }, ({ tool, threadId }) => tool === 'review_candidates' ? `candidate-${threadId} — at abc123def456` : 'OK')
  await Promise.all([rig.play(1, 'API'), rig.play(2, 'PERF', { tools: [
    ...['claim_work', 'review_candidates', 'record_review', 'complete_claim'].map((name) => ({ namespace: 'other-team', name })),
  ] })])
  const reviews = rig.calls.filter((one) => one.tool === 'record_review')
  assert.deepEqual(reviews.map((one) => [one.threadId, one.namespace, one.arguments.candidate, one.arguments.verdict]), [
    ['thread-1', 'team', 'candidate-thread-1', 'approve'], ['thread-2', 'other-team', 'candidate-thread-2', 'request-changes'],
  ])
  assert.deepEqual(JSON.parse(readFileSync(rig.state, 'utf8')).done.sort(), ['scene:1', 'scene:2'])
  const before = rig.calls.length
  await rig.play(1, 'API')
  assert.equal(rig.calls.length, before)
})

test('interrupting a scripted turn during its camera delay leaves the checkout untouched', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hd-flow-interrupt-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const events = [], calls = []
  let claimed
  const claim = new Promise((done) => { claimed = done })
  const flow = scriptedFlow(JSON.stringify({ state: join(directory, 'state.json'), delayMs: 5000,
    steps: { WRITE: { kind: 'write', file: 'retry.txt', outcomes: ['committed'] } },
  }), {
    send(message) {
      calls.push(message.params.tool)
      queueMicrotask(() => { flow.answer({ id: message.id, result: { success: true, contentItems: [] } }); claimed() })
    },
    notify: (method, params) => events.push({ method, params }),
  })
  const playing = flow.play({ threadId: 'thread', turnId: 'turn', cwd: directory,
    tools: [{ name: 'claim_work' }], prompt: 'Card #1 on this Goal is yours: Work\n\nWRITE\n\nFlow run scene.',
  })
  await claim
  flow.interrupt('thread')
  await playing
  assert.deepEqual(calls, ['claim_work'])
  assert.equal(events.at(-2).params.turn.status, 'interrupted')
  assert.throws(() => readFileSync(join(directory, 'retry.txt')), { code: 'ENOENT' })
})
