import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { evaluateLeadAcceptance, leadBudgetProjection } from '@harnessdesk/lead'
import { LeadHandbacks } from '../src/lead/handback.js'
import { GitGateway } from '../src/git-gateway/index.js'
import { LeadPrFollow } from '../src/lead/pr-follow.js'
import { IntakePlane } from '../src/intake/plane.js'
import { createLeadRig } from './fixtures/lead-rig.js'
import { tempDir } from './scratch.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

for (const accepted of [false, true]) test(`host repairs validate and recover publication before ${accepted ? 'accepted repair reclaim' : 'live branch release'}`, { timeout: 180_000 }, async t => {
  const dir = tempDir('hd-lead-repair-host-'), remote = join(dir, 'remote.git')
  git(dir, 'init', '--bare', remote)
  let reviewAvailable = true, branch = '', crash = true, crashed = false, validated = false, adopted = 0
  const forgeGh = async (args: readonly string[]) => {
    assert.deepEqual(args.slice(0, 2), ['repo', 'view'], `unexpected forge call: ${args.join(' ')}`)
    return { stdout: JSON.stringify({ nameWithOwner: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranchRef: { name: 'main' } }), stderr: '', exitCode: 0 }
  }
  const gateway = new GitGateway({ directory: join(dir, 'gateway'), localRemote: repo => { assert.equal(repo, 'acme/widgets'); return remote }, gh: (_cwd, args) => forgeGh(args) })
  // Redirect the host's gateway to an actual private mirror and local bare remote.
  // No Git result, ledger outcome, ancestry proof or reviewed-head guard is stubbed.
  for (const name of ['inspectCheckout', 'push', 'repository', 'remoteHead', 'attribute', 'isAncestor', 'hasSucceededPush'] as const) {
    const original = GitGateway.prototype[name] as (...args: any[]) => any
    t.mock.method(GitGateway.prototype, name, function (...args: any[]) {
      if (name === 'hasSucceededPush') adopted++
      return original.apply(gateway, args)
    })
  }
  const recover = LeadHandbacks.prototype.recover
  const recoveryErrors: string[] = []
  t.mock.method(LeadHandbacks.prototype, 'recover', async function (this: LeadHandbacks) {
    try { await recover.call(this) } catch (error) { recoveryErrors.push(String(error)); throw error }
  })
  let following!: Parameters<IntakePlane['followPullRequests']>[0]
  t.mock.method(IntakePlane.prototype, 'followPullRequests', (port: Parameters<IntakePlane['followPullRequests']>[0]) => { following = port })
  const rig = await createLeadRig({ publication: true, waitMs: 60_000, forgeGh, reviewAvailable: () => reviewAvailable })
  t.after(() => rig.dispose())
  t.diagnostic('host fixture ready')
  await rig.sendGoal(); await rig.waitFor(() => !!rig.pending('plan'), 'plan')
  t.diagnostic('plan ready')
  await rig.decide(rig.pending('plan')!, 'approve')
  await rig.waitFor(() => !!rig.pending('result'), 'initial reviewed result')
  await rig.waitFor(() => { const last = rig.host.flowsPlane.leadRuns()[0]?.rounds.at(-1); return last?.role === 'accept' && last.state === 'running' }, 'initial person acceptance round')
  t.diagnostic('initial acceptance ready')
  const run = rig.host.flowsPlane.leadRuns()[0]!, owned = rig.journal.state.runs[0]!
  const session = rig.host.registry.all().find(record => record.runtime === 'rig-writer')!.session
  const cwd = session.cwd
  branch = git(cwd, 'branch', '--show-current')
  const h1 = git(cwd, 'rev-parse', 'HEAD'), checkout = await gateway.inspectCheckout(cwd)
  const source = { repository: 'acme/widgets', branch, head: h1, cwd, remote: 'origin', remoteUrl: 'https://github.com/acme/widgets.git',
    defaultBranch: 'main', runId: run.id, teamId: run.goal, runtime: 'rig-writer', sessionId: session.id }
  await rig.waitFor(() => !!rig.pending('result'), 'stable initial result')
  const card = rig.pending('result')!
  const decision = { version: 1 as const, cardId: card.id, cardType: 'result' as const, expectedRevision: card.revision, contractDigest: card.contractDigest, choice: 'accept-open-pr' as const }
  const operation = { id: 'initial-publication', source, decision, at: Date.now(), stage: 'push-prepared' as const, effectStarted: false }
  await rig.journal.publication(operation)
  await gateway.push({ repository: source.repository, branch, sha: h1, previousSha: null, objectStore: checkout.objectStore, tree: checkout.tree,
    requester: { kind: 'lead-goal', id: rig.journal.state.budget!.logicalGoalId } })
  await rig.journal.publication({ ...operation, stage: 'pushed' })
  await rig.journal.publication({ ...operation, stage: 'completed' }, { repository: source.repository, number: 7, branch, head: h1, branchOwner: 'lead', state: 'open', at: operation.at, check: null })
  // This fixture journals publication directly; settle the same real person
  // gate that the accept-open-pr host path answers before following.
  await rig.host.teamPlane.intentAction(run.goal, rig.personGates().at(-1)!.id, 'done', undefined, 'accepted')
  await rig.host.teamPlane.flush()
  await rig.journal.decideCard(decision, null)
  await rig.waitFor(() => rig.host.flowsPlane.leadRuns()[0]?.state === 'settled', 'accepted Flow settles before external repair')
  const pushOwned = LeadPrFollow.prototype.pushOwned
  t.mock.method(LeadPrFollow.prototype, 'pushOwned', async function (this: LeadPrFollow, source: Parameters<LeadPrFollow['pushOwned']>[0], validate: Parameters<LeadPrFollow['pushOwned']>[1]) {
    if (!validated) {
      reviewAvailable = false
      try { await assert.rejects(pushOwned.call(this, source, validate), /lead-repair-review-changed/) }
      finally { reviewAvailable = true }
      assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), h1)
      validated = true
    }
    return pushOwned.call(this, source, validate)
  })
  const ownedPush = rig.journal.ownedPush.bind(rig.journal)
  t.mock.method(rig.journal, 'ownedPush', async (operation: Parameters<typeof rig.journal.ownedPush>[0]) => {
    if (crash && ['completed', 'needs-you'].includes(operation.stage)) { crashed = true; throw new Error('simulated journal crash after push') }
    return ownedPush(operation)
  })
  const watch = () => following.watches()[0]!
  await rig.service.close() // Passive following needs no management child for a host repair.
  await following.deliver(watch(), { observations: [], facts: [{ source: 'pull-request', project: rig.project.path, repository: 'acme/widgets', subject: '7', event: 'failure-1', action: 'checks-failed',
    at: Date.now(), head: h1, fork: false, title: 'Fixture check failed', body: '', url: 'https://github.com/acme/widgets/pull/7', trigger: null, check: { head: h1, state: 'failed', total: 1 } }] } as any)
  try { await rig.waitFor(() => crashed, 'gateway push followed by journal crash') }
  catch (error) { throw new Error(`${error}; recovery=${JSON.stringify(recoveryErrors)}; acceptance=${JSON.stringify(rig.latestEvidence && evaluateLeadAcceptance(rig.journal.state.contract!, rig.latestEvidence, { now: Date.now(), freshnessMs: 60000, revision: rig.journal.state.seq }))}; budget=${JSON.stringify(leadBudgetProjection(rig.journal.state.budget!, Date.now()))}`) }
  assert.equal(validated, true)
  assert.equal(rig.journal.state.ownedPush?.stage, 'push-started')
  assert.equal(rig.journal.state.handbacks[0]!.stage, 'running')
  const h2 = git(remote, 'rev-parse', `refs/heads/${branch}`); assert.notEqual(h2, h1)
  crash = false
  await rig.waitFor(() => rig.journal.state.handbacks[0]?.stage === 'awaiting-ci', 'crash adoption through host refreshRepairs')
  assert.ok(adopted > 0, 'gateway hasSucceededPush proves recovery')
  const pushes = async () => (await readFile(join(dir, 'gateway', 'ledger.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.op === 'push' && row.outcome === 'succeeded')
  assert.equal((await pushes()).length, 2, 'one initial push and exactly one repair push')
  assert.equal(rig.pending('result'), undefined, 'E4 waits for CI')
  if (!accepted) {
  await following.deliver(watch(), { facts: [], observations: [{ repository: 'acme/widgets', number: 7, head: h2, state: 'open', check: { head: h2, state: 'failed', total: 1 }, at: Date.now() }] } as any)
  assert.equal(rig.journal.state.phase, 'waiting-for-user', 'a failed repaired head without a new event has a durable exit')
  assert.equal(rig.journal.state.managementReason, 'lead-repair-failed')
  assert.equal(rig.pending('result'), undefined)
  }
  await following.deliver(watch(), { facts: [], observations: [{ repository: 'acme/widgets', number: 7, head: h2, state: 'open', check: { head: h2, state: 'passed', total: 1 }, at: Date.now() }] } as any)
  assert.equal(rig.journal.state.handbacks[0]!.stage, accepted ? 'completed' : 'failed', 'terminal history stays immutable when current-head CI recovers')
  assert.ok(rig.pending('result'), 'E4 re-offers only after owned-head CI passes')
  if (accepted) {
    const acceptedCard = rig.pending('result')!
    await rig.host.teamPlane.intentAction(run.goal, rig.personGates().at(-1)!.id, 'done', undefined, 'accepted')
    await rig.host.teamPlane.flush()
    await rig.journal.decideCard({ version: 1, cardId: acceptedCard.id, cardType: 'result', expectedRevision: acceptedCard.revision, contractDigest: acceptedCard.contractDigest, choice: 'accept' })
    assert.equal(rig.journal.state.phase, 'following')
    const foreign = git(cwd, 'commit-tree', git(cwd, 'rev-parse', `${h2}^{tree}`), '-p', h2, '-m', 'Person extension')
    git(cwd, 'push', remote, `${foreign}:refs/heads/${branch}`)
    await following.deliver(watch(), { facts: [], observations: [{ repository: 'acme/widgets', number: 7, head: foreign, state: 'open', check: null, at: Date.now() }] } as any)
    const reclaim = rig.pending('branch-ownership')!
    await rig.journal.decideCard({ version: 1, cardId: reclaim.id, cardType: 'branch-ownership', expectedRevision: reclaim.revision, contractDigest: reclaim.contractDigest, choice: 'reclaim-branch' })
    await following.deliver(watch(), { facts: [], observations: [{ repository: 'acme/widgets', number: 7, head: foreign, state: 'open', check: { head: foreign, state: 'passed', total: 1 }, at: Date.now() }] } as any)
    assert.equal(rig.journal.state.handbacks.at(-1)!.stage, 'completed')
    assert.equal(rig.journal.state.phase, 'waiting-for-user')
    assert.equal(rig.journal.state.managementReason, 'lead-repair-unverified')
    assert.equal(rig.pending('result'), undefined)
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal(rig.journal.state.managementReason, 'lead-repair-unverified', 'the next host timer preserves the actionable wait')
    return
  }
  // Withdraw before opening a new round while the last reviewed result is still
  // at its person gate. Both delivery and the 1s host poll must agree on E4.
  const withdrawn = { ...rig.journal.state.handbacks[0]!, key: 'withdrawn-review', event: 'withdrawn-review', kind: 'reviews' as const,
    head: h2, round: rig.host.flowsPlane.leadRuns()[0]!.rounds.at(-1)!.n + 1, at: Date.now(), stage: 'prepared' as const, publishedHead: null }
  await rig.journal.handback(withdrawn)
  await rig.journal.settingsChanged(undefined, { checks: true, reviews: false })
  await following.deliver(watch(), { facts: [], observations: [] } as any)
  assert.equal(rig.journal.state.handbacks.at(-1)!.stage, 'withdrawn')
  assert.ok(rig.pending('result'), 'withdrawn-green re-offers the existing reviewed head through refreshRepairs')
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.ok(rig.pending('result'), 'the timer never changes withdrawal into a false unverified wait')
  assert.notEqual(rig.journal.state.managementReason, 'lead-repair-unverified')
  await rig.journal.settingsChanged(undefined, { checks: true, reviews: true })
  // Hold the next worker in its turn while the person extends and releases the branch.
  const repairGate = join(rig.home, 'worker-gates', 'followRepair')
  await unlink(repairGate)
  const secondDelivery = following.deliver(watch(), { observations: [], facts: [{ source: 'pull-request', project: rig.project.path, repository: 'acme/widgets', subject: '7', event: 'failure-2', action: 'checks-failed',
    at: Date.now(), head: h2, fork: false, title: 'Another fixture failure', body: '', url: 'https://github.com/acme/widgets/pull/7', trigger: null, check: { head: h2, state: 'failed', total: 1 } }] } as any)
  void secondDelivery.catch(() => {})
  await rig.waitFor(() => rig.host.teamPlane.stateFor(run.goal).intents.some(card => card.role === 'implement' && card.state === 'claimed'), 'second repair worker held in its live turn')
  const claim = rig.host.teamPlane.stateFor(run.goal).intents.find(card => card.role === 'implement' && card.state === 'claimed')!.claim!
  const heldSession = () => rig.host.registry.all().find(record => record.runtime === claim.runtime && record.session.id === claim.sessionId)!.session
  await rig.waitFor(() => heldSession().turns.some(turn => turn.status === 'inProgress'), 'claimed repair session has a live turn')
  const heldTurn = heldSession().turns.find(turn => turn.status === 'inProgress')!
  assert.equal(heldTurn.status, 'inProgress')
  const foreign = execFileSync('git', ['-C', cwd, 'commit-tree', git(cwd, 'rev-parse', `${h2}^{tree}`), '-p', h2, '-m', 'Person extension'], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Jane Doe', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Jane Doe', GIT_COMMITTER_EMAIL: 'dev@example.com' },
  }).trim()
  git(cwd, 'push', remote, `${foreign}:refs/heads/${branch}`)
  const releaseDelivery = following.deliver(watch(), { facts: [], observations: [{ repository: 'acme/widgets', number: 7, head: foreign, state: 'open', check: { head: foreign, state: 'passed', total: 1 }, at: Date.now() }] } as any)
  void releaseDelivery.catch(() => {})
  await rig.waitFor(() => rig.journal.state.pr?.branchOwner === 'person', 'person branch release journals before the live worker finishes')
  assert.equal(rig.journal.state.pr?.branchOwner, 'person')
  assert.equal(rig.journal.state.handbacks.at(-1)!.stage, 'abandoned')
  await writeFile(repairGate, '')
  await Promise.all([secondDelivery, releaseDelivery])
  await rig.waitFor(() => heldSession().turns.some(turn => turn.id === heldTurn.id && turn.status !== 'inProgress'), 'released worker turn ends without publication')
  await rig.settle(); await new Promise(resolve => setTimeout(resolve, 1200)); await rig.settle()
  assert.equal((await pushes()).length, 2, 'no repair push after release')
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), foreign)
  assert.equal(rig.pending('result'), undefined, 'E4 never re-offers while the person owns the branch')
  const reclaim = rig.pending('branch-ownership')!
  await rig.journal.decideCard({ version: 1, cardId: reclaim.id, cardType: 'branch-ownership', expectedRevision: reclaim.revision, contractDigest: reclaim.contractDigest, choice: 'reclaim-branch' })
  await following.deliver(watch(), { facts: [], observations: [{ repository: 'acme/widgets', number: 7, head: foreign, state: 'open', check: { head: foreign, state: 'passed', total: 1 }, at: Date.now() }] } as any)
  assert.equal(rig.journal.state.managementReason, 'lead-repair-unverified', 'reclaim-green reaches a real host action when the current head has no reviewed result')
  assert.equal(rig.journal.state.phase, 'waiting-for-user')
  assert.equal(owned.teamId, run.goal)
})
