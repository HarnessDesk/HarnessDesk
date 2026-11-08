import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { leadBudgetProjection, type LeadAcceptanceEvidence } from '@harnessdesk/lead'
import { IntakePlane } from '../src/intake/plane.js'
import { LeadBudgets } from '../src/lead/budgets.js'
import { LeadHandbacks } from '../src/lead/handback.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'
import { leadRig } from './fixtures/lead.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

for (const fence of [null, 'person', 'stopped'] as const) test(`host refresh drains a withdrawn repair during an older evidence read (${fence ?? 'fresh pass'})`, { timeout: 10_000 }, async t => {
  const entered = deferred(), release = deferred()
  t.after(() => { release.resolve() })
  const s = await leadRig(t), run = await s.start(); await s.observe(0)
  const { host } = await evidenceDesk(t, { leadEnabled: true })
  const { journal, contract } = s, head = 'a'.repeat(40)
  // The Flow fixture starts at clock 100; host controls use the real clock.
  await journal.renewPlan(Date.now())
  const plan = journal.state.cards.find(card => card.type === 'plan')!
  await journal.decideCard({ version: 1, cardId: plan.id, cardType: 'plan', expectedRevision: plan.revision,
    contractDigest: contract.digest, choice: 'approve' }, Date.now() + 60_000)
  const card = { version: 1 as const, id: 'result', revision: 1, type: 'result' as const, contractDigest: contract.digest,
    outcome: 'reviewed' as const, summary: 'Reviewed fixture', assertions: [], budget: leadBudgetProjection(journal.state.budget!, 100) }
  await journal.offerCard(card)
  const source = { repository: 'acme/widgets', branch: 'worker', head, cwd: '/workspace/worker', remote: 'origin',
    remoteUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main', runId: run.id, teamId: run.goal, runtime: 'alpha', sessionId: 'worker' }
  const decision = { version: 1 as const, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: contract.digest, choice: 'accept-open-pr' as const }
  const publication = { id: 'publication', source, decision, at: 100, stage: 'push-prepared' as const, effectStarted: false }
  await journal.publication(publication)
  await journal.publication({ ...publication, stage: 'pushed' })
  await journal.publication({ ...publication, stage: 'completed' }, { repository: source.repository, number: 7, branch: source.branch, head, branchOwner: 'lead', state: 'open', at: 100, check: { head, state: 'passed', total: 1 } })
  await journal.decideCard(decision, null)
  await journal.ciPassed(head)
  const old = { key: 'old', event: 'old', kind: 'checks' as const, head, runId: run.id, teamId: run.goal,
    detail: 'Synthetic check', round: 1, at: 101, stage: 'prepared' as const, publishedHead: null }
  await journal.handback(old)
  await journal.handback({ ...old, stage: 'withdrawn' })
  // Keep actual journal/recovery/refresh logic. Flow and accounting inputs are
  // fixed so only the evidence-read interleaving can decide this result.
  t.mock.method(host.flowsPlane, 'leadRuns', () => [{ ...run, rounds: [{ n: 2, role: 'accept', state: 'running', cards: [1] }] }] as any)
  t.mock.method(host.teamPlane, 'stateFor', () => ({ intents: [{ id: 1, state: 'open' }] }) as any)
  t.mock.method(LeadBudgets.prototype, 'meter', async () => {})
  let following!: Parameters<IntakePlane['followPullRequests']>[0]
  t.mock.method(IntakePlane.prototype, 'followPullRequests', (port: Parameters<IntakePlane['followPullRequests']>[0]) => { following = port })
  t.mock.method(IntakePlane.prototype, 'followingChanged', async () => {})
  // The poll cannot rescue a delivery that returns before its own fresh pass.
  t.mock.timers.enable({ apis: ['setInterval'] })
  const reads: string[] = []
  const service = host.createLeadService({ journal, project: s.project, prices: {},
    resolveTool: async () => { throw new Error('unused') }, freezePlan: async value => value,
    readEvidence: async (): Promise<LeadAcceptanceEvidence> => {
      reads.push(journal.state.handbacks.at(-1)!.key)
      if (reads.length === 1) { entered.resolve(); await release.promise }
      // Intentionally incomplete evidence must park the *current* operation,
      // never borrow the superseded read or leave its delivery unrefreshed.
      return { project: s.project, runId: run.id, contractDigest: contract.digest, revision: head, observedAt: Date.now(),
        complete: false, spendComplete: true, checks: [], reviews: [], findingsComplete: true, findings: [], diffs: [] }
    },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }),
  })
  t.after(async () => { release.resolve(); await service.close() })
  await entered.promise // Startup reconcile is suspended in the old evidence read.
  const next = { ...old, key: 'next', event: 'next', kind: 'reviews' as const, at: 102 }
  await journal.handback(next)
  await journal.settingsChanged(undefined, { checks: true, reviews: false })
  const observed = deferred(), observe = LeadHandbacks.prototype.observe
  let observations = 0
  t.mock.method(LeadHandbacks.prototype, 'observe', async function(this: LeadHandbacks, facts: Parameters<LeadHandbacks['observe']>[0]) {
    await observe.call(this, facts)
    if (++observations === 2) observed.resolve()
  })
  const delivery = Promise.all([0, 1].map(() => following.deliver(following.watches()[0]!, { facts: [], observations: [] } as any)))
  await observed.promise
  await setImmediate() // Drain delivery's continuation into refreshRepairs before releasing evidence.
  assert.equal(journal.state.handbacks.at(-1)!.stage, 'withdrawn')
  assert.equal(journal.state.managementReason, null, 'stale evidence has not changed the newer operation')
  if (fence === 'person') await journal.observePr({ ...journal.state.pr!, branchOwner: 'person', observedHead: head })
  if (fence === 'stopped') await journal.stop()
  release.resolve()
  await delivery
  const diagnostic = JSON.stringify({ phase: journal.state.phase, reason: journal.state.managementReason,
    op: journal.state.handbacks.at(-1), cards: journal.state.cards, decided: journal.state.decidedCards, reads })
  assert.deepEqual(reads, fence ? ['old'] : ['old', 'next'], diagnostic)
  if (fence) {
    assert.equal(journal.state.cards.some(card => card.type === 'result' && !journal.state.decidedCards.includes(`${card.id}:${card.revision}`)), false, diagnostic)
    assert.notEqual(journal.state.managementReason, 'lead-repair-unverified', diagnostic)
    if (fence === 'stopped') assert.equal(journal.state.phase, 'stopped', diagnostic)
    else assert.equal(journal.state.pr?.branchOwner, 'person', diagnostic)
  } else {
    assert.equal(journal.state.phase, 'waiting-for-user', diagnostic)
    assert.equal(journal.state.managementReason, 'lead-repair-unverified', diagnostic)
  }
})
