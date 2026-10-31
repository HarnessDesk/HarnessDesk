import { Socket } from 'node:net'
import DeskWebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import { connect, type Client, type ClientTransport } from '@harnessdesk/client'
import { parseClientMessage, parseLeadPermissionPolicy, type HostToClient } from '@harnessdesk/protocol'
import type { LeadChildConfig } from './child-ipc.js'
import type { LeadState } from './state.js'
import type { LeadDispatch } from './journal.js'
import type { LeadPermissionCall } from './permissions.js'
import type { LeadAcceptanceEvidence } from './acceptance.js'
import { createLeadLoop, type LeadLoop } from './loop.js'
import { leadBudgetProjection } from './budget.js'
import { parseLeadSeatChoices } from './instructions.js'
import { createLeadTools, type LeadResolvedTool } from './tools.js'
import type { LeadMessagesRequest, MessagesTransport } from './messages-types.js'
import { LEAD_PROBE_PREFIX, LeadFrameDecoder, encodeLeadFrame, ipcObject, ipcText, type LeadIpcMessage, type LeadJournalPort, type LeadRpcOperation } from './child-ipc.js'

const denied = () => new Error('lead-child-operation-failed')
/** The socket the host connected, asked for once over the IPC channel and received as a handle; the channel
 * then closes. Node 26 refuses `new Socket({ fd: 3 })` without a network grant, and accepts a passed handle. */
const receiveDeskSocket = () => new Promise<Socket>((resolve, reject) => {
  if (!process.send || !process.connected) { reject(denied()); return }
  const timer = setTimeout(() => { done(); reject(denied()) }, 5000)
  const done = () => { clearTimeout(timer); process.off('message', received); if (process.connected) process.disconnect?.() }
  const received = (message: unknown, handle: unknown) => {
    done()
    if (handle instanceof Socket && (message as { type?: unknown } | null)?.type === 'desk') resolve(handle)
    else { if (handle instanceof Socket) handle.destroy(); reject(denied()) }
  }
  process.on('message', received)
  process.send({ type: 'desk' })
})
/** No path, discovery or fresh connect exists in the child. ws performs its
 * HTTP upgrade over the socket the host connected and handed over. */
const inheritedDeskTransport = async (): Promise<ClientTransport> => {
  const socket = await receiveDeskSocket()
  const ws = new DeskWebSocket('ws://lead.invalid/client', { createConnection: () => socket, handshakeTimeout: 5000 })
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', () => reject(denied())) })
  const messages = new Set<(message: HostToClient) => void>(), closes = new Set<() => void>()
  ws.on('message', raw => {
    try {
      const value = JSON.parse(raw.toString()) as HostToClient
      if (!value || typeof value !== 'object') throw denied()
      for (const listener of messages) listener(value)
    } catch { ws.close(1002, 'invalid message') }
  })
  ws.on('close', () => { for (const listener of closes) listener() })
  ws.on('error', () => ws.terminate())
  return { send: message => ws.send(JSON.stringify(message)), close: () => ws.close(),
    onMessage: listener => { messages.add(listener); return () => { messages.delete(listener) } },
    onClose: listener => { closes.add(listener); return () => { closes.delete(listener) } } }
}
interface ChildOptions {
  readonly input?: Readable
  readonly output?: Writable
  readonly connectDesk?: (config: LeadChildConfig) => Promise<Client>
  readonly onExit?: (code: number) => void
}
const parseBootstrap = (value: unknown): LeadChildConfig => {
  const source = ipcObject(value)
  if (Object.keys(source).some(key => !['key', 'descriptor', 'project', 'model', 'prices', 'projectPolicy', 'seats', 'memory'].includes(key))) throw denied()
  const project = ipcObject(source.project, ['id', 'path']); ipcText(project.id, 256); ipcText(project.path, 4096)
  if (source.model !== undefined) ipcText(source.model, 256)
  const prices = ipcObject(source.prices)
  if (Object.keys(prices).length > 32) throw denied()
  for (const price of Object.values(prices)) {
    const row = ipcObject(price, ['inputUsdMicrosPerMillion', 'outputUsdMicrosPerMillion', 'cacheReadUsdMicrosPerMillion', 'cacheWriteUsdMicrosPerMillion'])
    if (Object.values(row).some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw denied()
  }
  if (source.projectPolicy !== undefined && source.projectPolicy !== null) parseLeadPermissionPolicy(source.projectPolicy)
  if (source.seats !== undefined) source.seats = parseLeadSeatChoices(source.seats)
  if (source.memory !== undefined) {
    if (!Array.isArray(source.memory) || source.memory.length > 100) throw denied()
    for (const line of source.memory) ipcText(line, 400)
  }
  // Legacy in-process fixtures may supply host bootstrap fields. Never retain
  // those fields in the memory-visible child configuration.
  const { key: _key, descriptor: _descriptor, ...config } = source
  return config as unknown as LeadChildConfig
}
/** The only child entry. No journal storage is opened: every journal operation
 * and host-derived scope crosses the bounded, validated stdin/stdout port. */
const spendKnown = (state: LeadState | null) => !!state?.budget && leadBudgetProjection(state.budget, Date.now()).spend === 'known'

export const runLeadChild = (options: ChildOptions = {}) => {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout
  const exit = options.onExit ?? ((code: number) => process.exit(code))
  let closed = false, initialized = false, client: Client | null = null, loop: LeadLoop | null = null
  let state: LeadState | null = null, rpcId = 0, requestId = 0
  let childProject: LeadChildConfig['project'] | null = null
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; dispatch?: LeadDispatch; request?: unknown; attemptId?: string; dispatched?: boolean }>()
  const send = (message: Omit<LeadIpcMessage, 'version'>) => { if (!closed) output.write(encodeLeadFrame({ version: 1, ...message })) }
  const sync = (value: unknown) => {
    const next = ipcObject(value) as unknown as LeadState
    if (!(next.attempts instanceof Map) || !Number.isSafeInteger(next.seq) || next.seq < 0) throw denied()
    if (!state || next.seq >= state.seq) state = next
  }
  const rpc = (operation: LeadRpcOperation, args: unknown[], dispatch?: LeadDispatch): Promise<unknown> => {
    if (closed) return Promise.reject(denied())
    const id = ++rpcId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, dispatch, request: operation === 'execute' ? ipcObject(args[0]).request : undefined,
        attemptId: operation === 'execute' ? ipcText(ipcObject(args[0]).id, 256) : undefined, dispatched: false })
      try { send({ type: 'rpc', id, operation, args }) }
      catch { pending.delete(id); reject(denied()) }
    })
  }
  const journal: LeadJournalPort = {
    get state() { if (!state) throw denied(); return structuredClone(state) },
    execute: (attempt, dispatch) => rpc('execute', [attempt], dispatch) as ReturnType<LeadJournalPort['execute']>,
    updateBudget: event => rpc('updateBudget', [event]) as ReturnType<LeadJournalPort['updateBudget']>,
    setManagementPhase: async (phase, reason = null) => { await rpc('setManagementPhase', [phase, reason]) },
    invalidateResults: async () => { await rpc('invalidateResults', []) },
    offerCard: card => rpc('offerCard', [card]) as ReturnType<LeadJournalPort['offerCard']>,
    restoreResult: async (id, revision) => { await rpc('restoreResult', [id, revision]) },
    recoverUnsettledRequests: async () => { await rpc('recoverUnsettledRequests', []) },
    recordWake: async wake => { await rpc('recordWake', [wake]) },
    appendReply: async (text, proactive) => { await rpc('appendReply', proactive ? [text, proactive] : [text]) },
  }
  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    input.off('data', receive)
    for (const entry of pending.values()) entry.reject(denied())
    pending.clear()
    client?.close()
    closing = Promise.resolve(loop?.close()).catch(() => {})
    return closing
  }
  const fail = () => { if (!closed) void close().finally(() => exit(1)) }
  const complete = async (message: LeadIpcMessage) => {
    switch (message.type) {
      case 'initialize': {
        if (initialized) throw denied()
        initialized = true
        const config = parseBootstrap(message.config); sync(message.state)
        client = await (options.connectDesk ?? (config => connect({ transport: async () => {
            const wire = await inheritedDeskTransport()
            wire.onClose(() => { if (!closed) send({ type: 'desk-lost' }) })
            return wire
          },
          rawNotifications: false, client: { name: 'Lead', version: '1' } })))(config)
        if (closed) { client.close(); return }
        const project = config.project; childProject = project
        const resolveTool = async (call: LeadPermissionCall): Promise<LeadResolvedTool> => await rpc('resolveTool', [call]) as LeadResolvedTool
        const desk = { call: client.call, synced: client.synced, snapshot: client.snapshot, events: () => ({
          async *[Symbol.asyncIterator]() {
            for await (const event of client!.events()) {
              if (!closed && (event.type === 'end' || event.type === 'gap' && event.reason === 'disconnected')) send({ type: 'desk-lost' })
              yield event
            }
          },
        }) }
        loop = createLeadLoop({ journal, desk, project, ...(config.seats ? { seats: config.seats } : {}), ...(config.memory?.length ? { memory: config.memory } : {}),
          onActivity: busy => { if (!closed) send({ type: 'activity', busy }) },
          onPresence: ({ wakes, readings }) => { if (!closed) send({ type: 'presence', presence: { ...wakes, readings } }) },
          clock: { now: Date.now, schedule: callback => { const timer = setTimeout(callback, 50); return () => clearTimeout(timer) } },
          nextId: randomUUID, messages: { apiKey: 'host-owned-provider-key', model: config.model, prices: config.prices, transport: { send: request => rpc('provider-send', [request.requestId, request.body]) as ReturnType<MessagesTransport['send']> }, // hd-secrets-ok: public marker; the host adds the real header
            countInput: async body => new TextEncoder().encode(body).length + 1024,
            wait: (ms, signal) => new Promise((resolve, reject) => {
              if (signal.aborted) { reject(denied()); return }
              const done = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); resolve() }
              const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(denied()) }
              const timer = setTimeout(done, ms); signal.addEventListener('abort', aborted, { once: true })
            }) },
          resolveTool, freezePlan: async contract => await rpc('freezePlan', [contract]) as typeof contract,
          readEvidence: async runId => await rpc('readEvidence', [runId]) as LeadAcceptanceEvidence })
        // A run that goes quiet sends no event; a minute's tick lets the gate call it stuck. It costs no request unless it is.
        setInterval(() => { if (!closed) loop?.poke() }, 60_000).unref()
        send({ type: 'ready' }); void loop.start().catch(fail); return
      }
      case 'state': {
        if (!initialized) throw denied()
        const fenced = !spendKnown(state)
        sync(message.state)
        // A reading the host freshened while the loop was fenced on spend comes with no desk event to wake it.
        if (fenced && spendKnown(state)) void loop?.refresh().catch(() => {})
        return
      }
      case 'reply': {
        const entry = pending.get(message.id as number)
        if (!entry) throw denied()
        pending.delete(message.id as number); sync(message.state)
        if (message.ok) entry.resolve(message.value)
        else entry.reject(['lead-card-too-large', 'lead-card-stale', 'lead-plan-unseatable', 'lead-plan-not-independent', 'lead-budget-admission'].includes(message.value as string)
          ? Object.assign(new Error(String(message.value)), { wireCode: message.value }) : denied())
        return
      }
      case 'dispatch': {
        const entry = pending.get(message.rpcId as number)
        if (!entry?.dispatch || entry.dispatched) throw denied()
        entry.dispatched = true
        const call = ipcObject(message.call, ['method', 'params']), original = ipcObject(entry.request)
        const parsed = parseClientMessage({ id: 1, method: call.method, params: call.params })
        const expected = parseClientMessage({ id: 1, method: original.method, params: original.params })
        if (message.correlationId !== entry.attemptId ||
          JSON.stringify(parsed) !== JSON.stringify(expected)) throw denied()
        try { send({ type: 'dispatch-result', id: message.id, ok: true, value: await entry.dispatch({ method: parsed.method, params: parsed.params } as LeadPermissionCall, ipcText(message.correlationId, 256)) }) }
        catch { send({ type: 'dispatch-result', id: message.id, ok: false, value: null }) }
        return
      }
      case 'read': {
        if (!loop || !client) throw denied()
        const call = ipcObject(message.call, ['method', 'params'])
        const parsed = parseClientMessage({ id: 1, method: call.method, params: call.params })
        const tools = createLeadTools({ journal, desk: client, project: childProject!,
          now: Date.now, nextId: randomUUID, synchronized: () => loop!.state.synchronized,
          resolveTool: async call => await rpc('resolveTool', [call]) as LeadResolvedTool })
        try { const result = await tools.execute({ method: parsed.method, params: parsed.params } as LeadPermissionCall)
          if (result.outcome !== 'succeeded') throw denied()
          send({ type: 'read-result', id: message.id, ok: true, value: result.value ?? null })
        } catch { send({ type: 'read-result', id: message.id, ok: false, value: null }) }
        return
      }
      case 'request': {
        if (!loop || (message.id as number) <= requestId) throw denied()
        requestId = message.id as number
        const input = ipcObject(message.input)
        ipcObject(input, ['messages', 'maxTokens', ...(['system', 'proactive', 'conversation', 'wakeSource'] as const).filter(key => Object.hasOwn(input, key))])
        if (input.wakeSource !== undefined && !['schedule', 'desk-change', 'person', 'trigger'].includes(String(input.wakeSource))) throw denied()
        if (input.proactive !== undefined && typeof input.proactive !== 'boolean') throw denied()
        if (input.conversation !== undefined && typeof input.conversation !== 'boolean') throw denied()
        const result = await loop.request(message.input as unknown as LeadMessagesRequest)
        if (loop.state.reason === 'lead-connection-ended') send({ type: 'desk-lost' })
        else send({ type: 'response', id: message.id, result: result ?? { status: 'refused', reason: 'lead-management-paused' } })
        return
      }
      case 'ownership-withdrawn':
        if (!loop) throw denied()
        send({ type: 'wait-ended', runId: message.runId, reason: 'ownership-withdrawn' })
        await close(); exit(0); return
      case 'evidence-changed':
        if (!loop) throw denied()
        loop.refreshSoon(); return
      case 'shutdown': await close(); exit(0); return
      default: throw denied()
    }
  }
  const decoder = new LeadFrameDecoder()
  function receive(chunk: Uint8Array) {
    if (closed) return
    try { decoder.push(chunk, message => { void complete(message).catch(fail) }) } catch { fail() }
  }
  input.on('data', receive)
  input.once('end', () => { if (!closed) fail() })
  input.once('error', fail)
  output.once('error', fail)
  return { close }
}
/** The supervisor's capability probe: with its whole module graph loaded under the Lead's flags, the child reports
 * what a loopback connect to the prober's port gets. A permission model that blocks the network refuses it with
 * ERR_ACCESS_DENIED before any packet leaves. */
const answerLeadProbe = (port: number) => {
  const report = (outcome: string) => {
    process.stdout.write(`${LEAD_PROBE_PREFIX}${JSON.stringify({ version: process.version, outcome })}\n`, () => process.exit(0))
  }
  try {
    const socket = new Socket()
    socket.once('connect', () => { socket.destroy(); report('connected') })
    socket.once('error', (error: NodeJS.ErrnoException) => report(error.code ?? 'error'))
    socket.connect({ host: '127.0.0.1', port })
  } catch (error) { report((error as NodeJS.ErrnoException).code ?? 'error') }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Never let an unhandled provider/runtime stack expose its key on stderr.
  process.on('uncaughtException', () => process.exit(1))
  process.on('unhandledRejection', () => process.exit(1))
  if (process.argv[2] === 'probe') answerLeadProbe(Number(process.argv[3]))
  else runLeadChild()
}
