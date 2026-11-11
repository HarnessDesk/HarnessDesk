import type { LeadProject, LeadPermissionPolicy } from '@harnessdesk/protocol'
import type { MessagesPrice } from './messages-types.js'
import type { LeadJournal } from './journal.js'
import type { LeadSeatChoices } from './instructions.js'

export interface LeadChildBootstrap {
  readonly key: string
  readonly descriptor: { readonly home: string; readonly pid: number; readonly startedAt: number; readonly hostVersion: string; readonly protocolVersion: number; readonly socketPath: string }
  readonly project: LeadProject
  readonly model?: string
  readonly projectPolicy?: LeadPermissionPolicy | null
  readonly prices: Readonly<Record<string, MessagesPrice>>
  /** What a plan's assignments may name. Absent means the desk offers no seat. */
  readonly seats?: LeadSeatChoices
  /** The lines the person kept for the Lead between goals, in their order; plans cite them as [m1], [m2]. */
  readonly memory?: readonly string[]
}

export type LeadChildConfig = Omit<LeadChildBootstrap, 'key' | 'descriptor'>

/** This is a port, not another journal writer. Human decisions and recovery are
 * deliberately absent; all methods execute in the host's serialized journal. */
export type LeadJournalPort = Pick<LeadJournal, 'state' | 'execute' | 'updateBudget' | 'setManagementPhase' |
  'recordWake' | 'invalidateResults' | 'offerCard' | 'restoreResult' | 'recoverUnsettledRequests' | 'appendReply' | 'memoryEpoch'>
export const LEAD_FRAME_BYTES = 1_048_576
/** Prefixes the child's one probe line: what `node:net` said to a loopback connect under the Lead's own flags. */
export const LEAD_PROBE_PREFIX = 'lead-probe '
export const LEAD_RPC_OPERATIONS = ['recordWake', 'execute', 'updateBudget', 'setManagementPhase', 'invalidateResults', 'offerCard',
  'restoreResult', 'recoverUnsettledRequests', 'appendReply', 'resolveTool', 'freezePlan', 'readEvidence', 'provider-send',
  'recordContext', 'readContext', 'compactContext', 'memoryEpoch', 'readMemoryStatus'] as const
export type LeadRpcOperation = typeof LEAD_RPC_OPERATIONS[number]
/** How many arguments each operation carries, fewest and most. The frame check and the host's dispatch both read this
 * one table, so an operation can never pass one and break the other: `memoryEpoch` once carried three arguments past a
 * frame check that allowed two, and the host stopped the child on every new epoch (#2085). */
export const LEAD_RPC_ARGS: Readonly<Record<LeadRpcOperation, readonly [number, number]>> = {
  recordWake: [1, 1], execute: [1, 1], updateBudget: [1, 1], setManagementPhase: [2, 2], invalidateResults: [0, 0], offerCard: [1, 1],
  restoreResult: [2, 2], recoverUnsettledRequests: [0, 0], appendReply: [1, 4], resolveTool: [1, 1], freezePlan: [1, 1], readEvidence: [1, 1],
  'provider-send': [2, 3], recordContext: [1, 1], readContext: [1, 1], compactContext: [1, 1], memoryEpoch: [3, 3], readMemoryStatus: [0, 0],
}
export const leadRpcArgsFit = (operation: LeadRpcOperation, count: number): boolean =>
  count >= LEAD_RPC_ARGS[operation][0] && count <= LEAD_RPC_ARGS[operation][1]
const fail = (stage?: string): never => { throw Object.assign(new Error('lead-ipc-invalid'), stage ? { stage } : {}) }
/** Where the child's loop catches a failure and carries on. A `failure` frame names one of these, or it is dropped. */
export const LEAD_CHILD_FAILURE_STAGES = ['memoryEpoch', 'messages', 'appendReply', 'settleStarts', 'activity', 'subscribe'] as const
export type LeadChildFailureStage = typeof LEAD_CHILD_FAILURE_STAGES[number]
/** The shapes a logged code may take: a `lead-…` code, a system code (`ENOENT`) or a class name. Nothing with a space. */
const LEAD_CODE = /^lead-[a-z0-9-]{1,60}$/, SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,40}$/, CLASS_NAME = /^[A-Za-z]{1,40}$/
export const leadFailureCodeValid = (value: unknown): value is string =>
  typeof value === 'string' && (LEAD_CODE.test(value) || SYSTEM_CODE.test(value) || CLASS_NAME.test(value))
/**
 * What a log may say about a caught failure: its wire code, its `lead-…` message, a system code (`ENOENT`) or its
 * class name, in that order. Never a free-form message, which can carry a path, a key or the person's words. What it
 * returns always passes `leadFailureCodeValid`, so a child's own report never fails the host's check.
 */
export const leadFailureCode = (failure: unknown): string => {
  const object = failure && typeof failure === 'object' ? failure as { wireCode?: unknown; message?: unknown; code?: unknown; name?: unknown } : {}
  if (typeof object.wireCode === 'string' && LEAD_CODE.test(object.wireCode)) return object.wireCode
  if (typeof object.message === 'string' && LEAD_CODE.test(object.message)) return object.message
  if (typeof object.code === 'string' && SYSTEM_CODE.test(object.code)) return object.code
  if (typeof object.name === 'string' && CLASS_NAME.test(object.name)) return object.name
  return 'unknown'
}
export const ipcObject = (value: unknown, fields?: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const object = value as Record<string, unknown>
  if (fields && (Object.keys(object).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(object, key)))) return fail()
  return object
}
export const ipcId = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail()
export const ipcText = (value: unknown, max = 16384): string => typeof value === 'string' && value.length > 0 && value.length <= max ? value : fail()
/** Private framed transport; never send these envelopes to logs or a renderer. */
export interface LeadIpcMessage { readonly version: 1; readonly type: string; readonly [key: string]: unknown }
const fields: Readonly<Record<string, readonly string[]>> = {
  initialize: ['config', 'state'], ready: [], request: ['id', 'input'], response: ['id', 'result'],
  rpc: ['id', 'operation', 'args'], reply: ['id', 'ok', 'value', 'state'],
  dispatch: ['id', 'rpcId', 'call', 'correlationId'], 'dispatch-result': ['id', 'ok', 'value'],
  read: ['id', 'call'], 'read-result': ['id', 'ok', 'value'], state: ['state'],
  shutdown: [], 'desk-lost': [], 'ownership-withdrawn': ['runId'], 'evidence-changed': [], 'wait-ended': ['runId', 'reason'], presence: ['presence'], activity: ['busy'],
  // A failure the child caught and carried on from, for the host log: where it happened and its code, never content.
  failure: ['stage', 'code'],
}
export const parseLeadIpc = (value: unknown): LeadIpcMessage => {
  const object = ipcObject(value), type = ipcText(object.type, 64), selected = fields[type]
  if (object.version !== 1 || !selected) return fail()
  ipcObject(object, ['version', 'type', ...selected])
  if ('id' in object) ipcId(object.id)
  if (type === 'activity' && typeof object.busy !== 'boolean') fail()
  if (type === 'rpc') {
    if (!LEAD_RPC_OPERATIONS.includes(object.operation as LeadRpcOperation)) fail('rpc')
    const operation = object.operation as LeadRpcOperation
    if (!Array.isArray(object.args) || !leadRpcArgsFit(operation, object.args.length)) fail(`rpc ${operation}`)
  }
  // A diagnostic never owns the child: a `failure` frame whose stage or code is not a known name is dropped by the host,
  // never treated as a broken protocol. Only its envelope is checked here.
  if (['reply', 'dispatch-result', 'read-result'].includes(type) && typeof object.ok !== 'boolean') fail()
  if (type === 'dispatch') { ipcId(object.rpcId); ipcText(object.correlationId, 256) }
  if (type === 'ownership-withdrawn' || type === 'wait-ended') ipcText(object.runId, 256)
  if (type === 'wait-ended' && object.reason !== 'ownership-withdrawn') fail()
  return object as LeadIpcMessage
}
export const encodeLeadFrame = (value: unknown): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(value, (_key, item: unknown) => item instanceof Map ? { $leadMap: [...item] } : item))
  if (body.length === 0 || body.length > LEAD_FRAME_BYTES) return fail()
  const frame = new Uint8Array(body.length + 4)
  new DataView(frame.buffer).setUint32(0, body.length); frame.set(body, 4); return frame
}
/** Bounded before parsing, including a peer that never finishes its frame. */
export class LeadFrameDecoder {
  #pending = new Uint8Array(0)
  push(chunk: Uint8Array, receive: (value: LeadIpcMessage) => void): void {
    let offset = 0
    while (offset < chunk.length) {
      const wanted = this.#pending.length < 4 ? 4 : 4 + new DataView(this.#pending.buffer, this.#pending.byteOffset, 4).getUint32(0)
      const take = Math.min(chunk.length - offset, wanted - this.#pending.length)
      const next = new Uint8Array(this.#pending.length + take); next.set(this.#pending); next.set(chunk.subarray(offset, offset + take), this.#pending.length)
      this.#pending = next; offset += take
      if (next.length < 4) continue
      const size = new DataView(next.buffer).getUint32(0)
      if (size === 0 || size > LEAD_FRAME_BYTES) return fail()
      if (next.length < size + 4) continue
      const body = next.subarray(4); this.#pending = new Uint8Array(0)
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body), (_key, item: unknown) => {
        if (item && typeof item === 'object' && Object.keys(item).length === 1 && '$leadMap' in item) {
          if (!Array.isArray(item.$leadMap) || item.$leadMap.some(pair => !Array.isArray(pair) || pair.length !== 2)) return fail()
          return new Map(item.$leadMap as [unknown, unknown][])
        }
        return item
      })
      receive(parseLeadIpc(value))
    }
  }
}
