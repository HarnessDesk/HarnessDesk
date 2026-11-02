import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setGitRunnerForTest } from '../src/git-actions.js'
import { EvidencePlane } from '../src/evidence/plane.js'
import { board, claimed, comparison, cwdOf, desk, E2E, execution, git, settled, start, TASK, whenChanged, write } from './fixtures/flow-host-evidence.js'

const waiting = async (t: TestContext, answer = 'merged') => {
  const d = await desk(t)
  const source = (await comparison(d, 1, false))
    .replace(/  judge:\n[\s\S]*?(?=  referee:)/, '')
    .replace('  referee:\n    kind: person\n', '  referee:\n    kind: person\n    review: true\n')
    .replaceAll('[merged]', `[${answer}]`)
    .replace(/rules:\n[\s\S]*?(?=messaging:)/, 'rules:\n  - id: to-person\n    on: competitor\n    then: { role: referee, title: "Choose and merge an attempt" }\n')
  const run = await start(d, source, TASK)
  const [writer] = await claimed(d, run.goal, 'competitor', 1)
  await write(d, writer!, 'chosen attempt')
  const card = await whenChanged(d, async () => (await board(d, run.goal)).find(one => one.role === 'referee' && one.state === 'open') ?? null, 'the person referee')
  const [candidate] = await d.host.call('flow/review/candidates', { run: run.id, card: card.id })
  const params = { run: run.id, card: card.id, candidate: candidate!.id, verdict: 'merged', expectedBranch: await git(d.root, 'branch', '--show-current'), merge: true }
  return { d, run, card, candidate: candidate!, writer: writer!, params }
}

test('the person merge operation merges, verifies and saves the answer with its receipt', E2E, async t => {
  const { d, run, card, candidate, params } = await waiting(t)
  await d.host.call('flow/review/decide', params)
  await git(d.root, 'merge-base', '--is-ancestor', candidate.at, 'HEAD')
  const saved = (await board(d, run.goal)).find(one => one.id === card.id)!
  const receipt = JSON.parse(saved.handoff!).comparisonMerge
  assert.equal(saved.outcome, 'merged')
  assert.equal(receipt.card, candidate.card)
  assert.equal(receipt.revision, candidate.at)
  assert.equal(receipt.branch, params.expectedBranch)
  assert.equal(receipt.commit, await git(d.root, 'rev-parse', 'HEAD'))
  assert.equal((await settled(d, run.id)).state, 'settled')
})

test('a stopped person review cannot append its verdict after the final binding read', E2E, async t => {
  const { d, run, card, candidate } = await waiting(t, 'picked')
  const append = EvidencePlane.prototype.appendReview
  EvidencePlane.prototype.appendReview = async function (...args) {
    if (args[1].seat === null && args[1].card?.id === card.id) await d.host.call('flow/execution/stop', { run: run.id, reason: 'Stop before evidence admission' })
    return append.apply(this, args)
  }
  t.after(() => { EvidencePlane.prototype.appendReview = append })
  await assert.rejects(d.host.call('flow/review/decide', { run: run.id, card: card.id, candidate: candidate.id, verdict: 'picked' }), /no longer|not.*open|stopped|already answered/i)
  const facts = await d.host.call('evidence/board', { room: run.goal })
  assert.equal(facts.cards.flatMap(one => one.facts).some(one => one.record.card?.id === card.id && one.record.fact.kind === 'review'), false)
})

for (const changed of ['stopped', 'revision'] as const) test(`a person merge refuses a ${changed} change during Git preflight without moving the destination`, E2E, async t => {
  const { d, run, card, writer, params } = await waiting(t)
  const before = await git(d.root, 'rev-parse', 'HEAD')
  let entered!: () => void, release!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  const resumed = new Promise<void>(resolve => { release = resolve })
  let held = false
  setGitRunnerForTest(async (root, args) => {
    if (!held && args[0] === 'symbolic-ref') {
      held = true
      entered()
      await resumed
    }
    return git(root, ...args)
  })
  t.after(() => { release(); setGitRunnerForTest(null) })
  const merging = d.host.call('flow/review/decide', params)
  // Attach the rejection handler while the operation is paused.
  const refused = assert.rejects(merging, /changed|no longer waiting|not.*open/i)
  await paused
  if (changed === 'stopped') await d.host.call('flow/execution/stop', { run: run.id, reason: 'Stop during merge preparation' })
  else {
    const cwd = cwdOf(d, writer)
    await writeFile(join(cwd, 'attempt.txt'), 'new revision\n')
    await git(cwd, 'add', 'attempt.txt')
    await git(cwd, 'commit', '-qm', 'advance the attempt')
  }
  release()
  await refused
  assert.equal(await git(d.root, 'rev-parse', 'HEAD'), before)
  const saved = (await board(d, run.goal)).find(one => one.id === card.id)!
  assert.equal(saved.state, changed === 'stopped' ? 'abandoned' : 'open')
  assert.ok(!saved.handoff)
  const facts = await d.host.call('evidence/board', { room: run.goal })
  assert.equal(facts.cards.flatMap(one => one.facts).some(one => one.record.card?.id === card.id && one.record.fact.kind === 'review'), false)
})

test('a conflicted person merge leaves its card unanswered and records no review', E2E, async t => {
  const { d, run, card, params } = await waiting(t)
  await writeFile(join(d.root, 'attempt.txt'), 'destination version\n')
  await git(d.root, 'add', 'attempt.txt')
  await git(d.root, 'commit', '-qm', 'destination change')
  await assert.rejects(d.host.call('flow/review/decide', params), /conflict/i)
  assert.equal((await board(d, run.goal)).find(one => one.id === card.id)?.state, 'open')
  assert.equal((await execution(d, run.id)).state, 'running')
})
