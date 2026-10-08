import assert from 'node:assert/strict'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FindingRunView, FlowExecution, FrontDoorPreview } from '@harnessdesk/protocol'

import {
  answer, board, claimed, cwdOf, desk, E2E, git, person, review, scopeOf, settled, shipped, start, TASK, type Behaviour, whenChanged, workInsideTheBrief, write,
} from './fixtures/flow-host-evidence.js'
import { FakeFindingForge } from './fixtures/fake-finding-forge.js'

const EXTERNAL_REVIEW_FLOW = [
  'version: 2',
  'name: External review',
  'inputs:',
  '  subject: { label: Pull request }',
  'roles:',
  '  reviewer: { kind: agent, uses: [code-reviewer], grant: read }',
  'seed: { role: reviewer, title: "Review pull request {{subject}}" }',
  'layout: { frontDoor: { contexts: [pull-request], bindings: [{ input: subject, value: pr }] } }',
  'messaging: board-only',
  '',
].join('\n')

const startExternalReview = async (d: Awaited<ReturnType<typeof desk>>) => {
  const preview = await d.host.call('authoring/start/preview', {
    context: { kind: 'pull-request', root: d.root, number: 41 }, source: EXTERNAL_REVIEW_FLOW, vars: {},
  }) as FrontDoorPreview
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  const run = await d.host.call('flow/start-goal', {
    root: d.root, source: EXTERNAL_REVIEW_FLOW, token: preview.flow.token!, sentence: preview.sentence, vars: preview.vars,
  }) as FlowExecution
  d.runs.push(run.id)
  const [card] = await claimed(d, run.goal, 'reviewer', 1)
  return { run, card: card!, scope: scopeOf(card!) }
}

type ReviewContext =
  | { readonly kind: 'branch'; readonly root: string; readonly branch: string }
  | { readonly kind: 'diff'; readonly root: string; readonly from: string; readonly to: string }
  | { readonly kind: 'working-diff'; readonly root: string }

const startBuiltinReview = async (d: Awaited<ReturnType<typeof desk>>, context: ReviewContext): Promise<FlowExecution> => {
  const source = await shipped(d, 'review')
  const preview = await d.host.call('authoring/start/preview', { context, source, vars: {} }) as FrontDoorPreview
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  const run = await d.host.call('flow/start-goal', {
    root: d.root, source, token: preview.flow.token!, sentence: preview.sentence, vars: preview.vars,
  }) as FlowExecution
  d.runs.push(run.id)
  return run
}

/*
 * Review shapes: the shipped `review`, `independent-review`, `fan-out` and `review-pr` flows, and
 * a hand-written flow whose `to-ship` rule waits on three evidence guards
 * at once (a check, green CI, an open pull request). Split out of
 * `flow-host-evidence.test.ts` (see that file's sibling `-comparison`,
 * `-investigation` and `-flows` files) so no single file's cases add up to
 * the suite's `--test-timeout`; the rig they all share lives in
 * `test/fixtures/flow-host-evidence.ts`.
 */

test('a host-resolved external pull request seeds a review candidate and publishes the finding and verdict', E2E, async (t) => {
  const publicationForge = new FakeFindingForge('0'.repeat(40))
  publicationForge.pr = 41
  const d = await desk(t, undefined, { findingForge: publicationForge, held: true })
  const head = await git(d.root, 'rev-parse', 'HEAD')
  publicationForge.head = head
  d.forge.open.add('work')
  const { run, card, scope } = await startExternalReview(d)
  assert.deepEqual(run.target, { kind: 'pull-request', label: 'pull request #41', base: await git(d.root, 'rev-parse', 'main'), head, pr: 41, dirty: false })

  const [candidate] = await d.host.teamPlane.reviewCandidates(card.id, scope)
  assert.ok(candidate, 'the external PR head is offered as a review candidate')
  assert.equal(candidate!.at, head)
  const finding = await d.host.teamPlane.raiseFinding({
    intent: card.id, candidate: candidate!.id, request: 'seed-review-finding', title: 'Missing guard',
    body: 'The change leaves one input unchecked.', category: 'ordinary', blocking: true,
  }, scope)
  assert.equal(finding.origin.at, head)
  await d.host.teamPlane.recordReview({ intent: card.id, candidate: candidate!.id, verdict: 'request-changes' }, scope)
  const completed = await d.host.teamPlane.complete(card.id, { outcome: 'request-changes' }, scope)
  assert.doesNotMatch(completed, /^Refused/, completed)
  await settled(d, run.id)

  const published = await whenChanged(d, async () => {
    const view = await d.host.call('finding/run', { goal: run.goal, run: run.id }) as FindingRunView
    const round = view.rounds.find((one) => one.cards.includes(card.id))
    return round && (round.state === 'posted' || (round.state === 'local' && round.reason !== null)) ? { view, round } : null
  }, 'the external PR review publication')
  assert.equal(published.round.state, 'posted')
  assert.equal(published.round.pr, 41)
  assert.equal(publicationForge.sends.length, 2, 'the finding and the structured review both reached the fake external PR')
  assert.ok(publicationForge.sends.every((one) => one.body.includes(head.slice(0, 12))))
})

test('a dirty external review checkout withdraws its candidate and explains why completion is refused', E2E, async (t) => {
  const publicationForge = new FakeFindingForge('0'.repeat(40))
  publicationForge.pr = 41
  const d = await desk(t, undefined, { findingForge: publicationForge, held: true })
  publicationForge.head = await git(d.root, 'rev-parse', 'HEAD')
  d.forge.open.add('work')
  const { card, scope } = await startExternalReview(d)
  const [candidate] = await d.host.teamPlane.reviewCandidates(card.id, scope)
  assert.ok(candidate)

  await writeFile(join(cwdOf(d, card), 'uncommitted-review.txt'), 'placeholder review change\n')
  await assert.rejects(d.host.teamPlane.reviewCandidates(card.id, scope), /host-resolved review checkout has uncommitted changes/)
  const refused = await d.host.teamPlane.complete(card.id, { outcome: 'request-changes' }, scope)
  assert.match(refused, /host-resolved review checkout has uncommitted changes/)
})

test('a review seed without a host-resolved target refuses with its reason', E2E, async (t) => {
  const d = await desk(t)
  const unboundReview = EXTERNAL_REVIEW_FLOW.replace(/^layout:.*\n/m, '')
  const reviewRun = await start(d, unboundReview, { subject: 'pull request 41' })
  const [reviewCard] = await claimed(d, reviewRun.goal, 'reviewer', 1)
  await assert.rejects(d.host.teamPlane.reviewCandidates(reviewCard!.id, scopeOf(reviewCard!)), /no host-resolved target/)
  const refused = await d.host.teamPlane.complete(reviewCard!.id, { outcome: 'request-changes' }, scopeOf(reviewCard!))
  assert.match(refused, /no host-resolved target/)
})

test('an ordinary non-review proposal seed stays answerable without a host-resolved target', E2E, async (t) => {
  const d = await desk(t)
  const proposal = [
    'version: 2',
    'name: Proposal',
    'roles:',
    '  proposal: { kind: agent, uses: [implementer], grant: read }',
    'seed: { role: proposal, title: "Review pull request 41" }',
    'messaging: board-only',
    '',
  ].join('\n')
  const proposalRun = await start(d, proposal, {})
  const [proposalCard] = await claimed(d, proposalRun.goal, 'proposal', 1)
  assert.deepEqual(await d.host.teamPlane.reviewCandidates(proposalCard!.id, scopeOf(proposalCard!)), [])
  const completed = await d.host.teamPlane.complete(proposalCard!.id, {}, scopeOf(proposalCard!))
  assert.doesNotMatch(completed, /^Refused/, completed)
})

test('a moved external pull request refuses publication of a review pinned to its earlier head', E2E, async (t) => {
  const publicationForge = new FakeFindingForge('0'.repeat(40))
  publicationForge.pr = 41
  const d = await desk(t, undefined, { findingForge: publicationForge, held: true })
  const head = await git(d.root, 'rev-parse', 'HEAD')
  publicationForge.head = head
  d.forge.open.add('work')
  const { run, card, scope } = await startExternalReview(d)
  const [candidate] = await d.host.teamPlane.reviewCandidates(card.id, scope)
  assert.ok(candidate)
  await d.host.teamPlane.raiseFinding({
    intent: card.id, candidate: candidate!.id, request: 'moved-pr-finding', title: 'Missing guard',
    body: 'The change leaves one input unchecked.', category: 'ordinary', blocking: true,
  }, scope)
  await d.host.teamPlane.recordReview({ intent: card.id, candidate: candidate!.id, verdict: 'request-changes' }, scope)
  publicationForge.head = 'f'.repeat(40)
  const completed = await d.host.teamPlane.complete(card.id, { outcome: 'request-changes' }, scope)
  assert.doesNotMatch(completed, /^Refused/, completed)
  await settled(d, run.id)

  const refused = await whenChanged(d, async () => {
    const view = await d.host.call('finding/run', { goal: run.goal, run: run.id }) as FindingRunView
    return view.rounds.find((one) => one.cards.includes(card.id) && one.state === 'local' && one.reason !== null) ?? null
  }, 'the moved external PR refusal')
  assert.equal(refused.state, 'local')
  assert.match(refused.reason ?? '', /moved from/)
  assert.equal(publicationForge.sends.length, 0)
})

test('independent review with every Seat working inside its brief: each completion persists and the specialists open', E2E, async (t) => {
  const d = await desk(t, undefined, { refusesWhileBusy: true })
  // A reviewer asks for what it may judge until it is offered something, as an agent working its card does.
  const reviewInside: Behaviour = async (desk, card) => {
    await whenChanged(desk, async () => ((await desk.host.teamPlane.reviewCandidates(card.id, scopeOf(card))).length > 0 ? true : null), 'something to review')
    await review(desk, card, 'approve')
  }
  workInsideTheBrief(d, {
    build: async (desk, card) => { await write(desk, card, 'built') },
    specialists: reviewInside,
  })
  const run = await start(d, await shipped(d, 'independent-review'), TASK)
  await person(d, run.goal, 'ship', 'shipped')
  const done = await settled(d, run.id)
  assert.deepEqual(done.rounds.map((one) => one.role), ['build', 'specialists', 'ship'])
  const cards = await board(d, run.goal)
  assert.deepEqual(
    cards.map((one) => [one.role, one.state]),
    [['build', 'done'], ['specialists', 'done'], ['specialists', 'done'], ['specialists', 'done'], ['ship', 'done']],
  )
  // Nothing re-opened a finished card: no card was handed a second order after it was done.
  const reordered = done.operations.filter((one) => one.kind === 'turn' && one.state !== 'finished' && one.state !== 'prepared')
  assert.deepEqual(reordered, [])
})

test('the independent review flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'independent-review'), TASK)
  await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
  for (const card of await claimed(d, run.goal, 'specialists', 3)) await review(d, card, 'approve')
  await person(d, run.goal, 'ship', 'shipped')
  await settled(d, run.id)
})

test('the review flow reaches its end: three read-only specialists judge a host-resolved branch, then the person', E2E, async (t) => {
  const d = await desk(t, undefined, { held: true })
  const head = await git(d.root, 'rev-parse', 'HEAD')
  const run = await startBuiltinReview(d, { kind: 'branch', root: d.root, branch: 'work' })
  assert.equal(run.target?.head, head)
  for (const card of await claimed(d, run.goal, 'specialists', 3)) await review(d, card, 'approve')
  await person(d, run.goal, 'decide', 'done')
  await settled(d, run.id)
})

test('the review flow judges a host-resolved diff at its committed destination', E2E, async (t) => {
  const d = await desk(t, undefined, { held: true })
  const head = await git(d.root, 'rev-parse', 'HEAD')
  const base = await git(d.root, 'rev-parse', 'main')
  const run = await startBuiltinReview(d, { kind: 'diff', root: d.root, from: base, to: head })
  for (const card of await claimed(d, run.goal, 'specialists', 3)) {
    const [candidate] = await d.host.teamPlane.reviewCandidates(card.id, scopeOf(card))
    assert.equal(candidate?.at, head)
    await review(d, card, 'approve', head)
  }
  await person(d, run.goal, 'decide', 'done')
  await settled(d, run.id)
})

test('working-diff reviews stay on the host-bound checkout without inventing a commit candidate', E2E, async (t) => {
  const d = await desk(t, undefined, { held: true })
  await writeFile(join(d.root, 'working-review.txt'), 'placeholder working tree change\n')
  const run = await startBuiltinReview(d, { kind: 'working-diff', root: d.root })
  assert.equal(run.target?.kind, 'working-diff')
  assert.equal(run.target?.head, null)
  for (const card of await claimed(d, run.goal, 'specialists', 3)) {
    assert.equal(await realpath(cwdOf(d, card)), await realpath(d.root))
    assert.deepEqual(await d.host.teamPlane.reviewCandidates(card.id, scopeOf(card)), [])
    await answer(d, card, 'approve')
  }
  await person(d, run.goal, 'decide', 'done')
  await settled(d, run.id)
})

test('the fan-out review flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'fan-out'), TASK)
  await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
  for (const card of await claimed(d, run.goal, 'review', 3)) await review(d, card, 'approve')
  await person(d, run.goal, 'ship', 'shipped')
  await settled(d, run.id)
})

test('a check, green CI and an open pull request, each observed at the build revision, open the ship card together', E2E, async (t) => {
  const d = await desk(t)
  const source = [
    'version: 2',
    'name: Guarded ship',
    'inputs:',
    '  task:',
    '    label: Task',
    'roles:',
    '  build: { kind: agent, uses: implementer, grant: edit, isolate: true }',
    '  verify: { kind: check, run: "test -s attempt.txt", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
    '  ship: { kind: person, outcomes: [shipped] }',
    'seed: { role: build, title: "{{task}}" }',
    'rules:',
    '  - { id: to-verify, on: build, then: { role: verify, title: Check it } }',
    '  - id: to-ship',
    '    on: verify',
    '    when: { every: [pass], evidence: [{ check: "test -s attempt.txt" }, { ci: green }, { pr: open }] }',
    '    then: { role: ship, title: "Ship pull request {{evidence.pr.number}} at {{evidence.check.at}}" }',
    'messaging: board-only',
    'wait: 240',
    '',
  ].join('\n')
  const run = await start(d, source, TASK)
  const [build] = await claimed(d, run.goal, 'build', 1)
  d.forge.open.add(await git(cwdOf(d, build!), 'symbolic-ref', '--short', 'HEAD'))
  const head = await write(d, build!, 'the build')
  const ship = await person(d, run.goal, 'ship', 'shipped')
  assert.equal(ship.title, `Ship pull request 41 at ${head}`)
  const done = await settled(d, run.id)
  assert.equal(done.rounds.find((one) => one.role === 'ship')!.evidence.length, 3, 'one fact for each guard')
})

test('the review-pr flow reaches its end', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'review-pr'), TASK)
  const [fixer] = await claimed(d, run.goal, 'fixer', 1)
  d.forge.open.add(await git(cwdOf(d, fixer!), 'symbolic-ref', '--short', 'HEAD'))
  await write(d, fixer!, 'fixed')
  for (const card of await claimed(d, run.goal, 'reviewer', 2)) {
    const forge = await d.host.forgePlane.seat(scopeOf(card))
    assert.equal(forge?.role, 'reviewer')
    assert.equal(forge?.team, d.host.teamPlane.stateFor(run.goal).name)
    assert.equal(forge?.round, 1, 'this is the first review round in the run')
    await review(d, card, 'approve')
  }
  // The mechanical check runs by itself, the way mechanical-contest's `decide` does; no card to drive.
  await person(d, run.goal, 'referee', 'merged')
  await settled(d, run.id)
})

/* The loop review-pr exists for: reviewers ask for changes, the fixer
   repairs — twice — they approve, the check runs, and the person referee
   still gets the card: the shipped budget has to reach that far. */
test('the review-pr flow reaches its person referee through two repairs', E2E, async (t) => {
  const d = await desk(t)
  /* Both fake runtimes mint `fake-session-<n>` from their own counters, so a
     third Seat on the first can be answered with an id the second already
     used, which the desk refuses as a conversation it holds. Real runtimes
     mint unique ids; this puts the first's counter out of the second's way. */
  for (let n = 0; n < 50; n += 1) await d.runtimes[0]!.createSession({ cwd: d.root })
  const run = await start(d, await shipped(d, 'review-pr'), TASK)
  const [fixer] = await claimed(d, run.goal, 'fixer', 1)
  d.forge.open.add(await git(cwdOf(d, fixer!), 'symbolic-ref', '--short', 'HEAD'))
  await write(d, fixer!, 'fixed')
  for (const [index, attempt] of ['repaired once', 'repaired twice'].entries()) {
    for (const card of await claimed(d, run.goal, 'reviewer', 2)) {
      const forge = await d.host.forgePlane.seat(scopeOf(card))
      assert.equal(forge?.round, index + 1, `review ${index + 1} counts earlier review rounds, not work rounds`)
      await review(d, card, 'request-changes')
    }
    const [repair] = await claimed(d, run.goal, 'fixer', 1)
    // Each repair is its own Seat's checkout: the pull request the forge reports is the one on its branch.
    d.forge.open.add(await git(cwdOf(d, repair!), 'symbolic-ref', '--short', 'HEAD'))
    await write(d, repair!, attempt)
  }
  for (const card of await claimed(d, run.goal, 'reviewer', 2)) {
    const forge = await d.host.forgePlane.seat(scopeOf(card))
    assert.equal(forge?.round, 3, 'the final review follows two earlier review rounds')
    await review(d, card, 'approve')
  }
  const referee = await person(d, run.goal, 'referee', 'merged')
  assert.equal(referee.role, 'referee', 'the person referee was reached, not a stop for the budget')
  const done = await settled(d, run.id)
  assert.equal(done.findings?.stopped ?? null, null)
})


test('a new review record wakes reviews-only readers before the round has a publication decision', E2E, async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'independent-review'), TASK)
  await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
  const card = (await claimed(d, run.goal, 'specialists', 3))[0]!
  const goals: string[] = []
  d.host.addBroadcaster((notification) => {
    if (notification.method === 'finding/changed') goals.push(notification.params.goal)
  })
  const scope = scopeOf(card)
  const candidates = await d.host.teamPlane.reviewCandidates(card.id, scope)
  const input = { intent: card.id, candidate: candidates[0]!.id, verdict: 'approve' }
  await d.host.teamPlane.recordReview(input, scope)
  assert.deepEqual(goals, [run.goal])
  const view = await d.host.call('finding/run', { goal: run.goal, run: run.id })
  assert.equal(view.rounds.find((one) => one.cards.includes(card.id))?.state, 'none')
  await d.host.teamPlane.recordReview(input, scope)
  await d.host.call('finding/run', { goal: run.goal, run: run.id })
  assert.equal(goals.length, 1, 'duplicate review records and reads do not trigger another refresh')
})
