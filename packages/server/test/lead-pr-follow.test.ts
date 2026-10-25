import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GitGateway } from '../src/git-gateway/index.js'
import { leadPublicationPorts as publicationPorts } from '../src/lead/pr-publication.js'
import { createLeadJournal, leadCheckpoint, parseLeadCheckpoint } from '@harnessdesk/lead'
import { parseLeadAcceptanceContract, parseLeadCard } from '@harnessdesk/protocol'

let lastSource: any
const gateways = new Map<string, GitGateway>()
const gatewayFor = (source: any, gh?: any): GitGateway => {
  if (!gh && gateways.has(source.cwd)) return gateways.get(source.cwd)!
  const gateway = new GitGateway({ directory: mkdtempSync(join(tmpdir(), 'hd-lead-gateway-')), localRemote: () => source.remoteUrl, ...(gh ? { gh } : {}) })
  if (!gh) gateways.set(source.cwd, gateway)
  return gateway
}
const leadPublicationPorts = (options: any) => publicationPorts({ ...options, gateway: gatewayFor(lastSource, options.gh) })
const moduleOf = async (): Promise<any> => {
  const value = await import('../src/lead/pr-follow.js')
  return { ...value,
    LeadPrFollow: class extends value.LeadPrFollow { constructor(options: any) { super({ ...options, gateway: options.gateway ?? gatewayFor(lastSource) }) } },
    pushToOwnedBranch: (source: any, owned: any, reconcile = false) => value.pushToOwnedBranch(source, owned, reconcile, async () => {}, gatewayFor(source), { kind: 'lead-goal', id: 'goal-1' }),
    pushOwnedLeadBranch: (options: any) => value.pushOwnedLeadBranch({ ...options, gateway: gatewayFor(options.source) }),
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
  return lastSource = { cwd, remote: 'origin', remoteUrl, defaultBranch: 'main', repository: 'acme/widgets', branch: 'worker', head: git(cwd, 'rev-parse', 'HEAD'),
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
  const decision = { version: 1, cardId: card.id, cardType: 'result', expectedRevision: 1, contractDigest: contract.digest, choice: 'accept-open-pr' } as const
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
  const { LeadPrFollow, pushToOwnedBranch } = await moduleOf(), s = await prepare(), source = repository()
  let pushes = 0, creates = 0, exists = false
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const ports = { now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => exists ? [pr] : [], push: async () => { await pushToOwnedBranch(source, null); pushes++ }, create: async () => { creates++; exists = true; s.failOn('publication'); return pr } }
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


test('host gateway creates a signed PR through fake gh outside the worker checkout', async () => {
  const { LeadPrFollow } = await moduleOf()
  const s = await prepare(), source = repository(), statePath = join(source.cwd, 'fake-forge.json')
  writeFileSync(statePath, JSON.stringify({ repo: source.repository, publicationHead: source.head, pulls: [], issues: [], user: { id: 7, login: 'demo' } }))
  const references: any[] = []
  const ports = leadPublicationPorts({ allowLocalFile: true, journal: s.journal, project: s.contract.project, seats: () => [],
    evidence: async () => { throw new Error('not used') }, publications: async () => [], signature: () => undefined,
    forge: { async publicationAllowed() { return { ok: true } }, async identity() { return { via: 'gh', login: 'demo', available: true, reason: null } },
      async seat() { return { agent: 'Fixture', version: '1', model: 'Demo', effort: null, thinking: false, label: 'Fixture Demo', role: 'implement', round: null, team: 'Fixture' } },
      async publish(reference: any) { references.push(reference) } },
    gh: async (cwd: string, args: readonly string[]) => ({ stdout: execFileSync(process.execPath, [new URL('./fixtures/fake-gh.mjs', import.meta.url).pathname, ...args],
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
  assert.deepEqual(s.journal.state.pr?.review, { ...fact.review, id: 11, state: 'approved' })
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
  assert.equal((await ports.source(s.card, contract)).repository, 'acme/widgets')
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

test('resume supersedes an effect-free prepared repair after its reviewed head changes', async () => {
  const { LeadPrFollow, pushToOwnedBranch } = await moduleOf(), s = await prepare(), source = repository()
  await pushToOwnedBranch(source, null)
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 101, validate: async () => {}, source: async () => source,
    find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'First reviewed repair')
  const first = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  let validations = 0
  await assert.rejects(owner.pushOwned(first, async () => {
    if (++validations === 2) throw new Error('lead-repair-review-changed')
  }), /lead-repair-review-changed/)
  assert.equal(s.journal.state.ownedPush?.stage, 'needs-you')
  assert.equal(s.journal.state.ownedPush?.effectStarted, false)
  await s.journal.resume()
  assert.equal(s.journal.state.ownedPush?.stage, 'prepared')
  git(source.cwd, 'commit', '--allow-empty', '-m', 'New reviewed repair')
  const second = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  await owner.pushOwned(second, async () => {})
  const seq = s.journal.state.seq
  await owner.pushOwned(second, async () => {}); await owner.pushOwned(second, async () => {})
  assert.equal(s.journal.state.seq, seq)
  assert.equal(s.journal.state.ownedPush?.stage, 'completed')
  assert.equal(s.journal.state.pr?.head, second.head)
  assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
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
    if (observed === 'open') assert.equal(s.journal.state.managementReason, 'lead-pr-branch-rewritten')
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



test('fork pull requests with the same branch name do not block same-repository publication', async () => {
  const s = await prepare(), source = repository()
  const ports = leadPublicationPorts({ allowLocalFile: true, journal: s.journal, project: s.contract.project, seats: () => [], evidence: async () => { throw new Error('unused') },
    publications: async () => [{ kind: 'pullRequest', action: 'opened', repo: source.repository, number: 7 } as any], signature: () => undefined,
    forge: { async publicationAllowed() { return { ok: true } }, async seat() { return null }, async identity() { return {} as any }, async publish() {} },
    gh: async (_cwd: string, args: readonly string[]) => ({ stderr: '', exitCode: 0, stdout: JSON.stringify(args[1] === 'list' ? [
      { number: 8, url: 'https://github.com/acme/widgets/pull/8', headRefName: 'worker', headRefOid: source.head, isCrossRepository: true, headRepositoryOwner: { login: 'fork' } },
      { number: 7, url: 'https://github.com/acme/widgets/pull/7', headRefName: 'worker', headRefOid: source.head, isCrossRepository: false, headRepositoryOwner: { login: 'acme' } },
    ] : { number: 7, state: 'OPEN', url: 'https://github.com/acme/widgets/pull/7', headRefOid: source.head, headRefName: source.branch, isCrossRepository: false, headRepositoryOwner: { login: 'acme' } }) }),
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



test('an owned branch at a new tip needs a successful host push before recovery can adopt it', async () => {
  const { pushToOwnedBranch } = await moduleOf(), source = repository()
  await pushToOwnedBranch(source, null)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed next fixture')
  const repair = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  await pushToOwnedBranch(repair, source.head)
  await assert.rejects(pushToOwnedBranch(repair, source.head, false), /lead-push-owned-head-changed/)
  assert.deepEqual(await pushToOwnedBranch(repair, source.head, true), { pushed: false })
})


test('foreign fast-forward releases branch, follows new checks and reviews, and merge ends goal', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source, find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Person fixup')
  const observed = git(source.cwd, 'rev-parse', 'HEAD'); git(source.cwd, 'push', 'origin', 'HEAD:refs/heads/worker')
  await owner.observe({ ...pr, head: observed, state: 'open', check: { head: observed, state: 'passed', total: 1 }, at: 101 })
  assert.equal(s.journal.state.pr?.branchOwner, 'person'); assert.equal(s.journal.state.phase, 'following')
  assert.equal(s.journal.state.pr?.check?.head, observed); assert.equal(owner.watches()[0]?.head, observed)
  await owner.observeFacts([{ action: 'review-commented', repository: source.repository, subject: '7', head: observed, review: { id: 1, head: observed, state: 'approved' }, at: 102 } as any])
  assert.equal(s.journal.state.pr?.review?.head, observed)
  await assert.rejects(owner.pushOwned({ ...source, head: observed }, async () => {}), /branch-released/)
  assert.deepEqual((await createLeadJournal(s.storage)).state.pr, s.journal.state.pr)
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(s.journal.state, 'b'.repeat(64))).state.pr, s.journal.state.pr)
  await owner.observe({ ...pr, head: observed, state: 'merged', check: null, at: 103 })
  assert.equal(s.journal.state.phase, 'accepted')
})
test('ledger head from this goal is adopted and other requesters are named on release', async () => {
  for (const own of [true, false]) {
    const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
    const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
    const gateway = gatewayFor(source)
    const owner = new LeadPrFollow({ gateway, journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source, find: async () => [pr], create: async () => pr })
    await owner.accept(s.card, s.decision, s.contract)
    git(source.cwd, 'commit', '--allow-empty', '-m', 'Attributed next head')
    const observed = git(source.cwd, 'rev-parse', 'HEAD')
    await gateway.push({ repository: source.repository, branch: source.branch, sha: observed, tree: git(source.cwd, 'rev-parse', 'HEAD^{tree}'),
      objectStore: join(source.cwd, '.git'), previousSha: null, requester: { kind: own ? 'lead-goal' : 'session', id: own ? 'goal-1' : 'session-2' } })
    await owner.observe({ ...pr, head: observed, state: 'open', check: null, at: 101 })
    assert.equal(s.journal.state.pr?.branchOwner, own ? 'lead' : 'person')
    assert.equal(s.journal.state.pr?.head, own ? observed : source.head)
    if (!own) assert.match(s.journal.state.pr?.releaseReason ?? '', /session.*session-2/)
  }
})
test('rewrite parks Needs-you and a head-bound reclaim resumes owned pushes', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source, find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  const rewritten = git(source.cwd, 'commit-tree', git(source.cwd, 'rev-parse', 'HEAD^{tree}'), '-m', 'Rewrite')
  git(source.cwd, 'update-ref', 'refs/heads/worker', rewritten); git(source.cwd, 'push', '--force', 'origin', 'HEAD:refs/heads/worker')
  await owner.observe({ ...pr, head: rewritten, state: 'open', check: null, at: 101 })
  assert.equal(s.journal.state.pr?.branchOwner, 'person'); assert.equal(s.journal.state.phase, 'waiting-for-user')
  assert.equal(s.journal.state.managementReason, 'lead-pr-branch-rewritten')
  const card = s.journal.state.cards.find(card => card.type === 'branch-ownership')!
  assert.ok(card)
  const decision = { version: 1, cardType: card.type, cardId: card.id, expectedRevision: card.revision, contractDigest: s.contract.digest, choice: 'reclaim-branch' }
  await owner.reclaim(card, decision)
  assert.equal(s.journal.state.pr?.branchOwner, 'lead'); assert.equal(s.journal.state.pr?.head, rewritten)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed repair after reclaim')
  const head = git(source.cwd, 'rev-parse', 'HEAD'); await owner.pushOwned({ ...source, head }, async () => {})
  assert.equal(git(source.remoteUrl, 'rev-parse', 'refs/heads/worker'), head)
})

test('reclaim rejects an old card after the remote moves even before the next observation', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source, find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Person extension')
  const first = git(source.cwd, 'rev-parse', 'HEAD'); git(source.cwd, 'push', 'origin', 'HEAD:refs/heads/worker')
  await owner.observe({ ...pr, head: first, state: 'open', check: null, at: 101 })
  const card = s.journal.state.cards.find(card => card.type === 'branch-ownership')!
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Another extension'); git(source.cwd, 'push', 'origin', 'HEAD:refs/heads/worker')
  await assert.rejects(owner.reclaim(card, { version: 1, cardType: card.type, cardId: card.id, expectedRevision: card.revision, contractDigest: s.contract.digest, choice: 'reclaim-branch' }), /stale/)
  assert.equal(s.journal.state.pr?.branchOwner, 'person')
})
test('a completed gateway push is adopted after the goal journal missed the head update', async () => {
  const { LeadPrFollow, pushToOwnedBranch } = await moduleOf(), s = await prepare(), source = repository()
  await pushToOwnedBranch(source, null)
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source, find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed next head')
  const next = git(source.cwd, 'rev-parse', 'HEAD'); await pushToOwnedBranch({ ...source, head: next }, source.head)
  await owner.observe({ ...pr, head: next, state: 'open', check: null, at: 101 })
  assert.equal(s.journal.state.pr?.branchOwner, 'lead'); assert.equal(s.journal.state.pr?.head, next)
  assert.equal(s.journal.state.phase, 'following')
})

test('ledger adoption completes a crash-interrupted owned operation before the next repair', async () => {
  const { LeadPrFollow, pushToOwnedBranch } = await moduleOf(), s = await prepare(), source = repository()
  await pushToOwnedBranch(source, null)
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source, find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed crash fixture')
  const repair = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  await s.journal.ownedPush({ source: repair, number: 7, previousHead: source.head, at: 100, stage: 'prepared', effectStarted: false })
  await s.journal.ownedPush({ ...s.journal.state.ownedPush!, stage: 'push-started', effectStarted: true })
  await pushToOwnedBranch(repair, source.head)
  await owner.observe({ ...pr, head: repair.head, state: 'open', check: null, at: 101 })
  assert.equal(s.journal.state.ownedPush?.stage, 'completed')
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed following repair')
  const next = git(source.cwd, 'rev-parse', 'HEAD'); await owner.pushOwned({ ...source, head: next }, async () => {})
  assert.equal(s.journal.state.pr?.head, next)
})

test('legacy transport metadata cannot block a reviewed repair to the pinned gateway repository', async () => {
  const { LeadPrFollow, pushToOwnedBranch } = await moduleOf(), s = await prepare(), source = repository()
  await pushToOwnedBranch(source, null)
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source, find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed transport migration')
  const head = git(source.cwd, 'rev-parse', 'HEAD')
  await owner.pushOwned({ ...source, head, remoteUrl: 'https://github.com/acme/widgets.git' }, async () => {})
  assert.equal(git(source.remoteUrl, 'rev-parse', 'refs/heads/worker'), head)
})

test('push-started recovery refuses a branch or PR pushed only by the worker', async () => {
  for (const hasPr of [false, true]) {
    const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
    await s.journal.publication({ id: 'publish-1', source, decision: s.decision as any, at: 100, stage: 'push-prepared', effectStarted: false })
    await s.journal.publication({ ...s.journal.state.publication!, stage: 'push-started', effectStarted: true })
    git(source.cwd, 'push', 'origin', 'HEAD:refs/heads/worker')
    const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
    const journal = await createLeadJournal(s.storage)
    const owner = new LeadPrFollow({ journal, now: () => 100, validate: async () => {}, source: async () => source,
      find: async () => hasPr ? [pr] : [], create: async () => pr })
    await assert.rejects(owner.reconcile(), /not-owned|push-unproven/)
    assert.equal(journal.state.pr, null)
    assert.equal(journal.state.phase, 'waiting-for-user')
    assert.equal(journal.state.publication?.stage, 'needs-you')
  }
})

test('owned push-started recovery refuses the same repair head pushed by the worker', async () => {
  const { LeadPrFollow, pushToOwnedBranch } = await moduleOf(), s = await prepare(), source = repository()
  await pushToOwnedBranch(source, null)
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source, find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  git(source.cwd, 'commit', '--allow-empty', '-m', 'Worker repair')
  const repair = { ...source, head: git(source.cwd, 'rev-parse', 'HEAD') }
  await s.journal.ownedPush({ source: repair, number: 7, previousHead: source.head, at: 100, stage: 'prepared', effectStarted: false })
  await s.journal.ownedPush({ ...s.journal.state.ownedPush!, stage: 'push-started', effectStarted: true })
  git(source.cwd, 'push', 'origin', 'HEAD:refs/heads/worker')
  await assert.rejects(owner.pushOwned(repair, async () => {}), /owned-head-changed/)
  assert.equal(s.journal.state.pr?.head, source.head)
  assert.equal(s.journal.state.ownedPush?.stage, 'needs-you')
})

test('push-card discovery requires a fresh host marker even when the worker published the PR', async () => {
  const s = await prepare(), source = repository()
  const card = { ...s.card, revision: 2, publication: 'push' }; await s.journal.offerCard(card)
  await s.journal.publication({ id: 'publish-1', source, decision: { ...s.decision, expectedRevision: 2 } as any, at: 100, stage: 'push-prepared' })
  let marker = '', listedMarker = ''
  const row = () => ({ number: 7, url: 'https://github.com/acme/widgets/pull/7', headRefName: source.branch, headRefOid: source.head,
    isCrossRepository: false, headRepositoryOwner: { login: 'acme' } })
  const ports = leadPublicationPorts({ journal: s.journal, project: s.contract.project, seats: () => [], evidence: async () => { throw new Error('unused') },
    publications: async () => [{ kind: 'pullRequest', action: 'opened', repo: source.repository, number: 7 }], signature: () => undefined,
    forge: { async publicationAllowed() { return { ok: true } }, async seat() { return null }, async identity() { return {} }, async publish() {} },
    gh: async (_cwd: string, args: readonly string[]) => ({ stderr: '', exitCode: 0, stdout: JSON.stringify(args[1] === 'list' ? [{ ...row(), body: listedMarker }] : { ...row(), state: 'OPEN', body: marker }) }) })
  await assert.rejects(ports.find(source, false), /unrelated-pr/)
  listedMarker = '<!-- harnessdesk:lead:goal-1:publish-1 -->'
  await assert.rejects(ports.find(source, true), /unrelated-pr/)
  marker = listedMarker
  assert.equal((await ports.find(source, true)).length, 1)
})

const ownedFixture = async () => {
  const { LeadPrFollow, pushToOwnedBranch } = await moduleOf(), s = await prepare(), source = repository()
  await pushToOwnedBranch(source, null)
  const pr = { repository: source.repository, number: 7, head: source.head, branch: source.branch }
  let time = 100
  const gateway = gatewayFor(source)
  const owner = new LeadPrFollow({ gateway, journal: s.journal, now: () => time, validate: async () => {}, source: async () => source,
    find: async () => [pr], create: async () => pr })
  await owner.accept(s.card, s.decision, s.contract)
  return { ...s, source, pr, owner, gateway, tick(at: number) { time = at } }
}

test('owned push records completion time and ignores a pre-completion observation', async () => {
  const s = await ownedFixture()
  git(s.source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed repair')
  const head = git(s.source.cwd, 'rev-parse', 'HEAD')
  let validations = 0
  await s.owner.pushOwned({ ...s.source, head }, async () => { if (++validations === 2) s.tick(200) })
  assert.equal(s.journal.state.pr?.at, 200)
  await s.owner.observe({ ...s.pr, state: 'open', check: null, at: 150 })
  assert.equal(s.journal.state.pr?.head, head)
  assert.equal(s.journal.state.pr?.observedHead, head)
  assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
})

test('ledger recovery keeps the completion time when the triggering poll is older', async () => {
  const s = await ownedFixture(), { pushToOwnedBranch } = await moduleOf()
  git(s.source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed crash repair')
  const repair = { ...s.source, head: git(s.source.cwd, 'rev-parse', 'HEAD') }
  await s.journal.ownedPush({ source: repair, number: 7, previousHead: s.source.head, at: 100, stage: 'prepared', effectStarted: false })
  await s.journal.ownedPush({ ...s.journal.state.ownedPush!, stage: 'push-started', effectStarted: true })
  await pushToOwnedBranch(repair, s.source.head)
  s.tick(300)
  await s.owner.observe({ ...s.pr, head: repair.head, state: 'open', check: null, at: 101 })
  assert.equal(s.journal.state.ownedPush?.stage, 'completed')
  assert.equal(s.journal.state.pr?.at, 300)
  assert.equal(s.journal.state.pr?.head, repair.head)
  assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
})

test('a late attributed ancestor observation is ignored while a real rewind releases authority', async () => {
  const s = await ownedFixture()
  git(s.source.cwd, 'commit', '--allow-empty', '-m', 'Reviewed successor')
  const head = git(s.source.cwd, 'rev-parse', 'HEAD')
  await s.owner.pushOwned({ ...s.source, head }, async () => {})
  const before = s.journal.state
  await s.owner.observe({ ...s.pr, state: 'open', check: null, at: 201 })
  assert.deepEqual(s.journal.state, before, 'a completed old poll cannot move the owned head back')
  git(s.source.cwd, 'push', '--force', 'origin', `${s.source.head}:refs/heads/worker`)
  await s.owner.observe({ ...s.pr, state: 'open', check: null, at: 202 })
  assert.equal(s.journal.state.pr?.head, head)
  assert.equal(s.journal.state.pr?.observedHead, s.source.head)
  assert.equal(s.journal.state.pr?.branchOwner, 'person')
  assert.equal(s.journal.state.pr?.branchChange, 'rewrite')
  assert.equal(s.journal.state.phase, 'waiting-for-user')
})

test('declining branch ownership resumes following without reclaiming the branch', async () => {
  const s = await ownedFixture()
  const rewrite = git(s.source.cwd, 'commit-tree', git(s.source.cwd, 'rev-parse', 'HEAD^{tree}'), '-m', 'Person rewrite')
  git(s.source.cwd, 'push', '--force', 'origin', `${rewrite}:refs/heads/worker`)
  await s.owner.observe({ ...s.pr, head: rewrite, state: 'open', check: null, at: 101 })
  const card = s.journal.state.cards.find(card => card.type === 'branch-ownership')!
  await s.journal.decideCard({ version: 1, cardType: card.type, cardId: card.id, expectedRevision: card.revision, contractDigest: s.contract.digest, choice: 'decline' }, null)
  assert.equal(s.journal.state.phase, 'following')
  assert.equal(s.journal.state.managementReason, null)
  assert.equal(s.journal.state.pr?.branchOwner, 'person')
  await s.owner.observe({ ...s.pr, head: rewrite, state: 'open', check: null, at: 102 })
  assert.equal(s.journal.state.phase, 'following', 'the same poll must not undo the decline')
  assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
})

test('a force push after release compares ancestry to the last observed head', async () => {
  const s = await ownedFixture()
  git(s.source.cwd, 'commit', '--allow-empty', '-m', 'Person extension')
  const extension = git(s.source.cwd, 'rev-parse', 'HEAD'); git(s.source.cwd, 'push', 'origin', 'HEAD:refs/heads/worker')
  await s.owner.observe({ ...s.pr, head: extension, state: 'open', check: null, at: 101 })
  assert.equal(s.journal.state.phase, 'following')
  git(s.source.cwd, 'push', '--force', 'origin', `${s.source.head}:refs/heads/worker`)
  await s.owner.observe({ ...s.pr, state: 'open', check: null, at: 102 })
  assert.equal(s.journal.state.pr?.branchChange, 'rewrite')
  assert.equal(s.journal.state.phase, 'waiting-for-user')
})

test('reclaim reads the remote outside the journal queue and rechecks state after the read', async () => {
  for (const changes of [false, true]) {
    const s = await ownedFixture()
    git(s.source.cwd, 'commit', '--allow-empty', '-m', 'Person extension')
    const head = git(s.source.cwd, 'rev-parse', 'HEAD'); git(s.source.cwd, 'push', 'origin', 'HEAD:refs/heads/worker')
    await s.owner.observe({ ...s.pr, head, state: 'open', check: null, at: 101 })
    const card = s.journal.state.cards.find(card => card.type === 'branch-ownership')!
    const remoteHead = s.gateway.remoteHead.bind(s.gateway)
    s.gateway.remoteHead = async (...args) => {
      // A remote read may wait on another host action that needs the writer.
      // Taking this read under decideCard deadlocks that action.
      await Promise.race([changes ? s.journal.stop() : s.journal.settingsChanged(undefined, { checks: false, reviews: true }),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('remote read held the journal queue')), 250); timer.unref() })])
      return remoteHead(...args)
    }
    const action = s.owner.reclaim(card, { version: 1, cardType: card.type, cardId: card.id, expectedRevision: card.revision, contractDigest: s.contract.digest, choice: 'reclaim-branch' })
    if (changes) { await assert.rejects(action, /stale|lead-journal-transition/); assert.equal(s.journal.state.pr?.branchOwner, 'person') }
    else { await action; assert.equal(s.journal.state.pr?.branchOwner, 'lead') }
  }
})

test('a new click first reconciles the pending push-prepared decision', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  const card = { ...s.card, revision: 2, publication: 'push' }; await s.journal.offerCard(card)
  const oldDecision = { ...s.decision, expectedRevision: 2 }
  await s.journal.publication({ id: 'publish-1', source, decision: oldDecision as any, at: 100, stage: 'push-prepared', effectStarted: false })
  let pushes = 0
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [], push: async () => { pushes++ }, create: async () => ({ repository: source.repository, number: 7, head: source.head, branch: source.branch }) })
  await assert.rejects(owner.accept(card, { ...oldDecision, choice: 'accept' }, s.contract), /stale/)
  assert.equal(pushes, 1)
  assert.equal(s.journal.state.publication?.stage, 'completed')
  assert.deepEqual(s.journal.state.publication?.decision, oldDecision)
  assert.equal(s.journal.state.phase, 'following')
})

test('a new reviewed card can supersede a push-prepared decision whose card is stale', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  await s.journal.publication({ id: 'publish-1', source, decision: s.decision as any, at: 100, stage: 'push-prepared', effectStarted: false })
  const card = { ...s.card, revision: 2 }; await s.journal.offerCard(card)
  let pushes = 0
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [], push: async () => { pushes++ }, create: async () => ({ repository: source.repository, number: 7, head: source.head, branch: source.branch }) })
  await owner.accept(card, { ...s.decision, expectedRevision: 2 }, s.contract)
  assert.equal(pushes, 1)
  assert.equal(s.journal.state.publication?.stage, 'completed')
  assert.ok(s.records.some(record => record.operation?.id === 'publish-1' && record.operation.stage === 'superseded'))
  assert.deepEqual((await createLeadJournal(s.storage)).state, s.journal.state)
})

test('a delayed result refresh cannot replace following with an acceptance wait or invalidate a publication in flight', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, source: async () => source,
    find: async () => [], push: async () => {
      await s.journal.invalidateResults()
      await assert.rejects(s.journal.offerCard({ ...s.card, revision: 2 }), /lead-card-stale/)
      assert.ok(s.journal.state.cards.some(card => card.id === s.card.id), 'the journal fences stale child invalidation after publication preparation')
    }, create: async () => ({ repository: source.repository, number: 7, head: source.head, branch: source.branch }) })
  await owner.accept(s.card, s.decision, s.contract)
  await s.journal.setManagementPhase('waiting-for-user', 'lead-result-awaiting-person')
  assert.equal(s.journal.state.phase, 'following')
})

test('publication preflight leaves person gates unanswered until the durable publication completes', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  let answers = 0
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100,
    validate: async () => { assert.equal(answers, 0) },
    answer: async () => { assert.equal(s.journal.state.publication?.stage, 'completed'); answers++ },
    source: async () => source, find: async () => [],
    push: async () => { assert.equal(answers, 0) }, create: async () => { assert.equal(answers, 0); return { repository: source.repository, number: 7, head: source.head, branch: source.branch } } })
  await owner.accept(s.card, s.decision, s.contract)
  assert.equal(answers, 1); assert.equal(s.journal.state.phase, 'following')
})

test('a completed publication keeps its exact pending result until the final decision is journaled', async () => {
  const s = await prepare(), source = repository()
  const operation = { id: 'pending-completion', source, decision: s.decision, at: 100, stage: 'push-prepared' as const, effectStarted: false }
  await s.journal.publication(operation)
  await s.journal.publication({ ...operation, stage: 'pushed' })
  await s.journal.publication({ ...operation, stage: 'completed' }, { repository: source.repository, number: 7, branch: source.branch, head: source.head, branchOwner: 'lead', state: 'open', at: 100, check: null })
  await s.journal.invalidateResults()
  await assert.rejects(s.journal.offerCard({ ...s.card, revision: 2 }), /lead-card-stale/)
  assert.equal(s.journal.state.decidedCards.includes(`${s.card.id}:${s.card.revision}`), false)
  await s.journal.decideCard(s.decision, null)
  assert.equal(s.journal.state.phase, 'following')
  await s.journal.restoreResult(s.card.id, s.card.revision)
  await assert.rejects(s.journal.offerCard({ ...s.card, revision: 2 }), /lead-card-stale/)
  assert.ok(s.journal.state.decidedCards.includes(`${s.card.id}:${s.card.revision}`))
})

test('a final person-gate refusal after publication preserves the PR and releases the result for a fresh decision', async () => {
  const { LeadPrFollow } = await moduleOf(), s = await prepare(), source = repository()
  const owner = new LeadPrFollow({ journal: s.journal, now: () => 100, validate: async () => {}, answer: async () => { throw new Error('gate changed after publication') },
    source: async () => source, find: async () => [], push: async () => {}, create: async () => ({ repository: source.repository, number: 7, head: source.head, branch: source.branch }) })
  await assert.rejects(owner.accept(s.card, s.decision, s.contract), /gate changed/)
  assert.equal(s.journal.state.publication?.stage, 'completed')
  assert.equal(s.journal.state.pr?.number, 7)
  assert.equal(s.journal.state.managementReason, 'lead-publication-needs-you')
  assert.ok(s.journal.state.decidedCards.includes(`${s.card.id}:${s.card.revision}`))
  await s.journal.offerCard({ ...s.card, revision: s.card.revision + 1 })
  assert.ok(!s.journal.state.decidedCards.includes(`${s.card.id}:${s.card.revision + 1}`))
})
