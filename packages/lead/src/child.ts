import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import { connect, type Client } from '@harnessdesk/client'
import { hostVerifiedLocalTransport } from '@harnessdesk/client/node'
import { parseClientMessage, parseLeadPermissionPolicy } from '@harnessdesk/protocol'
import type { LeadChildBootstrap } from './child-ipc.js'
import type { LeadState } from './state.js'
import type { LeadDispatch } from './journal.js'
import type { LeadPermissionCall } from './permissions.js'
import type { LeadAcceptanceEvidence } from './acceptance.js'
import { createLeadLoop, type LeadLoop } from './loop.js'
import { createLeadTools, type LeadResolvedTool } from './tools.js'
import type { LeadMessagesRequest, MessagesTransport } from './messages-types.js'
import { LeadFrameDecoder, encodeLeadFrame, ipcObject, ipcText, type LeadIpcMessage, type LeadJournalPort, type LeadRpcOperation } from './child-ipc.js'

const denied = () => new Error('lead-child-operation-failed')
const transport: MessagesTransport = {
  send: request => new Promise((resolve, reject) => {
    // Fixed provider destination and path, no redirects and a bound while reading.
    const outgoing = httpsRequest({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: request.headers,
      signal: request.signal, timeout: 30_000 }, response => {
      const chunks: Uint8Array[] = []; let bytes = 0
      response.on('data', (chunk: Uint8Array) => {
        bytes += chunk.length
        if (bytes > request.maxResponseBytes) { outgoing.destroy(denied()); return }
        chunks.push(chunk)
      })
      response.once('error', () => reject(denied()))
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8'), status = response.statusCode ?? 0
        const retryAfter = response.headers['retry-after']
        resolve({ status, body, ...(typeof retryAfter === 'string' ? { retryAfter } : {}),
          ...(status === 429 || status === 529 ? { processing: 'not-started' as const } : {}) })
      })
    })
    outgoing.once('timeout', () => outgoing.destroy(denied()))
    outgoing.once('error', () => reject(denied()))
    outgoing.end(request.body)
  }),
}
interface ChildOptions {
  readonly input?: Readable
  readonly output?: Writable
  readonly connectDesk?: (config: LeadChildBootstrap) => Promise<Client>
  readonly onExit?: (code: number) => void
}
const parseBootstrap = (value: unknown): LeadChildBootstrap => {
  const source = ipcObject(value)
  if (Object.keys(source).some(key => !['key', 'descriptor', 'project', 'model', 'prices', 'projectPolicy'].includes(key))) throw denied()
  ipcText(source.key, 8192)
  const descriptor = ipcObject(source.descriptor, ['home', 'pid', 'startedAt', 'hostVersion', 'protocolVersion', 'socketPath'])
  for (const key of ['home', 'hostVersion', 'socketPath']) ipcText(descriptor[key], 4096)
  for (const key of ['pid', 'startedAt', 'protocolVersion']) if (typeof descriptor[key] !== 'number' || !Number.isSafeInteger(descriptor[key]) || (descriptor[key] as number) < 0) throw denied()
  const project = ipcObject(source.project, ['id', 'path']); ipcText(project.id, 256); ipcText(project.path, 4096)
  if (source.model !== undefined) ipcText(source.model, 256)
  const prices = ipcObject(source.prices)
  if (Object.keys(prices).length > 32) throw denied()
  for (const price of Object.values(prices)) {
    const row = ipcObject(price, ['inputUsdMicrosPerMillion', 'outputUsdMicrosPerMillion', 'cacheReadUsdMicrosPerMillion', 'cacheWriteUsdMicrosPerMillion'])
    if (Object.values(row).some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw denied()
  }
  if (source.projectPolicy !== undefined && source.projectPolicy !== null) parseLeadPermissionPolicy(source.projectPolicy)
  return source as unknown as LeadChildBootstrap
}
/** The only child entry. No journal storage is opened: every journal operation
 * and host-derived scope crosses the bounded, validated stdin/stdout port. */
export const runLeadChild = (options: ChildOptions = {}) => {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout
  const exit = options.onExit ?? ((code: number) => process.exit(code))
  let closed = false, initialized = false, client: Client | null = null, loop: LeadLoop | null = null
  let state: LeadState | null = null, rpcId = 0, requestId = 0
  let childProject: LeadChildBootstrap['project'] | null = null
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
            const wire = await hostVerifiedLocalTransport(config.descriptor, { env: {} })
            wire.onClose(() => { if (!closed) send({ type: 'desk-lost' }) })
            return wire
          },
          client: { name: 'Lead', version: '1' } })))(config)
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
        loop = createLeadLoop({ journal, desk, project,
          clock: { now: Date.now, schedule: callback => { const timer = setTimeout(callback, 50); return () => clearTimeout(timer) } },
          nextId: randomUUID, messages: { apiKey: config.key, model: config.model, prices: config.prices, transport,
            countInput: async body => new TextEncoder().encode(body).length + 1024,
            wait: (ms, signal) => new Promise((resolve, reject) => {
              if (signal.aborted) { reject(denied()); return }
              const done = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); resolve() }
              const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(denied()) }
              const timer = setTimeout(done, ms); signal.addEventListener('abort', aborted, { once: true })
            }) },
          resolveTool, freezePlan: async contract => await rpc('freezePlan', [contract]) as typeof contract,
          readEvidence: async runId => await rpc('readEvidence', [runId]) as LeadAcceptanceEvidence })
        send({ type: 'ready' }); void loop.start().catch(fail); return
      }
      case 'state': if (!initialized) throw denied(); sync(message.state); return
      case 'reply': {
        const entry = pending.get(message.id as number)
        if (!entry) throw denied()
        pending.delete(message.id as number); sync(message.state)
        if (message.ok) entry.resolve(message.value); else entry.reject(denied())
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
        ipcObject(message.input, Object.hasOwn(ipcObject(message.input), 'system') ? ['messages', 'maxTokens', 'system'] : ['messages', 'maxTokens'])
        const result = await loop.request(message.input as unknown as LeadMessagesRequest)
        if (loop.state.reason === 'lead-connection-ended') send({ type: 'desk-lost' })
        else send({ type: 'response', id: message.id, result: result ?? { status: 'refused', reason: 'lead-management-paused' } })
        return
      }
      case 'ownership-withdrawn':
        if (!loop) throw denied()
        send({ type: 'wait-ended', runId: message.runId, reason: 'ownership-withdrawn' })
        await close(); exit(0); return
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
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Never let an unhandled provider/runtime stack expose its key on stderr.
  process.on('uncaughtException', () => process.exit(1))
  process.on('unhandledRejection', () => process.exit(1))
  runLeadChild()
}
