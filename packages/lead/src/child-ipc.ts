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
  'recordWake' | 'invalidateResults' | 'offerCard' | 'restoreResult' | 'recoverUnsettledRequests' | 'appendReply'>
export const LEAD_FRAME_BYTES = 1_048_576
/** Prefixes the child's one probe line: what `node:net` said to a loopback connect under the Lead's own flags. */
export const LEAD_PROBE_PREFIX = 'lead-probe '
export const LEAD_RPC_OPERATIONS = ['recordWake', 'execute', 'updateBudget', 'setManagementPhase', 'invalidateResults', 'offerCard',
  'restoreResult', 'recoverUnsettledRequests', 'appendReply', 'resolveTool', 'freezePlan', 'readEvidence', 'provider-send'] as const
export type LeadRpcOperation = typeof LEAD_RPC_OPERATIONS[number]
const fail = (): never => { throw new Error('lead-ipc-invalid') }
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
}
export const parseLeadIpc = (value: unknown): LeadIpcMessage => {
  const object = ipcObject(value), type = ipcText(object.type, 64), selected = fields[type]
  if (object.version !== 1 || !selected) return fail()
  ipcObject(object, ['version', 'type', ...selected])
  if ('id' in object) ipcId(object.id)
  if (type === 'activity' && typeof object.busy !== 'boolean') fail()
  if (type === 'rpc') {
    if (!LEAD_RPC_OPERATIONS.includes(object.operation as LeadRpcOperation) || !Array.isArray(object.args) || object.args.length > 2) fail()
  }
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
