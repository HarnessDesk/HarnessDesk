import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createLeadJournal, leadCheckpoint, parseLeadCheckpoint } from '@harnessdesk/lead'
import { parseLeadAcceptanceContract, parseLeadCard } from '@harnessdesk/protocol'

const moduleOf = async (): Promise<any> => {
  const path = new URL('../src/lead/pr-follow.js', import.meta.url).href
  const value = await import(path).catch(() => ({}))
  assert.equal(typeof value.LeadPrFollow, 'function', 'host-owned publication owner must exist')
  return { ...value,
    LeadPrFollow: class extends value.LeadPrFollow { constructor(options: any) { super({ ...options, allowLocalFile: true }) } },
    pushToOwnedBranch: (source: any, owned: any, reconcile = false) => value.pushToOwnedBranch(source, owned, reconcile, undefined, true),
    pushOwnedLeadBranch: (options: any) => value.pushOwnedLeadBranch({ ...options, allowLocalFile: true }),
  }
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const repository = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'hd-lead-push-')), remoteUrl = join(cwd, 'remote.git')
  git(cwd, 'init', '--bare', '--initial-branch=main', remoteUrl)
  git(cwd, 'init', '--initial-branch=worker')
  git(cwd, 'config', 'user.name', 'Jane Doe'); git(cwd, 'config', 'user.email', 'dev@example.com')
  git(cwd, 'commit', '--allow-empty', '-m', 'Initial fixture')
  git(cwd, 'remote', 'add', 'origin', remoteUrl)
  return { cwd, remote: 'origin', remoteUrl, defaultBranch: 'main', repository: 'acme/widgets', branch: 'worker', head: git(cwd, 'rev-parse', 'HEAD'),
    runId: 'run-1', teamId: 'team-1', runtime: 'fixture', sessionId: 'worker-1' }
}
const prepare = async () => {
  const records: any[] = []; let fail: string | null = null
  const storage = { async read() { return structuredClone(records) }, async append(event: any) {
    if (event.type === fail) throw new Error('simulated crash'); records.push(structuredClone(event))
  } }
  const journal = await createLeadJournal(storage)
  const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Repair the check',
    project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'implement', title: 'Implement', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {}, attendance: 'attended',
      assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }],
    assertions: [{ id: 'check', kind: 'check', description: 'Check passes' }], caps: { usdMicros: 10000, rounds: 3 } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'goal-1', caps: contract.caps, freshnessMs: 10000 })
  await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  await journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 1000)
  const card = parseLeadCard({ version: 1, id: 'result', revision: 1, type: 'result', contractDigest: contract.digest, outcome: 'reviewed',
    summary: 'Reviewed fixture', assertions: [], budget: { version: 1, revision: 1, caps: contract.caps, leadUsdMicros: 0, workerUsdMicros: 0,
      reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known', stop: null } }) as any
  await journal.offerCard(card)
  const decision = { version: 1, cardId: card.id, cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept-open-pr' }
  return { journal, card, contract, decision, records, storage, failOn(type: string | null) { fail = type } }
}

test('host push creates only a new branch, reconciles once, and refuses defaults and non-fast-forwards', async () => {
  const { pushToOwnedBranch } = await moduleOf(), source = repository()
  assert.deepEqual(await pushToOwnedBranch(source, null), { pushed: true })
  assert.equal(git(source.cwd, 'ls-remote', 'origin', 'refs/heads/worker').split(/\s/)[0], source.head)
  assert.deepEqual(await pushToOwnedBranch(source, null, true), { pushed: false })
  await assert.rejects(pushToOwnedBranch(source, null), /owned|exists/)
  await assert.rejects(pushToOwnedBranch({ ...source, branch: 'main' }, null), /default|changed/)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Repair fixture')
  const repair = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  await pushToOwnedBranch(repair, source.head)
  await assert.rejects(pushToOwnedBranch(source, repair.head), /fast-forward|changed/)
  assert.equal(git(source.cwd, 'ls-remote', 'origin', 'refs/heads/worker').split(/\s/)[0], repair.head)
  const unrelated = git(source.cwd, 'commit-tree', git(source.cwd, 'rev-parse', 'HEAD^{tree}'), '-m', 'Unrelated fixture')
  git(source.cwd, 'update-ref', 'refs/heads/worker', unrelated)
  await assert.rejects(pushToOwnedBranch({ ...source, head: unrelated }, repair.head), /fast-forward/)
  assert.equal(git(source.cwd, 'ls-remote', 'origin', 'refs/heads/worker').split(/\s/)[0], repair.head)
})

test('approval journals before each external effect, owns the PR, and follows through checkpoint recovery', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  let pushes = 0, creates = 0
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [], push: async () => { assert.equal((s.journal.state as any).publication.stage, 'push-started'); pushes++ },
    create: async () => { assert.equal((s.journal.state as any).publication.stage, 'create-prepared'); creates++; return { repository: source.repository, number: 7, head: source.head, branch: source.branch } } })
  await owner.accept(s.card, s.decision, s.contract)
  assert.equal(pushes, 1); assert.equal(creates, 1)
  assert.equal(s.journal.state.phase, 'following')
  assert.equal((s.journal.state as any).pr.number, 7)
  const restored = await createLeadJournal(s.storage)
  assert.deepEqual(restored.state, s.journal.state)
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(s.journal.state, 'b'.repeat(64))).state, s.journal.state)
  assert.equal(owner.watches().length, 1)
  await owner.observe({ repository: 'acme/other', number: 7, head: source.head, state: 'merged', check: null, at: 101 })
  assert.equal(s.journal.state.phase, 'following')
  await owner.observe({ repository: source.repository, number: 7, head: source.head, state: 'closed', check: null, at: 101 })
  assert.equal(s.journal.state.phase, 'declined')
  assert.equal((s.journal.state as any).pr.state, 'closed')
})

test('crash after create adopts the verified PR without pushing or creating twice', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  let pushes = 0, creates = 0, exists = false
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const ports = { now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => exists ? [pr] : [], push: async () => { pushes++ }, create: async () => { creates++; exists = true; s.failOn('publication'); return pr } }
  const owner = new LeadPrFollow({ ...ports, journal: s.journal })
  await assert.rejects(owner.accept(s.card, s.decision, s.contract))
  s.failOn(null)
  const journal = await createLeadJournal(s.storage)
  await new LeadPrFollow({ ...ports, journal }).reconcile()
  assert.equal(pushes, 1); assert.equal(creates, 1); assert.equal(journal.state.phase, 'following')
})

test('changed gates and stale push cards cause zero publication calls; push approval uses the result path', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  let calls = 0, changed = false
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, source: async () => source,
    validate: async () => { if (changed) throw new Error('changed evidence') }, find: async () => [],
    push: async () => { calls++ }, create: async () => { calls++; return { repository: source.repository, number: 7, head: source.head, branch: source.branch } } })
  const card = { ...s.card, revision: 2, publication: 'push' }
  await s.journal.offerCard(card)
  await assert.rejects(owner.accept(s.card, s.decision, s.contract))
  assert.equal(calls, 0)
  const decision = { ...s.decision, expectedRevision: 2 }
  changed = true
  await assert.rejects(owner.accept(card, decision, s.contract))
  assert.equal(calls, 0)
  changed = false
  await owner.accept(card, decision, s.contract)
  assert.equal(calls, 2)
})


test('a matching worker publication is claimed once; conflicting publication makes no push or create calls', async () => {
  const { LeadPrFollow } = await moduleOf()
  for (const matches of [true, false]) {
    const s = await prepare(), source = repository()
    let effects = 0
    const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
      find: async () => [{ repository: matches ? source.repository : 'acme/other', number: 7, branch: source.branch, head: source.head }],
      push: async () => { effects++ }, create: async () => { effects++; throw new Error('unexpected create') } })
    if (matches) {
      await owner.accept(s.card, s.decision, s.contract)
      assert.equal(s.journal.state.phase, 'following')
      await owner.reconcile()
      await assert.rejects(owner.accept(s.card, s.decision, s.contract))
    } else {
      await assert.rejects(owner.accept(s.card, s.decision, s.contract))
      assert.equal(s.journal.state.phase, 'waiting-for-user')
      assert.equal((s.journal.state as any).publication.stage, 'needs-you')
    }
    assert.equal(effects, 0)
  }
})

test('crash after push reconciles the bare remote without a second push', async () => {
  const { LeadPrFollow, pushToOwnedBranch } = await moduleOf(), s = await prepare(), source = repository()
  let pushes = 0, crash = true
  const ports = { now: () => 100, validate: async () => {}, source: async () => source, find: async () => [],
    push: async (source: any, owned: any, reconcile: boolean) => {
      const result = await pushToOwnedBranch(source, owned, reconcile)
      if (result.pushed) pushes++
      if (crash) s.failOn('publication')
    }, create: async () => ({ repository: source.repository, number: 7, head: source.head, branch: source.branch }) }
  await assert.rejects(new LeadPrFollow({ ...ports, journal: s.journal }).accept(s.card, s.decision, s.contract))
  crash = false; s.failOn(null)
  const journal = await createLeadJournal(s.storage)
  await new LeadPrFollow({ ...ports, journal }).reconcile()
  assert.equal(pushes, 1)
  assert.equal(journal.state.phase, 'following')
})

test('changed worker identity after preparation refuses all external effects', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  let reads = 0, effects = 0
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {},
    source: async () => ++reads === 1 ? source : { ...source, branch: 'other-worker' }, find: async () => [],
    push: async () => { effects++ }, create: async () => { effects++; throw new Error('unexpected create') } })
  await assert.rejects(owner.accept(s.card, s.decision, s.contract))
  assert.equal(effects, 0)
})

test('merged and unmerged closure differ, preferences replay, and both switches off retain lifecycle observation', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  await s.journal.settingsChanged(undefined, { checks: false, reviews: false })
  assert.deepEqual((await createLeadJournal(s.storage)).state.follow, { checks: false, reviews: false })
  assert.equal(owner.watches().length, 1)
  await owner.observe({ ...pr, state: 'merged', check: null, at: 101 })
  assert.equal(s.journal.state.phase, 'accepted')
  assert.equal(s.journal.state.pr?.state, 'merged')
})


test('host and git plugin share signed PR creation through the fake gh fixture', async () => {
  const { LeadPrFollow } = await moduleOf(), { leadPublicationPorts } = await import('../src/lead/pr-publication.js')
  const s = await prepare(), source = repository(), statePath = join(source.cwd, 'fake-forge.json')
  writeFileSync(statePath, JSON.stringify({ repo: source.repository, pulls: [], issues: [], user: { id: 7, login: 'demo' } }))
  const references: any[] = []
  const ports = leadPublicationPorts({ allowLocalFile: true, journal: s.journal, project: s.contract.project, seats: () => [],
    evidence: async () => { throw new Error('not used') }, publications: async () => [], signature: () => undefined,
    forge: { async publicationAllowed() { return { ok: true } }, async identity() { return { via: 'gh', login: 'demo', available: true, reason: null } },
      async seat() { return { agent: 'Fixture', version: '1', model: 'Demo', effort: null, thinking: false, label: 'Fixture Demo', role: 'implement', round: null, team: 'Fixture' } },
      async publish(reference) { references.push(reference) } },
    gh: async (cwd, args) => ({ stdout: execFileSync(process.execPath, [new URL('./fixtures/fake-gh.mjs', import.meta.url).pathname, ...args],
      { cwd, encoding: 'utf8', env: { ...process.env, FAKE_GH_STATE: statePath } }), stderr: '', exitCode: 0 }),
  })
  const owner = new LeadPrFollow({ ...ports, journal: s.journal, now: () => 100, source: async () => source, validate: async () => {} })
  await owner.accept(s.card, s.decision, s.contract)
  const forge = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(forge.pulls.length, 1)
  assert.match(forge.pulls[0].body, /Fixture Demo/)
  assert.match(forge.pulls[0].body, /harnessdesk:lead:goal-1:publication-/)
  assert.equal(references.length, 1)
  assert.equal(s.journal.state.pr?.number, 1)
})

test('review status is owned, head-bound, preference-gated, and durable', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  const fact: any = { repository: source.repository, subject: '7', head: source.head, action: 'review-commented', at: 101,
    review: { id: 10, head: source.head, state: 'changes-requested' } }
  await owner.observeFacts([{ ...fact, repository: 'acme/other' }, { ...fact, head: 'b'.repeat(40) }])
  assert.equal(s.journal.state.pr?.review, undefined)
  await owner.observeFacts([fact, fact])
  assert.deepEqual((await createLeadJournal(s.storage)).state.pr?.review, fact.review)
  await s.journal.settingsChanged(undefined, { checks: true, reviews: false })
  await owner.observeFacts([{ ...fact, review: { ...fact.review, id: 11, state: 'approved' } }])
  assert.deepEqual(s.journal.state.pr?.review, fact.review)
})

test('disk refusal before publication preparation prevents every forge effect', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  let effects = 0
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [], push: async () => { effects++ }, create: async () => { effects++; throw new Error('unexpected create') } })
  s.failOn('publication')
  await assert.rejects(owner.accept(s.card, s.decision, s.contract))
  assert.equal(effects, 0)
})

test('publication source is derived from the reviewed worker and the approved repository, never another checkout', async t => {
  const { leadPublicationPorts } = await import('../src/lead/pr-publication.js')
  const s = await prepare(), source = repository(), project = { id: 'project-demo', path: source.cwd }
  git(source.cwd, 'config', 'remote.origin.pushurl', 'https://github.com/acme/widgets.git')
  let worker = source
  const state = s.journal.state
  t.mock.getter(s.journal, 'state', () => ({ ...state, runs: [{ runId: 'run-1', teamId: 'team-1', correlationId: 'start-1' }],
    steps: [{ id: 'implement', state: 'started' as const, attemptId: 'start-1', contractDigest: s.contract.digest }] }))
  const ports = leadPublicationPorts({ journal: s.journal, project,
    seats: () => [{ role: 'implement', board: 'team-1', openedAt: 100, checkout: { cwd: worker.cwd, project: project.path, branch: worker.branch },
      session: { runtime: 'fixture', sessionId: 'worker-1' } } as any],
    evidence: async () => ({ revision: worker.head, complete: true, spendComplete: true, checks: [], reviews: [], findings: [], diffs: [] } as any), publications: async () => [], signature: () => undefined,
    forge: { async publicationAllowed() { return { ok: true } }, async seat() { return null },
      async identity() { return { via: 'gh', available: true, reason: null, login: 'demo' } }, async publish() {} },
    gh: async () => ({ stdout: JSON.stringify({ nameWithOwner: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranchRef: { name: 'main' } }), stderr: '', exitCode: 0 }),
  })
  const contract = { ...s.contract, project, publicationRepository: 'acme/widgets' }
  const read = await ports.source(s.card, contract)
  assert.equal(read.head, source.head); assert.equal(read.repository, 'acme/widgets')
  await assert.rejects(ports.source({ ...s.card, publication: 'push', publicationSource: { runId: 'run-1', reviewedHead: 'b'.repeat(40), evidenceRevision: source.head } }, contract), /lead-card-stale/)
  await assert.rejects(ports.source({ ...s.card, publication: 'push', publicationSource: { runId: 'run-1', reviewedHead: source.head, evidenceRevision: 'old-evidence' } }, contract), /lead-card-stale/)
  git(source.cwd, 'config', 'remote.origin.pushurl', 'https://github.com/acme/other.git')
  await assert.rejects(ports.source(s.card, contract), /repository-changed/)
  worker = repository()
  await assert.rejects(ports.source(s.card, contract), /repository-changed/)
})


test('repair pushes journal before acting, advance the owned head, and reconcile a crash without another push', async () => {
  const { LeadPrFollow, pushToOwnedBranch, pushOwnedLeadBranch } = await moduleOf(), s = await prepare(), source = repository()
  await pushToOwnedBranch(source, null)
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 101, validate: async () => {}, source: async () => source,
    find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed repair fixture')
  const repair = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  const append = s.storage.append.bind(s.storage)
  s.storage.append = async event => {
    if (event.type === 'owned-push' && event.operation.stage === 'completed') throw new Error('simulated completion crash')
    await append(event)
  }
  await assert.rejects(owner.pushOwned(repair, async () => {}))
  assert.equal(s.journal.state.ownedPush?.stage, 'push-started')
  assert.equal(git(source.cwd, 'ls-remote', 'origin', 'refs/heads/worker').split(/\s/)[0], repair.head)
  s.storage.append = append
  const journal = await createLeadJournal(s.storage)
  await pushOwnedLeadBranch({ journal, source: repair, now: () => 102, validate: async () => {} })
  assert.equal(journal.state.pr?.head, repair.head)
  assert.equal(journal.state.pr?.number, 7)
  assert.equal(journal.state.pr?.check, null)
  assert.equal(journal.state.ownedPush?.stage, 'completed')
  assert.deepEqual((await createLeadJournal(s.storage)).state, journal.state)
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(journal.state, 'b'.repeat(64))).state, journal.state)
  const seq = journal.state.seq
  await pushOwnedLeadBranch({ journal, source: repair, now: () => 103, validate: async () => { throw new Error('duplicate must be a no-op') } })
  assert.equal(journal.state.seq, seq)
})

for (const [observed, phase] of [['merged', 'accepted'], ['closed', 'declined'], ['open', 'waiting-for-user']] as const) {
  test(`foreign PR head with ${observed} lifecycle becomes ${phase} without adopting its head`, async () => {
    const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
    const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
    const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
      find: async () => [pr], create: async () => pr })
    await owner.accept(s.card, s.decision, s.contract)
    await owner.observe({ ...pr, head: 'b'.repeat(40), state: observed, check: null, at: 101 })
    assert.equal(s.journal.state.phase, phase)
    assert.equal(s.journal.state.pr?.head, source.head)
    assert.equal((s.journal.state.pr as any).observedHead, 'b'.repeat(40))
    if (observed === 'open') assert.equal(s.journal.state.managementReason, 'lead-pr-head-changed')
    assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
    assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(s.journal.state, 'b'.repeat(64))).state, s.journal.state)
  })
}

test('Needs-you publication without a started effect can be superseded by a new reviewed head', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(); let source = repository(), conflict = true
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => conflict ? [{ repository: 'acme/other', number: 7, head: source.head, branch: source.branch }] : [],
    push: async () => {}, create: async () => ({ repository: source.repository, number: 7, head: source.head, branch: source.branch }) })
  await assert.rejects(owner.accept(s.card, s.decision, s.contract), /conflict/)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'New reviewed fixture')
  source = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }; conflict = false
  const card = { ...s.card, revision: 2 }; await s.journal.offerCard(card)
  await owner.accept(card, { ...s.decision, expectedRevision: 2 }, s.contract)
  assert.ok(s.records.some(record => record.operation?.stage === 'superseded'))
  assert.equal(s.journal.state.phase, 'following')
})

test('a refusal and a person retry never adopt an existing unowned branch', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  git(source.cwd, 'push', 'origin', 'HEAD:refs/heads/worker')
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [], create: async () => { throw new Error('must not create') } })
  await assert.rejects(owner.accept(s.card, s.decision, s.contract), /lead-push-branch-exists-not-owned/)
  await assert.rejects(owner.accept(s.card, s.decision, s.contract), /lead-push-branch-exists-not-owned/)
  assert.equal(s.journal.state.pr, null)
})

test('a click reconciles a durable push-prepared operation without requiring a boot', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  await s.journal.publication({ id: 'publish-1', source, decision: s.decision as any, at: 100, stage: 'push-prepared' })
  let effects = 0
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [], push: async () => { effects++ },
    create: async () => ({ repository: source.repository, number: 7, head: source.head, branch: source.branch }) })
  await owner.accept(s.card, s.decision, s.contract)
  assert.equal(effects, 1)
  assert.equal(s.journal.state.phase, 'following')
})

test('repository URL rewrites never redirect the host push to a decoy', async () => {
  const { pushToOwnedBranch } = await moduleOf(), source = repository(), decoy = join(source.cwd, 'decoy.git')
  git(source.cwd, 'init', '--bare', decoy)
  git(source.cwd, 'config', `url.${decoy}.insteadOf`, source.remoteUrl)
  git(source.cwd, 'config', `url.${decoy}.pushInsteadOf`, source.remoteUrl)
  await pushToOwnedBranch(source, null)
  assert.equal(git(source.remoteUrl, 'rev-parse', 'refs/heads/worker'), source.head)
  assert.equal(git(decoy, 'for-each-ref', '--format=%(refname)'), '')
})

test('worker credential helpers and askpass programs cannot run in host network git', async t => {
  const { hardenedNetworkGit } = await import('../src/git-hardening.js') as any
  const source = repository(), marker = join(source.cwd, 'credential-marker'), askpass = join(source.cwd, 'askpass')
  const oldSystem = process.env.GIT_CONFIG_SYSTEM, oldGlobal = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_SYSTEM = join(source.cwd, 'absent-system-config'); process.env.GIT_CONFIG_GLOBAL = join(source.cwd, 'absent-global-config')
  t.after(() => { if (oldSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = oldSystem
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGlobal })
  writeFileSync(askpass, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  git(source.cwd, 'config', 'credential.helper', `!touch '${marker}'`)
  git(source.cwd, 'config', 'core.askPass', askpass)
  // credential fill exercises the same config sandbox without any network access.
  await assert.rejects(hardenedNetworkGit(source.cwd, ['credential', 'fill'], { input: 'protocol=https\nhost=example.invalid\n\n' }))
  assert.equal(existsSync(marker), false)
})

test('fork pull requests with the same branch name do not block same-repository publication', async () => {
  const { leadPublicationPorts } = await import('../src/lead/pr-publication.js'), s = await prepare(), source = repository()
  const ports = leadPublicationPorts({ allowLocalFile: true, journal: s.journal, project: s.contract.project, seats: () => [], evidence: async () => { throw new Error('unused') },
    publications: async () => [{ kind: 'pullRequest', action: 'opened', repo: source.repository, number: 7 } as any], signature: () => undefined,
    forge: { async publicationAllowed() { return { ok: true } }, async seat() { return null }, async identity() { return {} as any }, async publish() {} },
    gh: async (_cwd, args) => ({ stderr: '', exitCode: 0, stdout: JSON.stringify(args[0] === 'pr' ? [
      { number: 8, url: 'https://github.com/acme/widgets/pull/8', headRefName: 'worker', headRefOid: source.head, isCrossRepository: true, headRepositoryOwner: { login: 'fork' } },
      { number: 7, url: 'https://github.com/acme/widgets/pull/7', headRefName: 'worker', headRefOid: source.head, isCrossRepository: false, headRepositoryOwner: { login: 'acme' } },
    ] : { number: 7, state: 'open', head: { sha: source.head, ref: source.branch, repo: { full_name: source.repository } }, base: { repo: { full_name: source.repository } } }) }),
  })
  assert.deepEqual(await ports.find(source, false), [{ repository: source.repository, number: 7, head: source.head, branch: source.branch }])
})

test('plan freezing pins the repository before a worker can change its remote', async () => {
  const { freezeLeadPlan } = await import('../src/lead/assembly.js'), s = await prepare(), source = repository()
  git(source.cwd, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  const frozen = await freezeLeadPlan({ ...s.contract, project: { ...s.contract.project, path: source.cwd } })
  assert.equal((frozen as any).publicationRepository, 'acme/widgets')
  git(source.cwd, 'remote', 'set-url', 'origin', 'https://github.com/acme/other.git')
  assert.equal((frozen as any).publicationRepository, 'acme/widgets')
})

test('a refused owned push can be superseded by a newer reviewed head before effects started', async () => {
  const { LeadPrFollow, pushToOwnedBranch } = await moduleOf(), s = await prepare(), source = repository()
  await pushToOwnedBranch(source, null)
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'First repair fixture')
  const first = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  let validations = 0
  await assert.rejects(owner.pushOwned(first, async () => { if (++validations === 2) throw new Error('fresh evidence unavailable') }))
  assert.equal(s.journal.state.ownedPush?.effectStarted, false)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Newer repair fixture')
  const newer = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  await owner.pushOwned(newer, async () => {})
  assert.equal(s.journal.state.pr?.head, newer.head)
  assert.ok(s.records.some(record => record.type === 'owned-push' && record.operation.stage === 'superseded'))
})

test('network git keeps only system and global credential helpers and ignores repository HTTP and protocols', async t => {
  const { hardenedNetworkGit } = await import('../src/git-hardening.js')
  const source = repository(), system = join(source.cwd, 'system-config'), global = join(source.cwd, 'global-config'), marker = join(source.cwd, 'worker-helper')
  writeFileSync(system, '[credential]\n\thelper = "!f() { echo username=fixture; }; f"\n')
  writeFileSync(global, '[credential]\n\thelper = "!f() { echo password=synthetic; }; f"\n')
  const oldSystem = process.env.GIT_CONFIG_SYSTEM, oldGlobal = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_SYSTEM = system; process.env.GIT_CONFIG_GLOBAL = global
  t.after(() => { if (oldSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = oldSystem
    if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGlobal })
  git(source.cwd, 'config', 'credential.helper', `!touch '${marker}'`)
  git(source.cwd, 'config', 'http.proxy', 'http://example.invalid:1')
  git(source.cwd, 'config', 'http.https://github.com/.extraheader', 'Fixture: denied')
  git(source.cwd, 'config', 'protocol.ext.allow', 'always')
  const filled = await hardenedNetworkGit(source.cwd, ['credential', 'fill'], { input: 'protocol=https\nhost=example.invalid\n\n' })
  assert.match(filled, /username=fixture/); assert.match(filled, /password=synthetic/)
  assert.equal(existsSync(marker), false)
  const config = await hardenedNetworkGit(source.cwd, ['config', '--list'])
  assert.doesNotMatch(config, /example.invalid:1|Fixture: denied|protocol.ext.allow=always/)
  await assert.rejects(hardenedNetworkGit(source.cwd, ['ls-remote', `ext::touch ${marker}`]), /transport.*ext.*not allowed/)
  assert.equal(existsSync(marker), false)
})

test('an owned branch at a new tip is adopted only by a push-started recovery', async () => {
  const { pushToOwnedBranch } = await moduleOf(), source = repository()
  await pushToOwnedBranch(source, null)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed next fixture')
  const repair = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  git(source.cwd, 'push', 'origin', 'HEAD:refs/heads/worker')
  await assert.rejects(pushToOwnedBranch(repair, source.head, false), /lead-push-owned-head-changed/)
  assert.deepEqual(await pushToOwnedBranch(repair, source.head, true), { pushed: false })
})
