import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseClientMessage, parseLeadAcceptanceContract, parseLeadBudgetEvent, parseLeadCard, parseLeadMessage,
  type LeadBudgetEvent, type LeadCard, type LeadAcceptanceContract, type LeadProject, type LeadPermissionPolicy, type LeadPresence, parseLeadPresence } from '@harnessdesk/protocol'
import type { DeskPointer } from '@harnessdesk/client/node'
import { parseLeadRunIdentity, type LeadJournal, type LeadDispatchResult } from './journal.js'
import type { LeadPermissionCall } from './permissions.js'
import type { LeadResolvedTool } from './tools.js'
import type { LeadAcceptanceEvidence } from './acceptance.js'
import type { LeadMessagesRequest, LeadMessagesResult, MessagesPrice, MessagesHttpResponse } from './messages-types.js'
import { LeadFrameDecoder, encodeLeadFrame, ipcObject, ipcText, type LeadIpcMessage, type LeadRpcOperation } from './child-ipc.js'

export type { LeadChildBootstrap } from './child-ipc.js'
import type { LeadChildBootstrap } from './child-ipc.js'
/** Three 30-second transport attempts plus two bounded retry waits fit below this watchdog. */
export const LEAD_SEND_DEADLINE_MS = 180_000

export interface LeadSupervisorOptions {
  readonly bootstrap: (signal: AbortSignal) => Promise<LeadChildBootstrap>
  readonly journal: LeadJournal
  readonly resolveTool: (call: LeadPermissionCall) => Promise<LeadResolvedTool>
  readonly freezePlan: (contract: LeadAcceptanceContract) => Promise<LeadAcceptanceContract>
  readonly readEvidence: (runId: string, read: (call: LeadPermissionCall) => Promise<unknown>) => Promise<LeadAcceptanceEvidence>
  readonly admitCardOffer?: (card: LeadCard) => void
  readonly admitBudgetEvent?: (event: LeadBudgetEvent) => void
  /** The host's last word on a model text before it is written down for the person: throw to refuse it. */
  readonly admitReply?: (text: string) => Promise<void>
  readonly providerSend?: (requestId: string, body: string, signal: AbortSignal) => Promise<MessagesHttpResponse>
  /** Test seam for the host-owned, already-connected desk socket. */
  readonly connectDesk?: (descriptor: DeskPointer, signal: AbortSignal) => Promise<Socket | null>
  readonly onStarted?: () => Promise<void> | void
  readonly onExit?: (reason: string) => Promise<void> | void
  readonly onWaitEnded?: (runId: string, reason: 'ownership-withdrawn') => void
  /** The child's checks between model turns, for the person's window; a malformed one is a broken protocol. */
  readonly onPresence?: (presence: LeadPresence) => void
  readonly startupMs?: number
  readonly shutdownMs?: number
  /** Test injection retains the exact production argv/environment construction. */
  readonly spawn?: (binary: string, args: readonly string[], options: { env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe', Socket] | ['pipe', 'pipe', 'pipe']; windowsHide: boolean }) => ChildProcessWithoutNullStreams
}
type Deferred = { resolve(value: unknown): void; reject(error: Error): void }
interface Running {
  readonly child: ChildProcessWithoutNullStreams
  readonly providerAbort: AbortController
  readonly pending: Map<number, Deferred>
  readonly journalWork: Set<Promise<unknown>>
  readonly replies: Map<number, Deferred & { type: 'dispatch' | 'read'; correlationId?: string }>
  ready: boolean
  initialized: boolean
  rpcId: number
  id: number
  exited: boolean
  poisoned: boolean
  reason: string
  readonly done: Promise<void>
  finish(): void
  failReady(error: Error): void
  markReady(): void
}
const error = (code: string) => new Error(`lead-child-${code}`)
/** The child's whole environment. Locale and TLS trust use OS defaults. In particular NODE_OPTIONS, PATH,
 * vendor keys, home-directory markers and proxy variables never cross. Inside the desktop app the host is
 * Electron, so `process.execPath` is the Electron binary: without ELECTRON_RUN_AS_NODE it starts a second app
 * instead of running child.js, and the Lead's child exits before its first request. */
export const leadChildEnv = (source: NodeJS.ProcessEnv = process.env, versions: NodeJS.ProcessVersions = process.versions): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of ['LANG', 'LC_ALL', 'TZ']) if (source[name]) env[name] = source[name]!
  if (versions['electron']) env['ELECTRON_RUN_AS_NODE'] = '1'
  return env
}
const callFrom = (value: unknown): LeadPermissionCall => {
  const source = ipcObject(value, ['method', 'params'])
  const parsed = parseClientMessage({ id: 1, method: source.method, params: source.params })
  return { method: parsed.method, params: parsed.params } as LeadPermissionCall
}
const write = (running: Running, message: Omit<LeadIpcMessage, 'version'>) => {
  if (running.exited || running.poisoned) throw error('exited')
  running.child.stdin.write(encodeLeadFrame({ version: 1, ...message }))
}
/** Read the exact package trees needed by the ESM/client loader. No repository,
 * home, journal, credential directory, generic node_modules or write grant. */
const readGrants = (): readonly string[] => {
  const leadDist = dirname(dirname(fileURLToPath(import.meta.url))), leadRoot = dirname(leadDist)
  // --preserve-symlinks keeps dependency reads at these exact package paths,
  // including pnpm's links, without needing a repository-wide node_modules grant.
  const client = join(leadRoot, 'node_modules/@harnessdesk/client')
  const protocol = join(leadRoot, 'node_modules/@harnessdesk/protocol')
  return [
    leadDist, join(leadRoot, 'package.json'), // This child's compiled implementation and package format.
    join(client, 'dist'), join(client, 'package.json'), // Public desk client implementation and package format.
    join(protocol, 'dist'), join(protocol, 'package.json'), // Portable vocabulary and wire validators.
    join(client, 'node_modules/@harnessdesk/protocol'), // The client's exact protocol dependency link.
    join(leadRoot, 'node_modules/ws'), // Only the WebSocket dependency and its own relative modules.
  ]
}
/** Owns one pid. The host-only key is never written to child input or a field; no IPC
 * payload, provider error, stderr chunk or process error is ever logged. */
export class LeadSupervisor {
  #running: Running | null = null
  #starting: Promise<void> | null = null
  #launching: Promise<void> | null = null
  #startAbort: AbortController | null = null
  #stopping: Promise<void> | null = null
  #generation = 0
  constructor(private readonly options: LeadSupervisorOptions) {}
  get live(): boolean { return this.#running !== null && !this.#running.exited }
  ensure(): Promise<void> {
    if (this.#stopping) return Promise.reject(error('stopping'))
    if (this.#starting) return this.#starting
    if (this.#launching) return Promise.reject(error('bootstrap-active'))
    if (this.live) return Promise.resolve()
    if (this.#running) return this.#running.done.then(() => this.ensure())
    const generation = this.#generation
    const work = this.#start(generation)
    this.#starting = work
    void work.finally(() => { if (this.#starting === work) this.#starting = null }).catch(() => {})
    return work
  }
  async #start(generation: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController(); this.#startAbort = controller
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
      controller.abort(); this.#generation++; const running = this.#running
      if (running) { running.reason = 'startup-timeout'; this.#kill(running) }
      reject(error('startup-timeout'))
    }, this.options.startupMs ?? 10_000) })
    const launch = async () => {
      const config = await this.options.bootstrap(controller.signal)
      if (generation !== this.#generation || this.#stopping) throw error('stopping')
      ipcText(config.key, 8192)
      const env = leadChildEnv()
      // No network grant: only the inherited, connected fd 3 reaches the desk.
      // Residual: process.kill is outside Node's permission model; child code
      // can still signal same-user processes.
      const args = ['--permission', '--no-addons', '--preserve-symlinks', ...readGrants().map(path => `--allow-fs-read=${path}`),
        fileURLToPath(new URL('./child.js', import.meta.url))]
      const socket = await (this.options.connectDesk ?? ((descriptor, signal) => new Promise<Socket>((resolve, reject) => {
        const connection = connect({ path: descriptor.socketPath, signal })
        connection.once('connect', () => resolve(connection))
        connection.once('error', () => { connection.destroy(); reject(error('desk-connect-failed')) })
      })))(config.descriptor, controller.signal)
      let child: ChildProcessWithoutNullStreams
      try {
        if (generation !== this.#generation || this.#stopping) throw error('stopping')
        child = (this.options.spawn ?? spawnProcess)(process.execPath, args, { env,
          stdio: socket ? ['pipe', 'pipe', 'pipe', socket] : ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams
      } catch { throw error('spawn-failed') }
      finally { socket?.destroy() }
      let finish!: () => void, markReady!: () => void, failReady!: (error: Error) => void
      const done = new Promise<void>(resolve => { finish = resolve })
      const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject })
      void ready.catch(() => {})
      const running: Running = { child, providerAbort: new AbortController(), pending: new Map(), replies: new Map(), journalWork: new Set(), ready: false, initialized: false, rpcId: 0, id: 0, exited: false, poisoned: false,
        reason: 'exited', done, finish, markReady, failReady }
      this.#running = running
      const decoder = new LeadFrameDecoder()
      child.stdout.on('data', (chunk: Uint8Array) => {
        if (running.exited) return
        try { decoder.push(chunk, message => this.#receive(running, message)) }
        catch { this.#protocolFailure(running) }
      })
      // Drain without exposing any byte, including an unhandled provider stack.
      child.stderr.on('data', () => {})
      child.stdin.on('error', () => { if (!running.exited) this.#protocolFailure(running) })
      child.once('exit', () => { void this.#exit(running).catch(() => {}) })
      child.once('error', () => { running.reason = 'spawn-failed'; void this.#exit(running).catch(() => {}) })
      const detach = this.options.journal.onChange(() => {
        if (this.#running === running && !running.exited && !running.poisoned && running.initialized) {
          try { write(running, { type: 'state', state: this.options.journal.state }) } catch { this.#protocolFailure(running) }
        }
      })
      void done.then(detach)
      try {
        this.options.journal.setChildLive(true)
        await this.options.onStarted?.()
        if (generation !== this.#generation || this.#stopping || running.exited) throw error('stopping')
        running.initialized = true
        const { key: _key, descriptor: _descriptor, ...childConfig } = config
        write(running, { type: 'initialize', config: childConfig, state: this.options.journal.state })
        await ready
      } catch { this.#kill(running); await running.done; throw error('startup-failed') }
    }
    const launched = launch(); this.#launching = launched
    void launched.finally(() => {
      if (this.#launching === launched) this.#launching = null
      if (this.#startAbort === controller) this.#startAbort = null
    }).catch(() => {})
    try { await Promise.race([launched, deadline]) } finally { if (timer) clearTimeout(timer) }
  }
  #receive(running: Running, message: LeadIpcMessage): void {
    if (running.poisoned || running.exited) throw error('protocol')
    if (message.type === 'ready') {
      if (running.ready || !running.initialized) throw error('protocol')
      running.ready = true; running.markReady(); return
    }
    if (!running.ready) throw error('protocol')
    if (message.type === 'rpc') {
      const id = message.id as number
      if (id !== running.rpcId + 1) throw error('protocol')
      running.rpcId = id
      if (this.#stopping) throw error('stopping')
      void this.#rpc(running, id, message.operation as LeadRpcOperation, message.args as unknown[])
      return
    }
    if (message.type === 'dispatch-result' || message.type === 'read-result') {
      const pending = running.replies.get(message.id as number)
      if (!pending || message.type !== `${pending.type}-result`) throw error('protocol')
      if (message.ok && pending.type === 'dispatch') {
        const result = ipcObject(message.value)
        // Only a trusted host can prove that no start was created; the child
        // never carries the host-only created:false attestation.
        ipcObject(result, ['value', 'identity'])
        if (result.identity !== null && parseLeadRunIdentity(result.identity).correlationId !== pending.correlationId) throw error('protocol')
      }
      running.replies.delete(message.id as number)
      if (message.ok) pending.resolve(message.value); else pending.reject(error('dispatch-failed'))
      return
    }
    if (message.type === 'response') {
      const pending = running.pending.get(message.id as number)
      if (!pending) throw error('protocol')
      const result = ipcObject(message.result)
      if (!['completed', 'max-tokens', 'refused', 'cancelled', 'uncertain', 'rate-limited', 'failed', 'invalid-response'].includes(result.status as string)) throw error('protocol')
      running.pending.delete(message.id as number); pending.resolve(result); return
    }
    if (message.type === 'presence') { const presence = parseLeadPresence(message.presence); this.options.onPresence?.(presence); return }
    if (message.type === 'desk-lost') { running.reason = 'desk-lost'; this.#kill(running); return }
    if (message.type === 'wait-ended') {
      this.options.onWaitEnded?.(message.runId as string, 'ownership-withdrawn'); return
    }
    throw error('protocol')
  }
  #reverse(running: Running, message: Record<string, unknown>): Promise<unknown> {
    if (running.exited || running.poisoned || this.#stopping) return Promise.reject(error('stopping'))
    const id = ++running.id
    return new Promise((resolve, reject) => {
      running.replies.set(id, { resolve, reject, type: message.type as 'dispatch' | 'read', correlationId: message.correlationId as string | undefined })
      try { write(running, { ...message, id } as Omit<LeadIpcMessage, 'version'>) }
      catch { running.replies.delete(id); reject(error('exited')) }
    })
  }
  async #rpc(running: Running, id: number, operation: LeadRpcOperation, args: unknown[]): Promise<void> {
    const journal = this.options.journal
    const durable = <T>(promise: Promise<T>): Promise<T> => {
      running.journalWork.add(promise)
      void promise.finally(() => running.journalWork.delete(promise)).catch(() => {})
      return promise
    }
    try {
      const arity = { execute: 1, updateBudget: 1, setManagementPhase: 2, invalidateResults: 0, offerCard: 1,
        restoreResult: 2, recoverUnsettledRequests: 0, appendReply: 1, resolveTool: 1, freezePlan: 1, readEvidence: 1, 'provider-send': 2 }[operation]
      if (args.length !== arity) throw error('protocol')
      let value: unknown = null
      switch (operation) {
        case 'provider-send': {
          if (typeof args[0] !== 'string' || typeof args[1] !== 'string' || new TextEncoder().encode(args[1]).length > 1_048_576) throw error('protocol')
          try {
            if (!this.options.providerSend) throw error('provider-unavailable')
            value = await this.options.providerSend(args[0], args[1], running.providerAbort.signal)
          } catch {
            if (!running.exited) write(running, { type: 'reply', id, ok: false, value: null, state: journal.state })
            return
          }
          break
        }
        case 'execute': {
          const input = ipcObject(args[0])
          ipcObject(input, ['id', 'request', 'context', ...(Object.hasOwn(input, 'stepId') ? ['stepId'] : []), ...(Object.hasOwn(input, 'predecessor') ? ['predecessor'] : [])])
          const request = ipcObject(input.request)
          const call = callFrom({ method: request.method, params: request.params })
          const scope = await this.options.resolveTool(call)
          if (running.exited || running.poisoned || this.#stopping) throw error('stopping')
          // All authority is derived again in the host. The child's project,
          // context, approved start and step claims confer no authority.
          value = await durable(journal.execute({ id: ipcText(input.id, 256), request: { ...call, project: scope.project,
            runId: scope.runId, start: scope.start }, context: scope.context, stepId: scope.stepId, predecessor: scope.predecessor },
          (admitted, correlationId) => this.#reverse(running, { type: 'dispatch', rpcId: id, call: admitted, correlationId }) as Promise<LeadDispatchResult>))
          break
        }
        case 'updateBudget': {
          const event = parseLeadBudgetEvent(args[0])
          this.options.admitBudgetEvent?.(event)
          value = await durable(journal.updateBudget(event)); break
        }
        case 'setManagementPhase':
          if (!['planning', 'waiting-for-user'].includes(args[0] as string) || !(args[1] === null || typeof args[1] === 'string')) throw error('protocol')
          await durable(journal.setManagementPhase(args[0] as 'planning' | 'waiting-for-user', args[1] as string | null)); break
        case 'invalidateResults': await durable(journal.invalidateResults()); break
        case 'offerCard': {
          const card = parseLeadCard(args[0])
          // Only the loop's proposal/result cards, never a human permission or budget decision.
          if (!['plan', 'result', 'waiting'].includes(card.type)) throw error('protocol')
          value = await durable(journal.offerCard(card, this.options.admitCardOffer)); break
        }
        case 'restoreResult': {
          if (typeof args[1] !== 'number' || !Number.isSafeInteger(args[1]) || args[1] < 1) throw error('protocol')
          await durable(journal.restoreResult(ipcText(args[0], 256), args[1])); break
        }
        case 'recoverUnsettledRequests': await durable(journal.recoverUnsettledRequests()); break
        case 'appendReply': {
          const text = ipcText(args[0])
          // A goal that has ended takes no more words. A text the desk will not show, a secret or one the journal cannot
          // hold, is refused by name and does not break the child; the host scans whatever stays in the result again.
          if (['accepted', 'declined', 'stopped'].includes(journal.state.phase)) break
          try { parseLeadMessage({ version: 1, id: 'message-1', revision: 1, role: 'assistant', text }); await this.options.admitReply?.(text) }
          catch {
            if (!running.exited) write(running, { type: 'reply', id, ok: false, value: 'lead-reply-refused', state: journal.state })
            return
          }
          // The person's Stop can land while the text is scanned. The journal then refuses it, which is the goal
          // ending, not a child that broke the protocol: it must not be killed as one, or cleanup meant for a
          // cancellation would run as a failure and reach work a cancellation leaves alone.
          if (['accepted', 'declined', 'stopped'].includes(journal.state.phase)) break
          try { await durable(journal.appendReply(text)) }
          catch (failure) { if (!['accepted', 'declined', 'stopped'].includes(journal.state.phase)) throw failure }
          break
        }
        case 'resolveTool': value = await this.options.resolveTool(callFrom(args[0])); break
        case 'freezePlan': value = await this.options.freezePlan(parseLeadAcceptanceContract(args[0])); break
        case 'readEvidence': value = await this.options.readEvidence(ipcText(args[0], 256), call =>
          this.#reverse(running, { type: 'read', call })); break
      }
      if (!running.exited) write(running, { type: 'reply', id, ok: true, value: value ?? null, state: journal.state })
    } catch (failure) {
      // The two refusals a child is meant to act on come back as codes; every other failure breaks the protocol.
      const code = (failure as { wireCode?: unknown })?.wireCode
      const coded = operation === 'offerCard' && code === 'lead-card-too-large' ? code
        : operation === 'freezePlan' && (code === 'lead-plan-unseatable' || code === 'lead-plan-not-independent') ? code : null
      if (coded) {
        if (!running.exited) write(running, { type: 'reply', id, ok: false, value: coded, state: journal.state })
        return
      }
      // Treat malformed journal commands as a broken protocol, without returning
      // raw journal/provider errors or allowing a later message to overtake it.
      this.#protocolFailure(running)
    }
  }
  #protocolFailure(running: Running): void {
    if (running.poisoned || running.exited) return
    // A child that speaks after the host began stopping it is being cancelled, not breaking the protocol. The exit
    // keeps the stop's own reason, because the host runs a different cleanup for a failure: one that does not spare
    // work a cancellation leaves alone.
    running.poisoned = true; if (!this.#stopping) running.reason = 'protocol-invalid'
    for (const pending of [...running.pending.values(), ...running.replies.values()]) pending.reject(error('protocol-invalid'))
    running.pending.clear(); running.replies.clear()
    this.#kill(running)
  }
  #kill(running: Running): void { running.providerAbort.abort(); if (!running.exited) { try { running.child.kill('SIGKILL') } catch { /* Exit remains the authority. */ } } }
  async #exit(running: Running): Promise<void> {
    if (running.exited) return
    running.exited = true; running.providerAbort.abort(); running.failReady(error('exited'))
    for (const pending of [...running.pending.values(), ...running.replies.values()]) pending.reject(error(running.reason))
    running.pending.clear(); running.replies.clear()
    // A rejected reverse dispatch must finish writing its uncertain result before
    // the host's recovery hook observes the journal.
    await Promise.allSettled([...running.journalWork])
    this.options.journal.setChildLive(false)
    try { await this.options.onExit?.(running.reason) }
    finally { if (this.#running === running) this.#running = null; running.finish() }
  }
  async send(input: LeadMessagesRequest): Promise<LeadMessagesResult> {
    await this.ensure()
    const running = this.#running
    if (!running || running.exited || this.#stopping) throw error('stopping')
    const id = ++running.id
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<LeadMessagesResult>((resolve, reject) => {
        running.pending.set(id, { resolve: value => resolve(value as LeadMessagesResult), reject })
        timer = setTimeout(() => {
          running.reason = 'lead-send-deadline'
          // Use the same kill/exit path as a wedged or invalid child. Reverse
          // dispatches finish their uncertain records before recovery observes them.
          this.#kill(running)
        }, LEAD_SEND_DEADLINE_MS)
        try { write(running, { type: 'request', id, input }) }
        catch { running.pending.delete(id); reject(error('request-invalid')) }
      })
    } finally { if (timer) clearTimeout(timer) }
  }

  ownershipWithdrawn(runId: string): void {
    const running = this.#running
    if (running && !running.exited && running.ready) { try { write(running, { type: 'ownership-withdrawn', runId: ipcText(runId, 256) }) } catch { this.#protocolFailure(running) } }
  }
  /** Evidence reaches the desk with no run or card event (a check a person ran): the loop reads it again. */
  evidenceChanged(): void {
    const running = this.#running
    if (running && !running.exited && running.ready) { try { write(running, { type: 'evidence-changed' }) } catch { this.#protocolFailure(running) } }
  }
  stop(reason = 'stopped'): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#generation++; this.#startAbort?.abort()
    const stop = async () => {
      const duration = this.options.shutdownMs ?? 1000
      const running = this.#running
      const operation = async () => {
        if (running) {
          if (!running.exited) {
            running.reason = reason
            try { write(running, { type: 'shutdown' }) } catch { this.#kill(running) }
          }
          // An exited pid can still own asynchronous host cleanup/recovery.
          await running.done
        }
        await this.#starting?.catch(() => {})
      }
      const killTimer = setTimeout(() => { if (running) this.#kill(running) }, duration)
      let rejectTimer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectTimer = setTimeout(() => reject(error('shutdown-timeout')), duration * 2)
      })
      try { await Promise.race([operation(), deadline]) }
      finally { clearTimeout(killTimer); if (rejectTimer) clearTimeout(rejectTimer) }
    }
    const work = Promise.resolve().then(stop)
    this.#stopping = work
    void work.finally(() => { if (this.#stopping === work) this.#stopping = null }).catch(() => {})
    return work
  }
}
