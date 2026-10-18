import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { connect as connectSocket, createServer as createSocketServer, type Server as SocketServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createLeadJournal, leadBudgetProjection, leadReviewedResultSource, type LeadAcceptanceEvidence, type LeadJournal, type LeadPermissionCall } from '@harnessdesk/lead'
import { LeadSupervisor } from '@harnessdesk/lead/supervisor'
import { parseLeadAcceptanceContract, type LeadCard, type LeadCardDecision, type RuntimeId } from '@harnessdesk/protocol'
import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { ExtensionKernel, setTeamEngine } from '@harnessdesk/cordis-host'
import { teamPlugin } from '@harnessdesk/plugins'
import { Host, Logger, StateStore } from '../../src/index.js'
import { LeadFileJournal } from '../../src/lead/journal.js'
import { GatedRegistry } from '../../src/ceilings/gate.js'
import { GoalStore } from '../../src/goals/store.js'
import { LEAD_RIG_KEY, leadMessagesServer } from './lead-messages-server.js'
import type { LeadService } from '../../src/lead/service.js'

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
  readonly scenario?: 'happy' | 'interrupted' | 'worker-approval' | 'forbidden'
  readonly holdWorkers?: boolean
  readonly holdPlanning?: boolean
  readonly holdRunning?: boolean
}
/** Synthetic services around the actual host, fd-3 child, client door and Flow.
 * Each instance owns its temp home and restores its environment before removal.
 * This is intentionally serial: the host's extension plane and environment are process-owned. */
export async function createLeadRig(options: LeadRigOptions = {}) {
  const scratch = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'hd-lrig-')))
  const home = join(scratch, 'home'), project = { id: 'synthetic-project', path: join(scratch, 'project') }
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
  let currentStep = '', preview: { token: string; source: string; expiresAt: number } | undefined
  let provider: Awaited<ReturnType<typeof leadMessagesServer>>
  let restoreGoalSave: (() => void) | undefined
  const enabled = options.enabled !== false
  const gitBinary = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
  const git = (cwd: string, ...args: string[]) => execFileSync(gitBinary, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const waitFor = async (predicate: () => boolean | Promise<boolean>, label = 'rig state') => {
    const until = Date.now() + 90_000
    while (!await predicate()) {
      if (Date.now() >= until) throw new Error(`Timed out waiting for ${label}; phase=${journal?.state.phase}; reason=${journal?.state.managementReason}`)
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
  const releaseWorkers = async () => { for (const marker of ['write', 'repair', 'review']) await writeFile(join(gates, marker), '') }
  const restoreEnvironment = () => {
    if (previousHome === undefined) delete process.env['HARNESSDESK_HOME']; else process.env['HARNESSDESK_HOME'] = previousHome
    if (previousPath === undefined) delete process.env['PATH']; else process.env['PATH'] = previousPath
  }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    for (const id of ['rig-writer', 'rig-reviewer']) await chmod(join(home, id, 'sessions'), 0o700).catch(() => {})
    restoreGoalSave?.()
    try { await host?.dispose(); await extensions?.dispose(); setTeamEngine(null); await storage?.close(); await provider?.close(); for (const socket of bridgeSockets) socket.destroy(); await Promise.all(bridgeServers.map(server => new Promise<void>(resolve => server.close(() => resolve())))) }
    finally { restoreEnvironment(); await rm(scratch, { recursive: true, force: true, maxRetries: 5 }) }
  }
  try {
    await mkdir(home, { recursive: true }); await mkdir(project.path); await mkdir(gates)
    await mkdir(join(project.path, '.harnessdesk'))
    // fast-import supplies placeholder authors without changing Git config or identity environment.
    git(project.path, 'init', '-b', 'main')
    const checks = `verify: { run: 'node -e "process.exit(0)"', timeout: 10 }\n`
    const seed = Buffer.from(checks)
    execFileSync(gitBinary, ['fast-import', '--quiet'], { cwd: project.path, input: Buffer.concat([
      Buffer.from(`commit refs/heads/main\nauthor Jane Doe <dev@example.com> 1700000000 +0000\ncommitter Jane Doe <dev@example.com> 1700000000 +0000\ndata 16\nSynthetic source\nM 100644 inline .harnessdesk/checks.yml\ndata ${seed.length}\n`), seed, Buffer.from('\n\n')]), stdio: ['pipe', 'pipe', 'pipe'] })
    git(project.path, 'checkout', 'main')
    await writeFile(passes, JSON.stringify({ passes: {}, done: [] }))
    const bin = join(home, 'bin'); await mkdir(bin)
    // Observe actual Git effects, including those the host invokes internally.
    const wrapper = join(bin, 'git')
    await mkdir(gitLog)
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    // A shell builtin records the exact argv without launching a Node process
    // for every Git read. Each invocation owns a file, including concurrent reads.
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\0' "$@" > ${quote(gitLog)}/$$\nexec ${quote(gitBinary)} "$@"\n`)
    await chmod(wrapper, 0o755); process.env['PATH'] = `${bin}:${previousPath ?? ''}`
    const assignments = [
      { role: 'implement', agent: 'implementer', seat: { runtime: 'rig-writer', model: 'gpt-5.5' }, ceiling: 'edit' },
      { role: 'review', agent: 'code-reviewer', seat: { runtime: 'rig-reviewer', model: 'gpt-5.5' }, ceiling: 'read' },
    ]
    const proposal = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: task, project, policyRevision: 1,
      steps: ['first', 'second'].map(id => ({ id, title: `Review ${id} repair`, flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended', assignments })),
      assertions: [{ id: 'unit', kind: 'check', description: 'Required check passes' }, { id: 'review', kind: 'review', description: 'Independent review approves' },
        { id: 'blockers', kind: 'blocking-findings', description: 'No unresolved blockers' }], caps: { usdMicros: 10_000_000, rounds: 20 } })
    const seats = Object.fromEntries(assignments.map(one => [one.role, [one.seat]]))
    let toolId = 0, forbiddenAttempt = 0
    const reply = (body: Record<string, any>): unknown[] => {
      const state = journal.state
      if (!state.contract || !state.consent) return [text(JSON.stringify({ version: 1, type: 'lead-output', text: 'Review the two-part repair before work starts.', plan: proposal }))]
      if (options.scenario === 'forbidden') {
        const name = ['flow_preview', 'forge_publish', 'git_merge', 'project_delete', 'git_push'][forbiddenAttempt++ % 5]!
        return [{ type: 'tool_use', id: `forbidden-${++toolId}`, name, input: name === 'flow_preview'
          ? { root: project.path, source: leadReviewedResultSource.replace('grant: edit', 'grant: merge'), seats, vars: {}, attended: true } : {} }]
      }
      const step = state.steps.find(one => one.state === 'pending')
      const priorReady = state.runs.every(run => host.teamPlane.stateFor(run.teamId).intents.some(card => card.role === 'accept' && card.state === 'open'))
      if (step && priorReady && !state.budget?.stop) {
        currentStep = step.id
        const latest = body.messages?.at(-1)?.content ?? []
        const result = latest.find((one: any) => one.type === 'tool_result' && !one.is_error)
        let value: any
        try { value = result && JSON.parse(result.content) } catch { /* The next request obtains another real preview. */ }
        if (value?.token) {
          preview = { token: value.token, source: leadReviewedResultSource, expiresAt: value.expiresAt ?? Date.now() + 60_000 }
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
      extensions = new ExtensionKernel()
      host = new Host({ extensions, logger, state: new StateStore(join(home, 'state.json')), leadEnabled: enabled,
        catalogRefreshMs: 0, libraryHome: join(home, 'person'),
        evidence: { gh: async args => { if (args.some(arg => ['create', 'merge', 'delete', 'edit', 'comment', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(arg))) forbidden.push(`forge:${args.join(' ')}`); return { stdout: '', stderr: 'No forge in Lead rig', exitCode: 1 } } },
        forge: { gh: async args => { if (args.some(arg => ['create', 'merge', 'delete', 'edit', 'comment', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(arg))) forbidden.push(`forge:${args.join(' ')}`); return { stdout: '', stderr: 'No forge in Lead rig', exitCode: 1 } } },
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
      host.addBroadcaster(notification => windowNotifications.push(notification))
      setTeamEngine(host.teamPlane); await extensions!.load(teamPlugin)
      await host.start()
      for (const [id, providerName] of [['rig-writer', 'synthetic-writer'], ['rig-reviewer', 'synthetic-reviewer']] as const) {
        const codexHome = join(home, id); await mkdir(codexHome, { recursive: true })
        const runtime = new RigRuntime({ id: id as RuntimeId, name: id === 'rig-writer' ? 'Scripted writer' : 'Scripted reviewer', codexHome,
          binaryPath: join(root, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'),
          capabilities: new GatedRegistry(extensions!, () => host.ceilingGate),
          env: { FAKE_CODEX_PROCESS_CALLS: workerLog, FAKE_CODEX_FLOW: JSON.stringify({ state: passes, gates, approvalLog: workerLog, passPerRun: true, approvalBeforeWork: options.scenario === 'worker-approval', steps: {
            write: { kind: 'write', title: 'Implement the approved goal', outcomes: ['committed'], file: 'retry.txt', contents: 'Incomplete retry status list\n' },
            repair: { kind: 'write', title: 'Repair the blocking findings and rerun required checks', outcomes: ['committed'], file: 'retry.txt', contents: 'Complete retry status list\n' },
            review: { kind: 'review', title: 'Check and review the committed result', outcomes: ['request-changes', 'approve'] },
          } }) },
        }, providerName)
        host.register(runtime)
        // Even an empty source is explicit and confined to this rig's synthetic home.
        const usage = join(codexHome, 'sessions'); await mkdir(usage, { recursive: true })
        host.bindUsage(id as RuntimeId, { corpus: 'codex', root: usage })
      }
      await host.call('workspace/open', { path: project.path })
      if (!enabled) return
      storage = await LeadFileJournal.open(home, 'synthetic-thread', { canaries: [LEAD_RIG_KEY] })
      journal = await createLeadJournal(storage)
      if (!journal.state.policy) {
        await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
        await journal.updateBudget({ version: 1, type: 'initialize', now: Date.now(), logicalGoalId: 'synthetic-goal', caps: proposal.caps, freshnessMs: 60_000 })
      }
      const readEvidence = async (runId: string, read: (call: LeadPermissionCall) => Promise<unknown>): Promise<LeadAcceptanceEvidence> => {
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
        if (revision && implementation && !checkStarts.has(`${runId}:${revision}`) && !evidence.cards.flatMap(card => card.facts).some(one => one.record.fact.kind === 'check' && one.record.fact.at === revision)) {
          const checks = await host.call('evidence/checks', { project: project.path })
          const check = checks.checks.find(one => one.name === 'verify')
          if (check && checks.at) {
            checkStarts.add(`${runId}:${revision}`)
            try { await host.call('evidence/check/run', { room: owned.teamId, card: implementation.id, name: check.name, seen: check.run, digest: git(project.path, 'rev-parse', 'HEAD:.harnessdesk/checks.yml') }) }
            catch (error) { checkStarts.delete(`${runId}:${revision}`); throw error }
          }
          evidence = await read({ method: 'evidence/board', params: { room: owned.teamId } }) as typeof evidence
        }
        const facts = evidence.cards.filter(card => cardIds.has(card.card)).flatMap(card => card.facts).filter(one => one.freshness.state === 'fresh').map(one => one.record)
        const findings = await host.call('finding/run', { goal: owned.teamId, run: runId })
        return { project, runId, contractDigest: journal.state.contract!.digest, revision, observedAt: Date.now(), complete: true,
          spendComplete: leadBudgetProjection(journal.state.budget!, Date.now()).spend === 'known',
          checks: facts.flatMap(record => record.fact.kind === 'check' && record.fact.at === revision ? [{ assertionId: 'unit', id: record.id, revision: record.fact.at, observedAt: record.observedAt,
            exit: record.fact.exit, timedOut: record.fact.timedOut, dirty: record.fact.dirty, counted: record.fact.counted === true }] : []),
          reviews: facts.flatMap(record => record.fact.kind === 'review' && record.fact.at === revision ? [{ assertionId: 'review', id: record.id,
            revision: record.fact.at, observedAt: record.observedAt, verdict: record.fact.verdict, complete: true }] : []),
          findingsComplete: !findings.embargoed, findings: findings.blocking ? [{ id: `${runId}:blocking`, revision, blocking: true, resolved: false }] : [], diffs: [],
        }
      }
      service = host.createLeadService({ journal, project, model, prices, messagesTransport: provider.transport,
        freezePlan: async value => {
          assert.deepEqual(value, proposal)
          return { ...value, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
        },
        resolveTool: async call => {
          const state = journal.state, params = call.params as Record<string, any>
          const step = state.contract?.steps.find(one => one.id === currentStep) ?? null
          return { project, runId: typeof params.run === 'string' ? params.run : null, start: call.method === 'flow/start-goal' ? step : null,
            stepId: step?.id ?? null, ...(preview ? { preview } : {}),
            context: { desk: state.policy!, projectPolicy: null, project, approved: null, budget: null, now: Date.now(), policyInterpretation: 'idle' } }
        }, readEvidence,
        createSupervisor: settings => new LeadSupervisor({ ...settings,
          connectDesk: async (descriptor, signal) => {
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
        } }),
      })
      await service.setEnabled(true)
    }
    await setupHost()
    if (!options.holdWorkers) await releaseWorkers()
    const decide = async (card: LeadCard, choice: LeadCardDecision['choice']) => {
      if (card.type === 'stopped') throw new Error('stopped cards have no decision')
      return host.call('lead/card/decide', {
      version: 1, cardId: card.id, cardType: card.type, expectedRevision: card.revision, contractDigest: card.contractDigest, choice,
    }) }
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
      assert.deepEqual([...forbidden, ...effects.map(one => one.join(' '))], [], 'zero merges, publishes, deletions, forge writes and pushes')
    }
    return { get host() { return host }, logger, home, project, get journal() { return journal }, get service() { return service },
      provider, children, calls, windowNotifications, pending, waitFor, workerCalls, worktrees, personGates, releaseWorkers, decide, sendGoal, settle, dispose,
      async workerWaiting() { await waitFor(() => journal.state.runs.some(run => host.teamPlane.stateFor(run.teamId).intents.some(card => card.role === 'implement' && card.state === 'claimed')), 'scripted worker reaches its gate') },
      async reviewed() { await sendGoal(); await waitFor(() => !!pending('plan'), 'plan'); await decide(pending('plan')!, 'approve'); await waitFor(() => !!pending('result'), 'reviewed result') },
      async interrupt() { provider.interrupt(); await waitFor(() => journal.state.phase === 'waiting-for-user' || journal.state.phase === 'stopped', 'interrupted request') },
      async dispatchCounts() { return { provider: provider.requests.length, rounds: journal.state.budget!.rounds.length, turns: (await workerCalls()).filter(one => one.method === 'turn/start').length } },
      async reachCap(kind: 'dollars' | 'rounds' | 'unknown') {
        if (kind === 'unknown') {
          for (const id of ['rig-writer', 'rig-reviewer']) await chmod(join(home, id, 'sessions'), 0)
        } else {
          const budget = leadBudgetProjection(journal.state.budget!, Date.now())
          await host.call('lead/settings/update', { expectedRevision: journal.state.seq, caps: { usdMicros: kind === 'dollars' ? budget.leadUsdMicros + budget.workerUsdMicros : budget.caps.usdMicros,
            rounds: kind === 'rounds' ? budget.roundsAdmitted : budget.caps.rounds } })
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
