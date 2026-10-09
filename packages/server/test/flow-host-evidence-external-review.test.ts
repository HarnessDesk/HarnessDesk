import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FlowExecution, FrontDoorPreview } from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import { projectOf } from '../src/evidence/revision.js'
import { FakeFindingForge } from './fixtures/fake-finding-forge.js'
import { HoldFake } from './fixtures/hold-runtime.js'
import { answer, board, claimed, cwdOf, desk, E2E, git, scopeOf, settled, start, whenChanged, type Desk } from './fixtures/flow-host-evidence.js'

const source = (title: string) => `
version: 2
name: Review an existing pull request
roles:
  reviewer: { kind: agent, uses: code-reviewer, grant: read }
seed: { role: reviewer, title: "${title}" }
rules: []
`

const bind = async (d: Desk, goal: string, head: string): Promise<void> => {
  // Fixture observation of a PR opened outside this Team: no writer card or author Seat.
  await new EvidenceStore(join(d.stateDir, 'evidence')).append(await projectOf(d.root), 'evidence', [{ type: 'evidence', record: {
    id: randomUUID(), fact: { kind: 'pr', number: 7, state: 'open', head, url: 'https://github.com/acme/widgets/pull/7' },
    card: null, checkout: null, seat: null, round: null, observedAt: Date.now(), posted: null,
    intake: { firing: 'a'.repeat(64), part: 'pr', goal },
  } }])
}

for (const binding of ['card', 'team'] as const) {
  test(`a working-diff review retains uncommitted files despite a ${binding} PR`, E2E, async (t) => {
    const forge = new FakeFindingForge('a'.repeat(40))
    const d = await desk(t, undefined, { findingForge: forge })
    d.host.register(new HoldFake())
    await writeFile(join(d.stateDir, 'agents', 'code-reviewer', 'AGENT.md'),
      '---\nname: Reviewer\nceiling: read\nanswers: [approve, request-changes]\nproduces: [review]\nprefer: [holdfake]\n---\nRead the working changes.\n')
    const head = await git(d.root, 'rev-parse', 'HEAD')
    forge.head = head
    d.forge.pullRequests.set(7, { head, state: 'OPEN' })
    await writeFile(join(d.root, 'uncommitted.txt'), 'Selected working changes.\n')
    const text = source(binding === 'card' ? 'Review pull request #7' : 'Review the working changes') +
      '\nlayout: { frontDoor: { contexts: [working-diff] } }\n'
    const preview = await d.host.call('authoring/start/preview', {
      context: { kind: 'working-diff', root: d.root }, source: text, vars: {},
    }) as FrontDoorPreview
    assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
    const run = await d.host.call('flow/start-goal', {
      root: d.root, source: text, token: preview.flow.token!, sentence: preview.sentence, vars: preview.vars,
    }) as FlowExecution
    d.runs.push(run.id)
    const [card] = await claimed(d, run.goal, 'reviewer', 1)
    if (binding === 'team') await bind(d, run.goal, head)
    assert.equal(await realpath(cwdOf(d, card!)), await realpath(d.root), 'the reviewer must read the selected working checkout')
    assert.match(await git(cwdOf(d, card!), 'status', '--porcelain'), /uncommitted\.txt/)
    await assert.rejects(() => d.host.teamPlane.reviewCandidates(card!.id, scopeOf(card!)), /working tree.*committed/i)
    assert.match((await board(d, run.goal))[0]!.detail ?? '', /working tree.*committed/i)
    await d.host.call('team/intent', { room: run.goal, id: card!.id, action: 'done', outcome: 'approve' })
    await settled(d, run.id)
    assert.equal(forge.sends.length, 0, 'a working-tree handoff cannot certify a PR review')
  })
}

for (const binding of ['card', 'card-url', 'team'] as const) {
  test(`a review-first card uses the ${binding}'s PR binding, records findings and posts the review`, E2E, async (t) => {
    const forge = new FakeFindingForge('a'.repeat(40))
    const d = await desk(t, undefined, { findingForge: forge })
    await writeFile(join(d.root, 'attempt.txt'), 'Bound the retries.\n')
    await git(d.root, 'add', 'attempt.txt')
    await git(d.root, 'commit', '-q', '-m', 'bounded retry')
    const head = await git(d.root, 'rev-parse', 'HEAD')
    forge.head = head
    d.forge.pullRequests.set(7, { head, state: 'OPEN' })
    // A named PR's commit is available locally but the shared checkout is on main.
    // Its reviewer must receive that PR's revision in its own lane.
    if (binding !== 'team') await git(d.root, 'checkout', '-q', 'main')
    const title = binding === 'card' ? 'Review pull request #7' : binding === 'card-url' ? 'Review https://github.com/acme/widgets/pull/7' : 'Review the bound change'
    const run = await start(d, source(title), {})
    const [card] = await claimed(d, run.goal, 'reviewer', 1)
    if (binding === 'team') await bind(d, run.goal, head)
    const scope = scopeOf(card!)
    const candidates = await d.host.teamPlane.reviewCandidates(card!.id, scope)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]!.at, head)
    assert.equal(await git(cwdOf(d, card!), 'rev-parse', 'HEAD'), head)
    assert.doesNotMatch((await board(d, run.goal))[0]!.detail ?? '', /Review candidates unavailable/)
    d.forge.pullRequests.set(7, { head, state: 'CLOSED' })
    await assert.rejects(() => d.host.teamPlane.reviewCandidates(card!.id, scope), /Pull request #7 is closed/)
    if (binding === 'team') {
      await assert.rejects(() => d.host.teamPlane.reviewCandidates(card!.id, scope), /No open pull request is bound/)
      await bind(d, run.goal, head)
    }
    d.forge.pullRequests.set(7, { head: 'b'.repeat(40), state: 'OPEN' })
    await assert.rejects(() => d.host.teamPlane.recordReview({ intent: card!.id, candidate: candidates[0]!.id, verdict: 'approve' }, scope), /candidate has moved on/)
    d.forge.pullRequests.set(7, { head, state: 'OPEN' })
    const finding = await d.host.teamPlane.raiseFinding({
      intent: card!.id, candidate: candidates[0]!.id, request: 'external-review-finding',
      title: 'Keep the last retry failure', body: 'The final attempt should retain its failure reason.', category: 'ordinary', blocking: false,
    }, scope)
    await d.host.teamPlane.recordReview({ intent: card!.id, candidate: candidates[0]!.id, verdict: 'approve' }, scope)
    await answer(d, card!, 'approve')
    await settled(d, run.id)
    const view = await whenChanged(d, async () => {
      const now = await d.host.call('finding/run', { goal: run.goal, run: run.id })
      return now.publication === 'posted' ? now : null
    }, 'the recorded review to be posted')
    assert.equal(view.reviewersFinished, 1)
    assert.equal(view.rounds[0]!.state, 'posted')
    assert.equal(forge.sends.length, 2, 'the recorded finding and review summary each reach the fake forge')
    assert.ok(forge.sends.some((one) => one.body.includes(finding.title)))
    const publications = await d.host.call('finding/publications', { goal: run.goal, run: run.id })
    assert.equal(publications.items.length, 0, 'no posting is left unresolved')
  })
}

test('no candidate explains why, and a manually closed review round is visibly refused', E2E, async (t) => {
  const forge = new FakeFindingForge('a'.repeat(40))
  const d = await desk(t, undefined, { findingForge: forge })
  const run = await start(d, source('Review pull request #7'), {})
  const [card] = await claimed(d, run.goal, 'reviewer', 1)
  await bind(d, run.goal, await git(d.root, 'rev-parse', 'HEAD'))
  await assert.rejects(() => d.host.teamPlane.reviewCandidates(card!.id, scopeOf(card!)), /pull request #7.*(not found|not available|no open)/i)
  assert.match((await board(d, run.goal))[0]!.detail ?? '', /candidate.*pull request #7|pull request #7.*candidate/i)
  // The person can finish a card whose handoff has the review; that never certifies a posting.
  await d.host.call('team/intent', { room: run.goal, id: card!.id, action: 'done', outcome: 'approve' })
  await settled(d, run.id)
  const view = await d.host.call('finding/run', { goal: run.goal, run: run.id })
  assert.equal(view.publication, 'local')
  assert.match(view.reason ?? '', /review.*(candidate|recorded)/i)
  assert.equal(view.rounds[0]!.state, 'local', 'an empty review is visible as not posted, never none or posted')
  assert.match(view.rounds[0]!.reason ?? '', /review.*(candidate|recorded)/i)
  const publications = await d.host.call('finding/publications', { goal: run.goal, run: run.id })
  assert.match(publications.backfillRefusal ?? '', /review.*(candidate|recorded)/i)
  assert.equal(forge.sends.length, 0)
})

for (const predecessor of ['person', 'reader'] as const) for (const binding of ['card', 'team'] as const) {
  test(`a review after a ${predecessor} round seats at the external ${binding} PR and posts its verdict`, E2E, async (t) => {
    const forge = new FakeFindingForge('a'.repeat(40))
    const d = await desk(t, undefined, { findingForge: forge })
    await writeFile(join(d.root, 'attempt.txt'), 'Bound the retries.\n')
    await git(d.root, 'add', 'attempt.txt')
    await git(d.root, 'commit', '-q', '-m', 'bounded retry')
    const head = await git(d.root, 'rev-parse', 'HEAD')
    forge.head = head
    d.forge.pullRequests.set(7, { head, state: 'OPEN' })
    await git(d.root, 'checkout', '-q', 'main')
    const title = binding === 'card' ? 'Review pull request #7' : 'Review the bound change'
    const run = await start(d, `version: 2
name: Decide then review
roles:
  precursor: ${predecessor === 'person' ? '{ kind: person, outcomes: [go] }' : '{ kind: agent, uses: researcher, grant: read }'}
  reviewer: { kind: agent, uses: code-reviewer, grant: read }
seed: { role: precursor, title: Start the review }
rules:
  - { id: review, on: precursor, when: { every: [${predecessor === 'person' ? 'go' : 'gathered'}] }, then: { role: reviewer, title: "${title}" } }
`, {})
    if (binding === 'team') await bind(d, run.goal, head)
    if (predecessor === 'person') {
      const [person] = await board(d, run.goal)
      await d.host.call('team/intent', { room: run.goal, id: person!.id, action: 'done', outcome: 'go' })
    } else {
      const [reader] = await claimed(d, run.goal, 'precursor', 1)
      await answer(d, reader!, 'gathered')
    }
    const [card] = await claimed(d, run.goal, 'reviewer', 1)
    assert.equal(await git(cwdOf(d, card!), 'rev-parse', 'HEAD'), head, 'a non-writing dependency must not keep the reviewer on main')
    const [candidate] = await d.host.teamPlane.reviewCandidates(card!.id, scopeOf(card!))
    assert.equal(candidate?.at, head)
    await d.host.teamPlane.recordReview({ intent: card!.id, candidate: candidate!.id, verdict: 'approve' }, scopeOf(card!))
    await answer(d, card!, 'approve')
    await settled(d, run.id)
    const view = await whenChanged(d, async () => {
      const now = await d.host.call('finding/run', { goal: run.goal, run: run.id })
      return now.publication === 'posted' ? now : null
    }, 'the dependent external review to be posted')
    assert.equal(view.reviewersFinished, 1)
    assert.equal(forge.sends.length, 1)
  })
}
