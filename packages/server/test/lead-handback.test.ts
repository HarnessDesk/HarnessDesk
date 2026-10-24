import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLeadJournal, leadCheckpoint, parseLeadCheckpoint, leadWorkerDispatchBlockedByOpenPr } from '@harnessdesk/lead'
import { leadRig } from './fixtures/lead.js'

const load = async (): Promise<any> => import('../src/lead/' + 'handback.js')
const head = 'a'.repeat(40)
const setup = async (t: any) => {
  const s = await leadRig(t), run = await s.start(); await s.observe(0)
  const card: any = { version: 1, id: 'result', revision: 1, type: 'result', contractDigest: s.contract.digest,
    outcome: 'reviewed', summary: 'Reviewed fixture', assertions: [], budget: { version: 1, revision: 1, caps: s.contract.caps,
      leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 1, spend: 'known', stop: null } }
  await s.journal.offerCard(card)
  const source = { repository: 'acme/widgets', branch: 'worker', head, cwd: '/workspace/worker', remote: 'origin', remoteUrl: 'https://github.com/acme/widgets.git',
    defaultBranch: 'main', runId: run.id, teamId: run.goal, runtime: 'alpha', sessionId: 'worker' }
  const decision: any = { version: 1, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: s.contract.digest, choice: 'accept-open-pr' }
  const operation: any = { id: 'publication', source, decision, at: 100, stage: 'push-prepared', effectStarted: false }
  await s.journal.publication(operation)
  await s.journal.publication({ ...operation, stage: 'pushed' })
  await s.journal.publication({ ...operation, stage: 'completed' }, { repository: source.repository, number: 7, branch: source.branch, head, branchOwner: 'lead', state: 'open', at: 100, check: null })
  await s.journal.decideCard(decision, null)
  const rounds = new Map<string, number>(), calls: any[] = []
  let crash = '', eligible = true, reviewed: any = null
  const options = { journal: s.journal, now: () => 100, gate: async () => eligible ? null : 'lead-project-withdrawn',
    round: () => 4, open: async (op: any) => { assert.equal((options.journal.state as any).handbacks.at(-1)?.stage, 'prepared');
      if (crash === 'before') throw new Error('crash'); rounds.set(op.key, op.round); if (crash === 'after') throw new Error('crash'); return op.round },
    release: async (op: any) => { assert.equal((options.journal.state as any).handbacks.at(-1)?.stage, 'running'); calls.push(op) },
    reviewed: async () => reviewed, push: async (value: any) => { calls.push(['push', value.head]) },
  }
  const { LeadHandbacks } = await load()
  const owner = new LeadHandbacks(options)
  const fact: any = { source: 'pull-request', project: s.project.path, repository: 'acme/widgets', subject: '7', event: 'failure-1', action: 'checks-failed', at: 101,
    head, fork: false, title: '', body: '', url: 'https://github.com/acme/widgets/pull/7', trigger: null, check: { head, state: 'failed', total: 1 } }
  return { ...s, run, source, owner, options, fact, calls, rounds, crash: (v: string) => { crash = v }, eligible: (v: boolean) => { eligible = v }, reviewed: (v: any) => { reviewed = v } }
}

test('owned-head failure journals one same-Team repair, invalidates results, and replays its authority', async t => {
  const s = await setup(t)
  await s.owner.observe([s.fact, s.fact, { ...s.fact, head: 'b'.repeat(40) }])
  assert.equal(s.calls.length, 1); assert.equal(s.rounds.size, 1)
  const op = (s.journal.state as any).handbacks[0]
  assert.equal(op.teamId, s.run.goal); assert.equal(op.runId, s.run.id); assert.equal(op.head, head)
  assert.match(op.detail, /failure-1/); assert.match(op.detail, /github.com\/acme\/widgets\/pull\/7/)
  assert.equal(s.journal.state.phase, 'running')
  assert.equal(leadWorkerDispatchBlockedByOpenPr(s.journal.state), true, 'ordinary mutations stay fenced')
  assert.ok(s.journal.state.decidedCards.includes('result:1'))
  assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(s.journal.state, 'b'.repeat(64))).state, s.journal.state)
})
for (const point of ['before', 'after']) test(`crash ${point} round creation resumes the same cause and intended round`, async t => {
  const s = await setup(t); s.crash(point)
  await assert.rejects(s.owner.observe([s.fact]), /crash/)
  const journal = await createLeadJournal(s.storage); s.crash('')
  const { LeadHandbacks } = await load()
  s.options.journal = journal
  await new LeadHandbacks(s.options).recover()
  assert.equal(s.rounds.size, 1); assert.equal((journal.state as any).handbacks.length, 1)
})
test('follow preferences, stale events and branch release prevent hand-backs', async t => {
  const s = await setup(t)
  await s.journal.settingsChanged(undefined, { checks: false, reviews: false })
  await s.owner.observe([s.fact, { ...s.fact, action: 'review-commented', review: { id: 1, head, state: 'commented' }, authorWrites: true }])
  assert.equal(s.rounds.size, 0)
  await s.journal.settingsChanged(undefined, { checks: true, reviews: true })
  await s.journal.observePr({ ...s.journal.state.pr!, branchOwner: 'person', observedHead: head })
  await s.owner.observe([s.fact]); assert.equal(s.rounds.size, 0)
})
test('required gates retain prepared work and expired consent renews before dispatch', async t => {
  const s = await setup(t); s.eligible(false)
  await s.owner.observe([s.fact]); assert.equal(s.rounds.size, 0)
  s.eligible(true); s.setNow(2000); s.options.now = () => 2000
  await s.owner.recover(); assert.equal(s.rounds.size, 0); assert.equal(s.journal.state.phase, 'awaiting-plan')
})
test('review hand-backs stop at three and repeated check on a head has one durable Needs-you wait', async t => {
  for (const kind of ['review', 'check']) {
    const s = await setup(t)
    for (let i = 0; i < (kind === 'review' ? 4 : 2); i++) {
      const fact = kind === 'review' ? { ...s.fact, event: 'review-event', action: 'review-commented', review: { id: i + 1, head, state: 'commented' }, authorWrites: true } : { ...s.fact, event: `check-${i}` }
      await s.owner.observe([fact])
      // Complete this cycle so a later independent firing is eligible.
      const op = (s.journal.state as any).handbacks.at(-1)
      if (op?.stage === 'running') {
        await (s.journal as any).handback({ ...op, stage: 'awaiting-ci', publishedHead: head })
        await (s.journal as any).handback({ ...op, stage: 'completed', publishedHead: head })
      }
    }
    assert.equal(s.rounds.size, kind === 'review' ? 3 : 1)
    assert.equal(s.journal.state.managementReason, 'lead-handback-limit')
    const seq = s.journal.state.seq
    await s.owner.observe([{ ...s.fact, event: 'extra' }]); assert.equal(s.journal.state.seq, seq)
  }
})
test('repair publication waits for reviewed work then head-bound nonempty CI and records green once', async t => {
  const s = await setup(t); await s.owner.observe([s.fact])
  s.reviewed({ ...s.source, head: 'b'.repeat(40) })
  await s.owner.recover(); assert.equal(s.calls.filter(c => Array.isArray(c)).length, 1)
  const op = (s.journal.state as any).handbacks[0]
  assert.equal(op.stage, 'awaiting-ci')
  for (const check of [null, ...['pending'].map(state => ({ head: 'b'.repeat(40), state, total: state === 'pending' ? 2 : 0 }))]) {
    await s.journal.observePr({ ...s.journal.state.pr!, head: 'b'.repeat(40), observedHead: 'b'.repeat(40), check: check as any })
    await s.owner.recover(); assert.equal((s.journal.state as any).ciPassed.length, 0)
  }
  await assert.rejects(s.journal.observePr({ ...s.journal.state.pr!, check: { head, state: 'passed', total: 2 } }), /another head/)
  await assert.rejects(s.journal.observePr({ ...s.journal.state.pr!, check: { head: 'b'.repeat(40), state: 'passed', total: NaN } }))
  await s.journal.observePr({ ...s.journal.state.pr!, check: { head: 'b'.repeat(40), state: 'passed', total: 2 } })
  await s.owner.recover(); await s.owner.recover()
  assert.equal((s.journal.state as any).ciPassed.length, 1)
  assert.equal(s.journal.state.phase, 'running', 'normal acceptance evaluation may now offer a fresh result')
})

test('host-only Flow repair opens held cards on the owned Team and reuses the implementer checkout', async t => {
  const { goalRig, agent } = await import('./fixtures/flow-goal-rig.js')
  const { sourceDigest } = await import('../src/flow-execution.js')
  let released = true, prepared = false
  const rig = await goalRig(t, { executionOptions: { lead: { bind: async () => {}, round: async () => {},
    gate: async () => released ? { ok: true } : { ok: false, reason: 'held' },
    prepareRepair: async () => { assert.ok(prepared) },
  } as any } })
  const source = `version: 2
name: Repair fixture
roles:
  implement: { kind: agent, uses: writer, grant: edit, independentOf: [] }
  accept: { kind: person, outcomes: [accepted] }
seed: { role: implement, title: Implement }
rules:
  - { id: accept, on: implement, when: { every: [committed] }, then: { role: accept, title: Accept } }
complete: { accept: [accepted] }
`
  const run = await rig.flows.startGoal({ root: '/repo', sentence: 'Work', source, sourcePath: null, compiled: rig.compile(source, [agent('writer', ['committed'])]),
    lead: { logicalGoalId: 'logical-1', contractDigest: 'a'.repeat(64), startId: 'start', stepId: 'work' }, requireHeld: true,
    authorization: { sourceDigest: sourceDigest(source), commandDigest: sourceDigest(''), approvedAt: 100, start: 'front-door' } } as any)
  const writer = rig.seats.values().next().value!
  await rig.team.complete(run.rounds[0]!.cards[0]!, { outcome: 'committed' }, rig.sessionOf(String(writer.id)))
  await rig.flows.flush()
  const accepting = rig.flows.executionOf(run.id)!.rounds.at(-1)!
  await rig.team.intentAction(run.goal, accepting.cards[0]!, 'done', undefined, 'accepted')
  await rig.flows.flush()
  const before = rig.events.filter(event => event.startsWith('open:') || event.startsWith('order:')).length
  prepared = true; released = false
  const op = { key: 'repair-fixture', round: 3, runId: run.id, teamId: run.goal }
  const held = await (rig.flows as any).prepareLeadRepair(op)
  assert.equal(held.n, 3)
  assert.equal(rig.events.filter(event => event.startsWith('open:') || event.startsWith('order:')).length, before)
  released = true
  await (rig.flows as any).releaseLeadRepair(op)
  await rig.flows.flush()
  const current = rig.flows.executionOf(run.id)!
  assert.equal(current.goal, run.goal)
  assert.deepEqual(current.rounds.at(-1)!.seats, [String(writer.id)], JSON.stringify(current))
  await (rig.flows as any).prepareLeadRepair(op)
  assert.equal(rig.flows.executionOf(run.id)!.rounds.length, 3)
  released = false
  await rig.restart(); await rig.flows.resume()
  const orders = rig.events.filter(event => event.startsWith('order:')).length
  released = true
  await (rig.flows as any).releaseLeadRepair(op)
  assert.ok(rig.events.filter(event => event.startsWith('order:')).length > orders, 'the held startup is retried once its host owner is restored')
  const resumed = rig.events.filter(event => event.startsWith('order:')).length
  await (rig.flows as any).releaseLeadRepair(op)
  assert.equal(rig.events.filter(event => event.startsWith('order:')).length, resumed, 'polling never rearms the same live turn twice')
})

test('turning follow off withdraws prepared work and lets the other kind flow', async t => {
  const s = await setup(t); s.eligible(false); await s.owner.observe([s.fact])
  await s.journal.settingsChanged(undefined, { checks: false, reviews: true })
  s.eligible(true); await s.owner.recover(); assert.equal(s.calls.length, 0)
  await s.journal.settingsChanged(undefined, { checks: true, reviews: true })
  await s.owner.recover(); assert.equal(s.calls.length, 0)
  assert.equal(s.journal.state.handbacks[0]!.stage, 'withdrawn')
  await s.owner.observe([{ ...s.fact, event: 'review-other-kind', action: 'review-commented', review: { id: 1, head, state: 'commented' }, authorWrites: true }])
  assert.equal(s.calls.length, 1)
})

test('CI passed is real durable evidence once per Team and head, including after recovery', async () => {
  const { EvidencePlane } = await import('../src/evidence/plane.js')
  const { makeRepo } = await import('./fixtures/evidence-desk.js')
  const { tempDir } = await import('./scratch.js')
  const { join } = await import('node:path')
  const repo = await makeRepo('hd-lead-ci-'), dir = tempDir('hd-lead-ci-store-')
  const options = { dir, seenFile: join(dir, 'seen.json') }, port = { board: () => null, cwdOf: () => null, push() {}, log() {} }
  let plane = new EvidencePlane(options, port)
  const head = await repo.git('rev-parse', 'HEAD')
  await plane.observeLeadCi(repo.dir, 'team-1', `lead-ci-${head}`, head)
  await plane.observeLeadCi(repo.dir, 'team-1', `lead-ci-${head}`, head)
  plane = new EvidencePlane(options, port)
  await plane.observeLeadCi(repo.dir, 'team-1', `lead-ci-${head}`, head)
  await plane.observeLeadCi(repo.dir, 'team-2', `lead-ci-${head}`, head)
  const read = await plane.store.read(repo.dir, 'evidence')
  assert.equal(read.skipped, 0)
  const records = read.lines.flatMap(line => line.type === 'evidence' && line.record.fact.kind === 'ci' ? [line.record] : [])
  assert.equal(records.length, 2)
  assert.deepEqual(records.map(record => record.intake?.goal).sort(), ['team-1', 'team-2'])
  assert.equal((records[0]!.fact as any).checks[0].name, 'CI passed')
})

for (const outcome of ['failed', 'absent', 'passed-empty']) test(`observe retires a repaired head with ${outcome} CI before admitting its failure`, async t => {
  const s = await setup(t), repaired = 'b'.repeat(40)
  await s.owner.observe([s.fact]); s.reviewed({ ...s.source, head: repaired }); await s.owner.recover()
  await s.journal.observePr({ ...s.journal.state.pr!, head: repaired, check: { head: repaired, state: outcome === 'passed-empty' ? 'passed' : outcome as any, total: outcome === 'failed' ? 1 : 0 } })
  await s.owner.observe([{ ...s.fact, head: repaired, event: 'failure-2', check: { head: repaired, state: 'failed', total: 1 } }])
  assert.equal(s.journal.state.handbacks[0]!.stage, 'failed')
  assert.equal(s.journal.state.handbacks.length, 2)
  assert.equal(s.journal.state.handbacks[1]!.head, repaired)
  assert.equal(s.journal.state.handbackLimit, false)
})
for (const stage of ['running', 'awaiting-ci']) test(`release abandons ${stage} repair before reclaim and never pushes its result`, async t => {
  const s = await setup(t), repaired = 'b'.repeat(40), foreign = 'c'.repeat(40)
  await s.owner.observe([s.fact])
  if (stage === 'awaiting-ci') { s.reviewed({ ...s.source, head: repaired }); await s.owner.recover() }
  const pushes = s.calls.filter(Array.isArray).length
  await s.journal.observePr({ ...s.journal.state.pr!, branchOwner: 'person', observedHead: foreign, branchChange: 'fast-forward' })
  assert.equal(s.journal.state.handbacks[0]!.stage, 'abandoned')
  s.reviewed({ ...s.source, head: foreign }); await s.owner.recover()
  assert.equal(s.calls.filter(Array.isArray).length, pushes)
  const card: any = { version: 1, id: 'reclaim', revision: 1, type: 'branch-ownership', contractDigest: s.contract.digest,
    repository: 'acme/widgets', number: 7, observedHead: foreign, summary: 'Reclaim the branch after a person pushed.' }
  await s.journal.offerCard(card)
  await s.journal.decideCard({ version: 1, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: s.contract.digest, choice: 'reclaim-branch' } as any, null)
  await s.owner.recover(); assert.equal(s.calls.filter(Array.isArray).length, pushes)
  s.reviewed(null)
  await s.owner.observe([{ ...s.fact, head: foreign, event: 'fresh-after-reclaim', check: { head: foreign, state: 'failed', total: 1 } }])
  assert.equal(s.journal.state.handbacks.length, 2)
  assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
})
test('pending repair defers same-head check before the D4 limit', async t => {
  const s = await setup(t); await s.owner.observe([s.fact])
  await assert.rejects(s.owner.observe([{ ...s.fact, event: 'later-same-head' }]), /lead-handback-pending/)
  assert.equal(s.journal.state.handbackLimit, false)
})
test('a failed push journals Needs-you once and recovery waits for resume', async t => {
  const s = await setup(t); await s.owner.observe([s.fact]); s.reviewed({ ...s.source, head: 'b'.repeat(40) })
  let attempts = 0
  s.options.push = async () => {
    attempts++
    const op: any = { source: { ...s.source, head: 'b'.repeat(40) }, number: 7, previousHead: head, at: 100, stage: 'prepared', effectStarted: false }
    if (attempts === 1) { await s.journal.ownedPush(op); await s.journal.ownedPush({ ...op, stage: 'needs-you' }); throw new Error('push refused') }
  }
  await assert.rejects(s.owner.recover(), /push refused/)
  const seq = s.journal.state.seq
  await s.owner.recover(); await s.owner.recover()
  assert.equal(attempts, 1); assert.equal(s.journal.state.seq, seq)
  await s.journal.resume()
  await s.owner.recover(); assert.equal(attempts, 2, 'person resume permits a new push attempt')
})
test('prepared repair preserves the pending renewal phase', async t => {
  const s = await setup(t); s.setNow(2000); s.options.now = () => 2000
  await s.journal.setManagementPhase('waiting-for-user', 'lead-tools-refused')
  await s.journal.renewPlan(2000)
  assert.equal(s.journal.state.phase, 'awaiting-plan')
  await s.owner.observe([s.fact])
  assert.equal(s.journal.state.phase, 'awaiting-plan')
  assert.equal(s.journal.state.handbacks[0]!.stage, 'prepared')
})
test('real LeadBudgets prepareRepair validates the journaled repair and membership', async t => {
  const s = await setup(t); s.eligible(false); await s.owner.observe([s.fact])
  const op = s.journal.state.handbacks[0]!, run = s.rig.flows.leadRuns()[0]!
  await s.budgets.prepareRepair(run, op.key, op.round)
  await assert.rejects(s.budgets.prepareRepair(run, 'other-key', op.round), /lead-repair-not-approved/)
  s.setMember(false)
  await assert.rejects(s.budgets.prepareRepair(run, op.key, op.round), /lead-repair-not-approved/)
})

test('a stopped awaiting-CI repair ignores a later failed-check fact', async t => {
  const s = await setup(t), repaired = 'b'.repeat(40)
  await s.owner.observe([s.fact]); s.reviewed({ ...s.source, head: repaired }); await s.owner.recover()
  await s.journal.observePr({ ...s.journal.state.pr!, head: repaired, check: { head: repaired, state: 'pending', total: 1 } })
  await s.journal.stop()
  const seq = s.journal.state.seq
  await s.owner.observe([{ ...s.fact, event: 'late-after-stop', head: repaired, check: { head: repaired, state: 'failed', total: 1 } }])
  assert.equal(s.journal.state.seq, seq)
})

test('a newer pending poll cannot hide a failed-check fact on the published head', async t => {
  const s = await setup(t), repaired = 'b'.repeat(40)
  await s.owner.observe([s.fact]); s.reviewed({ ...s.source, head: repaired }); await s.owner.recover()
  await s.journal.observePr({ ...s.journal.state.pr!, head: repaired, at: 200, check: { head: repaired, state: 'pending', total: 1 } })
  await s.owner.observe([{ ...s.fact, at: 150, event: 'repaired-head-failure', head: repaired, check: { head: repaired, state: 'failed', total: 1 } }])
  assert.equal(s.journal.state.handbacks[0]!.stage, 'failed')
  assert.equal(s.journal.state.handbacks.length, 2)
})
