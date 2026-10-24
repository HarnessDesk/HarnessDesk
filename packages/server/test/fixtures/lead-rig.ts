import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { connect as connectSocket, createServer as createSocketServer, type Server as SocketServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { Ledger } from '../../src/ledger/index.js'
import type { UsageSample } from '../../src/ledger/insight.js'
import type { LeadSupervisorOptions } from '@harnessdesk/lead/supervisor'
import { createLeadJournal, leadBudgetProjection, leadReviewedResultSource, type LeadAcceptanceEvidence, type LeadJournal, type LeadPermissionCall } from '@harnessdesk/lead'
import { LeadSupervisor } from '@harnessdesk/lead/supervisor'
import { parseLeadAcceptanceContract, type LeadCard, type LeadCardDecision, type RuntimeId } from '@harnessdesk/protocol'
import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { ExtensionKernel, setTeamEngine } from '@harnessdesk/cordis-host'
import { teamPlugin } from '@harnessdesk/plugins'
import { Host, Logger, StateStore } from '../../src/index.js'
import { LeadFileJournal } from '../../src/lead/journal.js'
import { freezeLeadPlan, leadProjectOf } from '../../src/lead/assembly.js'
import { GatedRegistry } from '../../src/ceilings/gate.js'
import { GoalStore } from '../../src/goals/store.js'
import { LEAD_RIG_KEY, leadMessagesServer } from './lead-messages-server.js'
import type { LeadService } from '../../src/lead/service.js'
import { GitGateway } from '../../src/git-gateway/index.js'
import { LeadAssembly } from '../../src/lead/assembly.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const model = 'fixture-model'
const prices = { [model]: { inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000,
  cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 } }
const task = 'Repair the retry check'
const text = (value: string) => ({ type: 'text', text: value })
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Only the synthetic binary's identity/provider differ; all adapter operations stay real. */
class RigRuntime extends CodexRuntime {
  constructor(options: ConstructorParameters<typeof CodexRuntime>[0], private readonly provider: string) { super(options) }
  override get info() { return { ...super.info, provider: this.provider } }
  override async providerAt() { return this.provider }
}
export interface LeadRigOptions {
  readonly enabled?: boolean
  /** Offline host-publication fixture: one run, pinned demo repository and distinct repair commits. */
  readonly publication?: boolean
  /** Full offline forge walks: only explicit person creation and reviewed owned pushes. */
  readonly offlineForge?: boolean
  readonly waitMs?: number
  readonly reviewAvailable?: () => boolean
  readonly forgeGh?: (args: readonly string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  readonly scenario?: 'happy' | 'interrupted' | 'worker-approval' | 'forbidden'
  readonly manualChecks?: boolean
  readonly holdWorkers?: boolean
  readonly holdPlanning?: boolean
  readonly holdRunning?: boolean
  readonly declinedPredecessor?: boolean
  readonly acceptedPredecessor?: boolean
  readonly premature?: boolean
  readonly eager?: boolean
  readonly workerSpend?: boolean
  /** How long a worker spend reading stays fresh; a short one lets a test outwait it. */
  readonly freshnessMs?: number
  /** The sentence the scripted plan reply opens with; a walk can add a line for the person to keep. */
  readonly planText?: string
}
/** Synthetic services around the actual host, fd-3 child, client door and Flow.
 * Each instance owns its temp home and restores its environment before removal.
 * This is intentionally serial: the host's extension plane and environment are process-owned. */
export async function createLeadRig(options: LeadRigOptions = {}) {
  const scratch = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'hd-lrig-')))
  const home = join(scratch, 'home'), project = { id: 'synthetic-project', path: join(scratch, 'project') }
  if (options.offlineForge) Object.assign(project, leadProjectOf(project.path))
  const previousHome = process.env['HARNESSDESK_HOME'], previousPath = process.env['PATH']
  process.env['HARNESSDESK_HOME'] = home
  const logger = new Logger('lead-rig', { level: 'error', console: false })
  const children: ChildProcessWithoutNullStreams[] = []
  const bridgeServers: SocketServer[] = [], bridgeSockets = new Set<Socket>()
  const windowNotifications: any[] = []
  const calls: { method: string; params: unknown }[] = [], forbidden: string[] = []
  const workerLog = join(home, 'worker-calls.ndjson'), gitLog = join(home, 'git-calls')
  const gates = join(home, 'worker-gates'), passes = join(home, 'worker-passes.json')
  let extensions: ExtensionKernel | undefined
  let journal!: LeadJournal, storage: LeadFileJournal | undefined, service!: LeadService, host!: Host
  let disposed = false, workerMicros = 0, failGate = false, failedGate = false
  const checkStarts = new Set<string>()
  let evidenceFailure: Error | undefined
  let latestEvidence: LeadAcceptanceEvidence | null = null
  let currentStep = '', preview: { token: string; source: string; expiresAt: number } | undefined
  let deskSocketPath = ''
  let supervisorOptions!: LeadSupervisorOptions
  const eagerResults: { tool_use_id: string; is_error: boolean }[] = []
  let eagerStart = false, eagerApproval = false, prematureStart = false
  let provider: Awaited<ReturnType<typeof leadMessagesServer>>
  let restoreGoalSave: (() => void) | undefined
  let restoreUsage: (() => void) | undefined
  let workerSample: UsageSample | undefined
  const restoreFakes: (() => void)[] = []
  let forgeClock = Date.now(), personPublication = false, hostStarts = 0
  const forgeState = join(home, 'fake-forge.json'), remote = join(scratch, 'remote.git')
  const forgeCalls: string[][] = []
  const allowedPushes: { sha: string; previousSha: string | null }[] = []
  const readForge = async (): Promise<any> => JSON.parse(await readFile(forgeState, 'utf8'))
  const writeForge = (value: unknown) => writeFile(forgeState, JSON.stringify(value))
  const fakeGh = async (args: readonly string[]) => {
    forgeCalls.push([...args])
    const mutation = args.some(arg => ['create', 'merge', 'delete', 'edit', 'comment', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(arg))
    if (mutation && !(args[0] === 'pr' && args[1] === 'create' && personPublication)) {
      forbidden.push(`forge:${args.join(' ')}`); throw new Error('unexpected rig forge write')
    }
    if (args[0] === 'api' && args[1] === 'user' && args.includes('--jq')) return { stdout: 'jane-doe', stderr: '', exitCode: 0 }
    const state = await readForge()
    if (args[0] === 'pr' && args[1] === 'create') {
      const branch = args[args.indexOf('--head') + 1]!
      state.publicationHead = git(remote, 'rev-parse', `refs/heads/${branch}`)
      await writeForge(state)
    }
    try { return { stdout: execFileSync(process.execPath, [join(root, 'packages/server/test/fixtures/fake-gh.mjs'), ...args],
      { cwd: scratch, encoding: 'utf8', env: { ...process.env, FAKE_GH_STATE: forgeState }, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', exitCode: 0 } }
    catch (error) { const failure = error as { stdout?: string; stderr?: string; status?: number }; return { stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? ''), exitCode: failure.status ?? 1 } }
  }
  const enabled = options.enabled !== false
  const gitBinary = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
  const git = (cwd: string, ...args: string[]) => execFileSync(gitBinary, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const waitFor = async (predicate: () => boolean | Promise<boolean>, label = 'rig state') => {
    const until = Date.now() + (options.waitMs ?? 240_000)
    while (!await predicate()) {
      if (evidenceFailure && /spawnSync ps.*EPERM/.test(evidenceFailure.message)) throw evidenceFailure
      if (Date.now() >= until) throw new Error(`Timed out waiting for ${label}; phase=${journal?.state.phase}; reason=${journal?.state.managementReason}; evidence=${evidenceFailure?.message ?? 'none'}; pr=${JSON.stringify(journal?.state.pr)}; handbacks=${JSON.stringify(journal?.state.handbacks.map(op => ({ stage: op.stage, head: op.head, publishedHead: op.publishedHead })))}; rounds=${JSON.stringify(host?.flowsPlane.leadRuns().map(run => ({ state: run.state, reason: run.reason, rounds: run.rounds.map(round => ({ n: round.n, role: round.role, state: round.state, cards: round.cards.map(id => { const card = host.teamPlane.stateFor(run.goal).intents.find(card => card.id === id); return { id, state: card?.state, title: card?.title } }) })) })))}`)
      await sleep(25)
    }
  }
  const workerCalls = async (): Promise<{ method: string; [key: string]: unknown }[]> => {
    const raw = await readFile(workerLog, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  const pending = <T extends LeadCard['type']>(type: T): Extract<LeadCard, { type: T }> | undefined =>
    journal.state.cards.find((card): card is Extract<LeadCard, { type: T }> => card.type === type && !journal.state.decidedCards.includes(`${card.id}:${card.revision}`))
  const personGates = () => journal.state.runs.flatMap(run => host.teamPlane.stateFor(run.teamId).intents.filter(card => card.role === 'accept'))
  const worktrees = () => [...new Set(host.flowsPlane.leadRuns().flatMap(run => Object.values(run.seatPlans ?? {}).flatMap(plan => plan.handed.map(checkout => checkout.cwd))))]
  const releaseWorkers = async () => { for (const marker of ['write', 'repair', 'review', 'followRepair']) await writeFile(join(gates, marker), '') }
  const restoreEnvironment = () => {
    if (previousHome === undefined) delete process.env['HARNESSDESK_HOME']; else process.env['HARNESSDESK_HOME'] = previousHome
    if (previousPath === undefined) delete process.env['PATH']; else process.env['PATH'] = previousPath
  }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    for (const id of ['rig-writer', 'rig-reviewer']) await chmod(join(home, id, 'sessions'), 0o700).catch(() => {})
    restoreGoalSave?.(); restoreUsage?.()
    try { await host?.dispose(); await extensions?.dispose(); setTeamEngine(null); await storage?.close(); await provider?.close(); for (const socket of bridgeSockets) socket.destroy(); await Promise.all(bridgeServers.map(server => new Promise<void>(resolve => server.close(() => resolve())))) }
    finally { restoreFakes.reverse().forEach(restore => restore()); restoreEnvironment(); await rm(scratch, { recursive: true, force: true, maxRetries: 5 }) }
  }
  try {
    await mkdir(home, { recursive: true }); await mkdir(project.path); await mkdir(gates)
    // A fresh local catalogue and explicit rates keep even usage reads offline.
    await mkdir(join(home, 'cache'))
    await writeFile(join(home, 'cache/model-pricing.json'), JSON.stringify({ fetchedAt: Date.now(), catalogue: {} }))
    await writeFile(join(home, 'pricing.json'), JSON.stringify({ 'fixture-worker': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }))
    await mkdir(join(project.path, '.harnessdesk'))
    // fast-import supplies placeholder authors without changing Git config or identity environment.
    git(project.path, 'init', '-b', 'main')
    const checks = `verify: { run: 'node -e "process.exit(0)"', timeout: 10 }\n`
    const seed = Buffer.from(checks)
    execFileSync(gitBinary, ['fast-import', '--quiet'], { cwd: project.path, input: Buffer.concat([
      Buffer.from(`commit refs/heads/main\nauthor Jane Doe <dev@example.com> 1700000000 +0000\ncommitter Jane Doe <dev@example.com> 1700000000 +0000\ndata 16\nSynthetic source\nM 100644 inline .harnessdesk/checks.yml\ndata ${seed.length}\n`), seed, Buffer.from('\n\n')]), stdio: ['pipe', 'pipe', 'pipe'] })
    git(project.path, 'checkout', 'main')
    if (options.publication) git(project.path, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    await writeFile(passes, JSON.stringify({ passes: {}, done: [] }))
    const bin = join(home, 'bin'); await mkdir(bin)
    // Observe Git effects routed through PATH, including host-internal calls.
    // This audit cannot see absolute-path git or direct fs.rm; decline also
    // verifies every retained lane and its file contents after the decision.
    const wrapper = join(bin, 'git')
    await mkdir(gitLog)
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    // mktemp owns a unique file even after PID reuse and under concurrent reads.
    await writeFile(wrapper, `#!/bin/sh\nlog=$(mktemp ${quote(gitLog)}/call.XXXXXXXX) || exit 1\nprintf '%s\\0' "$@" > "$log"\nexec ${quote(gitBinary)} "$@"\n`)
    await chmod(wrapper, 0o755); process.env['PATH'] = `${bin}:${previousPath ?? ''}`
    if (options.offlineForge) {
      assert.ok(options.publication, 'offline forge requires a publication plan')
      git(scratch, 'init', '--bare', remote)
      await writeForge({ repo: 'acme/widgets', view: { nameWithOwner: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranchRef: { name: 'main' } }, user: { id: 7, login: 'jane-doe' }, pulls: [], issues: [] })
      // Capture the audit wrapper in the gateway's fixed environment too.
      const gateway = new GitGateway({ directory: join(home, 'offline-gateway'), localRemote: repository => { assert.equal(repository, 'acme/widgets'); return remote }, gh: (_cwd, args) => fakeGh(args) })
      // Only transport destinations differ. The gateway's object transfer,
      // reviewed commit guards, private mirror and durable ledger stay real.
      for (const name of ['inspectCheckout', 'push', 'repository', 'remoteHead', 'attribute', 'isAncestor', 'hasSucceededPush', 'findPullRequest', 'createPullRequest'] as const) {
        const original = GitGateway.prototype[name] as (...args: any[]) => any
        ;(GitGateway.prototype as any)[name] = async (...args: any[]) => {
          if (name === 'push') {
            const input = args[0]
            assert.equal(input.requester.kind, 'lead-goal')
            assert.equal(input.requester.id, journal.state.budget!.logicalGoalId)
            assert.equal(input.sha, latestEvidence?.revision, 'only the currently reviewed commit may be pushed')
            if (input.previousSha === null) assert.ok(personPublication, 'initial push requires the person decision')
            else {
              assert.equal(journal.state.pr?.branchOwner, 'lead')
              assert.ok(journal.state.handbacks.some(op => op.stage === 'running' && op.head === input.previousSha), 'an active same-Team repair authorizes the owned update')
            }
            const result = await original.apply(gateway, args)
            allowedPushes.push({ sha: input.sha, previousSha: input.previousSha }); return result
          }
          return original.apply(gateway, args)
        }
        restoreFakes.push(() => { (GitGateway.prototype as any)[name] = original })
      }
      // This rig already assembled a journal, a fake provider and fake Seats.
      // The production lazy assembler must not create a second Lead owner.
      const ensure = LeadAssembly.prototype.ensure
      LeadAssembly.prototype.ensure = async () => {}
      restoreFakes.push(() => { LeadAssembly.prototype.ensure = ensure })
    }
    const assignments = [
      { role: 'implement', agent: 'implementer', seat: { runtime: 'rig-writer', model: 'gpt-5.5' }, ceiling: 'edit' },
      { role: 'review', agent: 'code-reviewer', seat: { runtime: 'rig-reviewer', model: 'gpt-5.5' }, ceiling: 'read' },
    ]
    const proposal = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: task, project, policyRevision: 1, ...(options.publication ? { publicationRepository: 'acme/widgets' } : {}),
      steps: (options.manualChecks || options.publication ? ['first'] : ['first', 'second']).map(id => ({ id, title: `Review ${id} repair`, flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended', assignments })),
      assertions: [{ id: 'unit', kind: 'check', description: 'Required check passes' }, { id: 'review', kind: 'review', description: 'Independent review approves' },
        { id: 'blockers', kind: 'blocking-findings', description: 'No unresolved blockers' }], caps: { usdMicros: 10_000_000, rounds: 20 } })
    const seats = Object.fromEntries(assignments.map(one => [one.role, [one.seat]]))
    let toolId = 0, forbiddenAttempt = 0
    const reply = (body: Record<string, any>): unknown[] => {
      const state = journal.state
      if (!state.contract || !state.consent) {
        const plan = text(JSON.stringify({ version: 1, type: 'lead-output', text: options.planText ?? 'Review the two-part repair before work starts.', plan: proposal }))
        if (options.eager && !eagerStart) {
          eagerStart = true
          return [plan, { type: 'tool_use', id: 'eager-start', name: 'flow_start_goal', input: {
            root: project.path, source: leadReviewedResultSource, token: 'unapproved-token', sentence: task, seats, vars: {}, attended: true } }]
        }
        return [plan]
      }
      if (options.eager && options.scenario === 'worker-approval' && !eagerApproval &&
        windowNotifications.some((one: any) => one.method === 'lead/changed' && one.params.thread?.cards.some((card: any) => card.kind === 'worker-approval'))) {
        eagerApproval = true
        return [{ type: 'tool_use', id: 'eager-approval', name: 'approval_respond', input: { decision: 'accept' } }]
      }
      if (options.scenario === 'forbidden') {
        const name = ['flow_preview', 'forge_publish', 'git_merge', 'project_delete', 'git_push'][forbiddenAttempt++ % 5]!
        return [{ type: 'tool_use', id: `forbidden-${++toolId}`, name, input: name === 'flow_preview'
          ? { root: project.path, source: leadReviewedResultSource.replace('grant: edit', 'grant: merge'), seats, vars: {}, attended: true } : {} }]
      }
      const step = state.steps.find(one => one.state === 'pending')
      const reviewing = options.premature && !prematureStart && step?.id === 'second' &&
        host.flowsPlane.leadRuns().some(run => run.rounds.at(-1)?.role === 'review')
      const priorReady = state.runs.every(run => {
        if (options.acceptedPredecessor && !host.flowsPlane.leadRuns().some(flow => flow.id === run.runId && flow.state === 'settled')) return false
        return host.teamPlane.stateFor(run.teamId).intents.some(intent => intent.role === 'accept' &&
          (options.declinedPredecessor || options.acceptedPredecessor
            ? intent.state === 'done' && intent.outcome === (options.acceptedPredecessor ? 'accepted' : 'declined')
            : intent.state === 'open'))
      })
      if (step && (priorReady || reviewing) && !state.budget?.stop) {
        currentStep = step.id
        const latest = body.messages?.at(-1)?.content ?? []
        const result = latest.find((one: any) => one.type === 'tool_result' && !one.is_error)
        let value: any
        try { value = result && JSON.parse(result.content) } catch { /* The next request obtains another real preview. */ }
        if (value?.token) {
          preview = { token: value.token, source: leadReviewedResultSource, expiresAt: value.expiresAt ?? Date.now() + 60_000 }
          if (reviewing) prematureStart = true
          return [{ type: 'tool_use', id: `tool-${++toolId}`, name: 'flow_start_goal', input: { root: project.path, source: leadReviewedResultSource, token: value.token, sentence: task, seats, vars: {}, attended: true } }]
        }
        return [{ type: 'tool_use', id: `tool-${++toolId}`, name: 'flow_preview', input: { root: project.path, source: leadReviewedResultSource, seats, vars: {}, attended: true } }]
      }
      return [text('Waiting for fresh worker checks and review.')]
    }
    provider = enabled ? await leadMessagesServer(reply, () => options.holdRunning === true ? journal?.state.runs.length > 0 : options.holdPlanning === true || options.scenario === 'interrupted') : {
      requests: [], pending: false, transport: { async send() { throw new Error('disabled provider') } }, release() {}, interrupt() {}, async close() {},
    }
    const setupHost = async () => {
      const restoring = hostStarts++ > 0
      extensions = new ExtensionKernel()
      host = new Host({ extensions, logger, state: new StateStore(join(home, 'state.json')), leadEnabled: enabled,
        catalogRefreshMs: 0, libraryHome: join(home, 'person'),
        ...(options.offlineForge ? { intake: { gh: async (...args: Parameters<NonNullable<NonNullable<import('../../src/host.js').HostOptions['intake']>['gh']>>) => ({ ...await fakeGh(args[0]), timedOut: false, overflow: false }), now: () => forgeClock, monotonic: () => forgeClock, timers: { every() { return 0 }, clear() {} }, usage: async () => ({ samples: [], complete: true }) } } : {}),
        evidence: { gh: options.offlineForge ? fakeGh : options.forgeGh ?? (async args => { if (args.some(arg => ['create', 'merge', 'delete', 'edit', 'comment', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(arg))) forbidden.push(`forge:${args.join(' ')}`); return { stdout: '', stderr: 'No forge in Lead rig', exitCode: 1 } }) },
        forge: { gh: options.offlineForge ? fakeGh : options.forgeGh ?? (async args => { if (args.some(arg => ['create', 'merge', 'delete', 'edit', 'comment', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(arg))) forbidden.push(`forge:${args.join(' ')}`); return { stdout: '', stderr: 'No forge in Lead rig', exitCode: 1 } }) },
        trashPath: async path => { forbidden.push(`delete:${path}`); throw new Error('No deletion in Lead rig') },
      })
      // Fake only the key broker boundary. It never reaches safeStorage or a real key store.
      Object.assign(host.credentials, { async leadStatus() { return { configured: true, protection: 'synthetic cipher' } },
        async resolveLead() { return LEAD_RIG_KEY }, async storeLead() {}, async deleteLead() {} })
      const realCall = host.call.bind(host)
      host.call = ((method: string, params: unknown) => {
        calls.push({ method, params })
        if (/^(?:forge\/(?:create|publish|merge)|git\/(?:push|merge)|.*\/(?:delete|publish))$/.test(method)) forbidden.push(method)
        return realCall(method as never, params as never)
      }) as typeof host.call
      host.addBroadcaster(notification => {
        windowNotifications.push(notification)
        if (options.workerSpend && workerMicros === 0 && notification.method === 'event' &&
          notification.params.runtime === 'rig-writer' && notification.params.event.type === 'turn/started') {
          const at = Date.now(), exact = (value: number) => ({ value, quality: 'exact' as const })
          // One explicit synthetic usage source at the normalized ledger boundary.
          // Attribution, meter folding and host dispatch gates remain real.
          workerSample = { key: 'synthetic-worker-bill', source: { id: 'synthetic-worker', kind: 'corpus', label: 'Synthetic usage',
            observedAt: at, checkedAt: at, stale: false, problem: null }, runtime: 'rig-writer', sessionId: notification.params.event.sessionId,
            turnId: null, requestId: 'synthetic-worker-bill', project: project.path, model: 'fixture-worker', from: at, to: at,
            scope: 'call', includesChildren: false, input: exact(1000), output: exact(0), cacheRead: exact(0), cacheWrite: exact(0),
            usd: exact(0.001), moneyBasis: 'vendorMetered' }
          workerMicros = 1000
        }
      })
      setTeamEngine(host.teamPlane); await extensions!.load(teamPlugin)
      if (!restoring) await host.start()
      for (const [id, providerName] of [['rig-writer', 'synthetic-writer'], ['rig-reviewer', 'synthetic-reviewer']] as const) {
        const codexHome = join(home, id); await mkdir(codexHome, { recursive: true })
        const runtime = new RigRuntime({ id: id as RuntimeId, name: id === 'rig-writer' ? 'Scripted writer' : 'Scripted reviewer', codexHome,
          binaryPath: join(root, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'),
          capabilities: new GatedRegistry(extensions!, () => host.ceilingGate),
          env: { FAKE_CODEX_PROCESS_CALLS: workerLog, FAKE_CODEX_FLOW: JSON.stringify({ state: passes, gates, approvalLog: workerLog, passPerRun: true, approvalBeforeWork: options.scenario === 'worker-approval', steps: {
            write: { kind: 'write', title: 'Implement the approved goal', outcomes: ['committed'], file: 'retry.txt', contents: 'Incomplete retry status list\n' },
            repair: { kind: 'write', title: 'Repair the blocking findings and rerun required checks', outcomes: ['committed'], file: 'retry.txt', contents: options.publication ? 'Complete retry status list {{intent}}\n' : 'Complete retry status list\n' },
            ...(options.publication ? { followRepair: { kind: 'write', title: 'Repair the followed pull request', outcomes: ['committed'], file: 'retry.txt', contents: 'Followed retry status list {{intent}}\n' } } : {}),
            review: { kind: 'review', title: 'Check and review the committed result', outcomes: options.publication ? ['approve'] : ['request-changes', 'approve'] },
          } }) },
        }, providerName)
        // The priced-source variant starts its synthetic runtime before the
        // host observes it: no predecessor epoch exists whose delegation is lost.
        // Ordinary/eager fixtures still prove zero worker processes pre-consent.
        if (options.workerSpend || restoring) await runtime.start()
        host.register(runtime)
        // Even an empty source is explicit and confined to this rig's synthetic home.
        const usage = join(codexHome, 'sessions'); await mkdir(usage, { recursive: true })
        host.bindUsage(id as RuntimeId, { corpus: 'codex', root: usage })
      }
      // Restore fake runtimes and their isolated usage sources before startup
      // recovers saved Seats. Recovery must not read an unbound source or
      // replace an already observed runtime epoch with the fixture runtime.
      if (restoring) await host.start()
      await host.call('workspace/open', { path: project.path })
      if (!enabled) return
      storage = await LeadFileJournal.open(home, 'synthetic-thread', { canaries: [LEAD_RIG_KEY] })
      journal = await createLeadJournal(storage)
      if (!journal.state.policy) {
        await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
        await journal.updateBudget({ version: 1, type: 'initialize', now: Date.now(), logicalGoalId: 'synthetic-goal', caps: proposal.caps, freshnessMs: options.freshnessMs ?? 60_000 })
      }
      const readEvidence = async (runId: string, read: (call: LeadPermissionCall) => Promise<unknown>): Promise<LeadAcceptanceEvidence> => {
        try {
        const owned = journal.state.runs.find(one => one.runId === runId)!
        const execution = await read({ method: 'flow/execution', params: { run: runId } }) as Awaited<ReturnType<Host['call']>> & { rounds: { cards: number[] }[] }
        const board = await host.call('goal/read', { goal: owned.teamId })
        const cardIds = new Set(execution.rounds.flatMap(round => round.cards))
        let evidence = await read({ method: 'evidence/board', params: { room: owned.teamId } }) as Awaited<ReturnType<typeof host.call<'evidence/board'>>>
        const reviews = evidence.cards.filter(card => cardIds.has(card.card)).flatMap(card => card.facts).filter(one => one.record.fact.kind === 'review')
        const revision = reviews.at(-1)?.record.fact.kind === 'review' ? (reviews.at(-1)!.record.fact as { at: string }).at : ''
        // The synthetic person authorizes the declared local command through the same window call.
        // Its real check runner writes revision-qualified evidence, never a fixture assertion.
        const implementation = board.board.intents.filter(card => cardIds.has(card.id) && card.role === 'implement' && card.state === 'done').at(-1)
        if (!options.manualChecks && !options.publication && revision && implementation && !checkStarts.has(`${runId}:${revision}`) && !evidence.cards.flatMap(card => card.facts).some(one => one.record.fact.kind === 'check' && one.record.fact.at === revision)) {
          const checks = await host.call('evidence/checks', { project: project.path })
          const check = checks.checks.find(one => one.name === 'verify')
          if (check && checks.at) {
            checkStarts.add(`${runId}:${revision}`)
            try { await host.call('evidence/check/run', { room: owned.teamId, card: implementation.id, name: check.name, seen: check.run, digest: git(project.path, 'rev-parse', 'HEAD:.harnessdesk/checks.yml') }) }
            catch (error) { checkStarts.delete(`${runId}:${revision}`); evidenceFailure = error instanceof Error ? error : new Error(String(error)); throw error }
          }
          evidence = await read({ method: 'evidence/board', params: { room: owned.teamId } }) as typeof evidence
        }
        const facts = evidence.cards.filter(card => cardIds.has(card.card)).flatMap(card => card.facts).filter(one => one.freshness.state === 'fresh').map(one => one.record)
        const blocked = facts.find(record => record.fact.kind === 'check' && /spawnSync ps.*EPERM/.test(record.fact.tail ?? ''))
        if (blocked?.fact.kind === 'check') throw new Error(blocked.fact.tail)
        const findings = await host.call('finding/run', { goal: owned.teamId, run: runId })
        // These facts were re-read and verified fresh at this revision now.
        // Use that read time so multi-step rig runtime cannot age a valid fact.
        const readAt = Date.now()
        return latestEvidence = { project, runId, contractDigest: journal.state.contract!.digest, revision, observedAt: Date.now(), complete: true,
          spendComplete: leadBudgetProjection(journal.state.budget!, Date.now()).spend === 'known',
          // Publication tests fake only normalized check inputs; review receipts,
          // exact checkout identity, host acceptance and gateway effects stay real.
          checks: options.publication && revision ? [{ assertionId: 'unit', id: `fixture-check-${revision}`, revision, observedAt: readAt, exit: 0, timedOut: false, dirty: false, counted: true }] : facts.flatMap(record => record.fact.kind === 'check' && record.fact.at === revision ? [{ assertionId: 'unit', id: record.id, revision: record.fact.at, observedAt: readAt,
            exit: record.fact.exit, timedOut: record.fact.timedOut, dirty: record.fact.dirty, counted: record.fact.counted === true }] : []),
          reviews: facts.flatMap(record => options.reviewAvailable?.() !== false && record.fact.kind === 'review' && record.fact.at === revision ? [{ assertionId: 'review', id: record.id,
            revision: record.fact.at, observedAt: readAt, verdict: record.fact.verdict, complete: true }] : []),
          findingsComplete: !findings.embargoed, findings: findings.blocking ? [{ id: `${runId}:blocking`, revision, blocking: true, resolved: false }] : [], diffs: [],
        }
        } catch (error) { evidenceFailure = error instanceof Error ? error : new Error(String(error)); throw error }
      }
      service = host.createLeadService({ journal, project, model, prices, messagesTransport: provider.transport,
        seats: { implement: [assignments[0]!.seat], review: [assignments[1]!.seat] },
        freezePlan: async value => {
          assert.deepEqual(value, proposal)
          return freezeLeadPlan(value)
        },
        resolveTool: async call => {
          const state = journal.state, params = call.params as Record<string, any>
          const step = state.contract?.steps.find(one => one.id === currentStep) ?? null
          return { project, runId: typeof params.run === 'string' ? params.run : null, start: call.method === 'flow/start-goal' ? step : null,
            stepId: step?.id ?? null, ...(preview ? { preview } : {}),
            context: { desk: state.policy!, projectPolicy: null, project, approved: null, budget: null, now: Date.now(), policyInterpretation: 'idle' } }
        }, readEvidence,
        createSupervisor: settings => {
          supervisorOptions = settings
          const supervisor = new LeadSupervisor({ ...settings,
          connectDesk: async (descriptor, signal) => {
            deskSocketPath = descriptor.socketPath
            // A byte-for-byte socket bridge injects a real connection loss. No
            // client reply, authorization or Flow method is substituted.
            const socketPath = join(home, `fd3-${children.length}.sock`)
            const bridge = createSocketServer(incoming => {
              const outgoing = connectSocket({ path: descriptor.socketPath })
              for (const socket of [incoming, outgoing]) {
                bridgeSockets.add(socket); socket.once('close', () => bridgeSockets.delete(socket))
                socket.once('error', () => { incoming.destroy(); outgoing.destroy() })
              }
              incoming.pipe(outgoing).pipe(incoming)
            })
            bridgeServers.push(bridge)
            await new Promise<void>((resolve, reject) => { bridge.once('error', reject); bridge.listen(socketPath, resolve) })
            return new Promise<Socket>((resolve, reject) => {
              const socket = connectSocket({ path: socketPath, signal }); socket.once('connect', () => resolve(socket)); socket.once('error', reject)
            })
          }, spawn: (binary, args, spawnOptions) => {
          assert.ok(args.includes('--permission')); assert.equal(spawnOptions.stdio.length, 4, 'desk socket inherited as fd 3')
          const child = spawn(binary, [...args], spawnOptions) as ChildProcessWithoutNullStreams; children.push(child); return child
        } })
          const send = supervisor.send.bind(supervisor)
          supervisor.send = async input => {
            const result = await send(input)
            eagerResults.push(...result.toolResults ?? [])
            return result
          }
          return supervisor
        },
      })
      await service.setEnabled(true)
    }
    if (options.workerSpend) {
      // This process-wide patch requires all tests in lead-e2e.test.ts to stay sequential (concurrency: false).
      // The Lead's meter reads its Seats' sessions; the patch covers that read and the whole-project one.
      const readInsight = Ledger.prototype.readInsight, readSessions = Ledger.prototype.readSessions
      restoreUsage = () => { Ledger.prototype.readInsight = readInsight; Ledger.prototype.readSessions = readSessions }
      const withWorker = <T extends { readonly samples: readonly unknown[] }>(root: string, result: T): T =>
        root === project.path && workerSample ? { ...result, samples: [...result.samples, workerSample] } : result
      Ledger.prototype.readInsight = async function(query, settings) { return withWorker(query.root, await readInsight.call(this, query, settings)) }
      Ledger.prototype.readSessions = async function(query, sessions, settings) { return withWorker(query.root, await readSessions.call(this, query, sessions, settings)) }
    }
    await setupHost()
    if (!options.holdWorkers) {
      if (options.premature) { for (const marker of ['write', 'repair']) await writeFile(join(gates, marker), '') }
      else await releaseWorkers()
    }
    const decide = async (card: LeadCard, choice: LeadCardDecision['choice']) => {
      if (card.type === 'stopped') throw new Error('stopped cards have no decision')
      if (options.offlineForge && choice === 'accept-open-pr') personPublication = true
      try { return await host.call('lead/card/decide', {
      version: 1, cardId: card.id, cardType: card.type, expectedRevision: card.revision, contractDigest: card.contractDigest, choice,
      }) } finally { personPublication = false }
    }
    const sendGoal = () => host.call('lead/thread/send', { idempotencyKey: `goal-${journal.state.seq}`, text: task })
    const settle = async () => { await host.flowsPlane.flush(); await sleep(150); await host.flowsPlane.flush() }
    const assertAccounting = async () => {
      await settle()
      const records = await storage!.read()
      const reserves = records.flatMap(record => record.type === 'budget' && record.event.type === 'reserve' ? [record.event] : [])
      const writeoffs = records.flatMap(record => record.type === 'budget' && record.event.type === 'write-off' ? [record.event.requestId] : [])
      const charged = provider.requests.reduce((sum, request) => {
        if (request.delivered) return sum + 100
        const reserve = reserves.find(one => one.requestId === request.id); assert.ok(reserve, 'every request has a durable reserve')
        const reservation = journal.state.budget!.settled.find(one => one.id === request.id)
        assert.ok(writeoffs.includes(request.id), 'interrupted requests are written off in full')
        assert.ok(reservation)
        return sum + Math.ceil(reserve.inputTokens * reserve.inputUsdMicrosPerMillion / 1_000_000) + Math.ceil(reserve.maxOutputTokens * reserve.outputUsdMicrosPerMillion / 1_000_000)
      }, 0)
      assert.equal(journal.state.budget!.leadUsdMicros, charged)
      assert.equal(journal.state.budget!.workerUsdMicros, workerMicros)
      assert.equal(journal.state.budget!.requests.length, 0)
      assert.equal(JSON.stringify([journal.state, windowNotifications]).includes(LEAD_RIG_KEY), false)
    }
    const assertNoForbiddenEffects = async () => {
      const logged = await Promise.all((await readdir(gitLog)).map(async name => (await readFile(join(gitLog, name), 'utf8')).split('\0').slice(0, -1)))
      const effects = logged.filter(args => args.includes('push') || args.includes('merge') || args.includes('worktree') && args.includes('remove') || args.includes('branch') && args.some(one => ['-d', '-D', '--delete'].includes(one)))
      const pushes = effects.filter(args => args.includes('push'))
      assert.deepEqual([...forbidden, ...effects.filter(args => !args.includes('push')).map(one => one.join(' '))], [], 'zero merges, deletions and unexpected forge publications')
      assert.equal(pushes.length, allowedPushes.length, 'every push is explicitly allowed and recorded by the host gateway')
      for (const args of pushes) {
        assert.ok(!args.some(arg => arg === '--force' || arg === '-f' || arg.startsWith('+')), 'zero force pushes')
        const refspec = args.find(arg => allowedPushes.some(push => arg.startsWith(`${push.sha}:refs/heads/`)))
        assert.ok(refspec, 'exact reviewed head refspec')
        const allowed = allowedPushes.find(push => refspec.startsWith(`${push.sha}:`))!
        // A lease is compare-and-swap, not permission to rewrite history.
        assert.ok(args.includes(`--force-with-lease=${refspec.split(':')[1]}:${allowed.previousSha ?? ''}`))
        if (allowed.previousSha) git(remote, 'merge-base', '--is-ancestor', allowed.previousSha, allowed.sha)

      }
      const creates = forgeCalls.filter(args => args[0] === 'pr' && args[1] === 'create')
      assert.ok(creates.length <= 1, 'at most the one person-authorized PR creation')
    }
    return { get host() { return host }, logger, home, project, get journal() { return journal }, get service() { return service },
      provider, children, calls, windowNotifications, get latestEvidence() { return latestEvidence }, pending, waitFor, workerCalls, worktrees, personGates, releaseWorkers, decide, sendGoal, settle, dispose,
      offline: options.offlineForge ? {
        read: readForge,
        async pushes() { return (await readFile(join(home, 'offline-gateway/ledger.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.op === 'push' && row.outcome === 'succeeded') },
        async poll() {
          forgeClock += 61_000
          const state = await readForge()
          for (const pull of state.pulls) {
            if (pull.branch) { const head = git(remote, 'rev-parse', `refs/heads/${pull.branch}`); if (head !== pull.head) pull.checks = [{ id: 3, head_sha: head, name: 'verify', status: 'queued', conclusion: null }]; pull.head = head }
          }
          await writeForge(state); await host.intakePlane.tick()
        },
        async failChecks() {
          await host.intakePlane.followingChanged()
          await host.intakePlane.tick() // Inventory the watched PR before the synthetic failure arrives.
          forgeClock = Math.max(forgeClock, Date.now()) + 1000
          const state = await readForge(), pull = state.pulls[0]
          pull.checks = [{ id: 1, head_sha: pull.head, name: 'verify', status: 'completed', conclusion: 'failure', completed_at: new Date(forgeClock).toISOString() }]
          await writeForge(state)
        },
        async passChecks() {
          forgeClock = Math.max(forgeClock, Date.now()) + 1000
          const state = await readForge(), pull = state.pulls[0]
          pull.head = journal.state.pr!.head
          pull.checks = [{ id: 2, head_sha: pull.head, name: 'verify', status: 'completed', conclusion: 'success', completed_at: new Date(forgeClock).toISOString() }]
          await writeForge(state)
        },
        async mergeExternally() { const state = await readForge(); state.pulls[0].state = 'closed'; state.pulls[0].merged = true; await writeForge(state) },
        async armTrigger() {
          const path = join(project.path, '.harnessdesk/triggers.yml')
          await writeFile(path, '- id: lead-pr\n  on: pull-request\n  opens: { lead: true }\n')
          git(project.path, 'add', '.harnessdesk/triggers.yml')
          git(project.path, '-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', 'commit', '-m', 'Add synthetic Lead trigger')
          const preview = await host.call('trigger/preview', { root: project.path, id: 'lead-pr' })
          assert.deepEqual(preview.problems, []); assert.ok(preview.lead); assert.ok(preview.token)
          await host.call('trigger/arm', { root: project.path, id: 'lead-pr', token: preview.token })
        },
        async openPull() {
          forgeClock += 1000
          const state = await readForge()
          state.pulls.push({ number: 12, head: git(project.path, 'rev-parse', 'HEAD'), title: 'Repair the retry check', state: 'open', created: forgeClock, updated: forgeClock })
          await writeForge(state)
        },
      } : undefined,
      async probeExpiredConsent() {
        await sendGoal(); await waitFor(() => provider.pending, 'held planning request')
        const socket = new WebSocket(`ws+unix://${deskSocketPath}:/client`)
        await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
        let next = 0
        const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
          const id = ++next
          const receive = (raw: Buffer) => {
            const reply = JSON.parse(raw.toString())
            if (reply.id !== id) return
            socket.off('message', receive)
            if (reply.ok) resolve(reply.result); else reject(Object.assign(new Error('synthetic door refusal'), { code: reply.error.code }))
          }
          socket.on('message', receive); socket.send(JSON.stringify({ id, method, params }))
        })
        await call('client/hello', { client: { name: 'synthetic', version: '1' }, protocol: 1 })
        try {
          const held = await call('flow/preview', { root: project.path, source: leadReviewedResultSource, seats, vars: {}, attended: true })
          assert.ok(held.token, 'real preview held before consent')
          assert.equal(journal.state.consent, null)
          provider.release(); await waitFor(() => !!pending('plan'), 'plan')
          await waitFor(async () => !(await host.call('lead/thread/read', {})).requestInFlight, 'idle planning turn')
          const card = pending('plan')!
          const expiresAt = Date.now() + 250
          await journal.decideCard({ version: 1, cardId: card.id, cardType: 'plan', expectedRevision: card.revision, contractDigest: card.contractDigest, choice: 'approve' }, expiresAt)
          const params = { root: project.path, source: leadReviewedResultSource, token: held.token, sentence: task, seats, vars: {}, attended: true }
          let code: string | null = null
          await journal.execute({ id: 'eager-door', stepId: 'first', request: { method: 'flow/start-goal', params, project, runId: null, start: journal.state.contract!.steps[0]! },
            context: { desk: journal.state.policy!, projectPolicy: null, project, approved: null, budget: null, now: Date.now(), policyInterpretation: 'idle' } }, async () => {
            await sleep(Math.max(0, expiresAt - Date.now() + 5))
            try { await call('flow/start-goal', params) } catch (error) { code = (error as { code: string }).code }
            return { value: null, identity: null, created: false }
          })
          assert.equal(journal.state.attempts.get('eager-door')!.dispatched, true, 'probe bypasses the child guard and reaches the door')
          assert.equal(code, 'leadStartNotApproved', 'the host admission consent guard must refuse before Flow effects')
        } finally { socket.terminate() }
      },
      async assertEagerRefused(id: string) { await waitFor(() => eagerResults.some(one => one.tool_use_id === id && one.is_error), `${id} refused by real tools and permission door`) },
      async eagerApprovalTurn() {
        // A worker event normally wakes the turn. If its batch has not run,
        // explicitly send through the window after its current request ends.
        await waitFor(async () => !(await host.call('lead/thread/read', {})).requestInFlight, 'idle Lead before eager answer turn')
        if (!eagerApproval) await sendGoal()
        // Wait for the paid proposal to finish at the real tool refusal gate.
        await waitFor(() => eagerApproval && journal.state.phase === 'waiting-for-user' &&
          journal.state.managementReason === 'lead-tools-refused', 'eager worker answer turn finishes refused')
      },
      async postCapSend() {
        // Script an eager child's reserve + send through the actual supervisor
        // callbacks. The normal loop parks at equality; this probes host admission.
        const requestId = 'post-cap-attempt', body = JSON.stringify(provider.requests[0]!.body)
        const event = { version: 1 as const, type: 'reserve' as const, now: Date.now(), requestId, inputTokens: Buffer.byteLength(body) + 1024, maxOutputTokens: 4096, ...prices[model] }
        try {
          supervisorOptions.admitBudgetEvent!(event)
          await journal.updateBudget(event)
          await supervisorOptions.providerSend!(requestId, body, new AbortController().signal)
        } catch { /* The assertion below distinguishes refusal from a billed send. */ }
      },
      async abruptRestart() {
        const requestId = journal.state.budget!.requests[0]!.reservation.requestId
        // Close durable storage first: the old host cannot record a graceful
        // write-off. Its normal shutdown is only resource cleanup after the crash.
        await storage!.close()
        await host.dispose(); await extensions!.dispose(); setTeamEngine(null)
        const durable = await LeadFileJournal.open(home, 'synthetic-thread', { canaries: [LEAD_RIG_KEY] })
        try {
          const inherited = await createLeadJournal(durable)
          assert.ok(inherited.state.budget!.requests.some(one => one.reservation.requestId === requestId), 'reservation survives old-host teardown durably')
          assert.ok(!inherited.state.budget!.settled.some(one => one.id === requestId), 'old host recorded no write-off')
        } finally { await durable.close() }
        storage = undefined; provider.interrupt()
        await setupHost()
        await service.recover()
      },
      async workerWaiting() { await waitFor(() => journal.state.runs.some(run => host.teamPlane.stateFor(run.teamId).intents.some(card => card.role === 'implement' && card.state === 'claimed')), 'scripted worker reaches its gate') },
      async reviewed() { await sendGoal(); await waitFor(() => !!pending('plan'), 'plan'); await decide(pending('plan')!, 'approve'); await waitFor(() => !!pending('result'), 'reviewed result') },
      async interrupt() { provider.interrupt(); await waitFor(() => journal.state.phase === 'waiting-for-user' || journal.state.phase === 'stopped', 'interrupted request') },
      async dispatchCounts() { return { provider: provider.requests.length, rounds: journal.state.budget!.rounds.length, turns: (await workerCalls()).filter(one => one.method === 'turn/start').length } },
      async reachCap(kind: 'dollars' | 'rounds' | 'unknown') {
        if (kind === 'unknown') {
          for (const id of ['rig-writer', 'rig-reviewer']) await chmod(join(home, id, 'sessions'), 0)
        } else {
          if (kind === 'dollars' && options.workerSpend) await waitFor(() => journal.state.budget!.workerUsdMicros === workerMicros && workerMicros > 0, 'real ledger reports synthetic worker spend')
          // A ledger observation may commit between the snapshot and the queued save.
          // Only stale revision is retryable; recompute equality from that new snapshot.
          for (let attempt = 0; ; attempt++) {
            const budget = leadBudgetProjection(journal.state.budget!, Date.now())
            try {
              await host.call('lead/settings/update', { expectedRevision: journal.state.seq, caps: { usdMicros: kind === 'dollars' ? budget.leadUsdMicros + budget.workerUsdMicros : budget.caps.usdMicros,
                rounds: kind === 'rounds' ? budget.roundsAdmitted : budget.caps.rounds } })
              break
            } catch (error) {
              if ((error as { wireCode?: string }).wireCode !== 'lead-revision-stale' || attempt >= 19) throw error
            }
          }
        }
        await settle()
      },
      failSecondGateSave() {
        const original = GoalStore.prototype.save
        restoreGoalSave = () => { GoalStore.prototype.save = original }
        GoalStore.prototype.save = async function(document, revision) {
          if (failGate && !failedGate && document.goal.id === journal.state.runs[1]?.teamId && document.board.intents.some(card => card.role === 'accept' && card.state === 'done' && card.outcome === 'accepted')) {
            failedGate = true; throw new Error('synthetic second gate save failure')
          }
          return original.call(this, document, revision)
        }
        failGate = true
      },
      async interruptAt(kind: 'child-crash' | 'host-restart' | 'connection-gap') {
        if (kind === 'child-crash') { children.at(-1)!.kill('SIGKILL'); await waitFor(() => children.at(-1)?.exitCode !== null || children.at(-1)?.signalCode !== null, 'child exit') }
        else if (kind === 'connection-gap') {
          // Close the real fd-3 connection, not a synthetic loop event.
          for (const socket of bridgeSockets) socket.destroy(); await waitFor(() => children.at(-1)?.exitCode !== null || children.at(-1)?.signalCode !== null, 'connection exit')
        } else {
          await host.dispose(); await extensions!.dispose(); setTeamEngine(null); await storage!.close(); storage = undefined; await setupHost()
        }
        provider.interrupt()
        await service.recover()
      }, assertAccounting, assertNoForbiddenEffects,
    }
  } catch (error) { await dispose(); throw error }
}
