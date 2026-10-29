import type { LeadJournalPort } from './child-ipc.js'
import { CLIENT_METHODS, clientTierFor, parseClientMessage, type ClientMethodName, type LeadProject, type ClientTopic } from '@harnessdesk/protocol'
import type { ClientSnapshot } from '@harnessdesk/client'
import type { LeadDispatchResult } from './journal.js'
import type { LeadPermissionCall } from './permissions.js'
import type { LeadDeskPort } from './ports.js'
import type { MessagesToolUse, MessagesToolScope } from './messages-types.js'
import { leadRoundId } from './budget.js'
import { leadReviewedResultSource } from './recipes/reviewed-result.js'

export class LeadToolRefusedError extends Error { constructor() { super('lead-tool-refused') } }
export class LeadToolFencedError extends Error { constructor() { super('lead-tool-fenced') } }
const fail = (): never => { throw new LeadToolRefusedError() }
const object = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail()
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !allowed.includes(key))) return fail()
  return item
}
const textSchema = { type: 'string', maxLength: 16_384 }
const pathSchema = { type: 'string', maxLength: 4096 }
const schema = (properties: Record<string, unknown>, required: readonly string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const flowProperties = { root: pathSchema, source: textSchema, vars: { type: 'object', additionalProperties: textSchema },
  seats: { type: 'object' }, attended: { type: 'boolean' } }
/** Closed aliases, not a slash-to-underscore transform of arbitrary method names.
 * No provider-hosted, file, shell, edit, answer or publication tool is offered. */
export const LEAD_TOOLS = {
  chat_list: { method: 'lead/chat/list', input_schema: schema({ cursor: { type: 'string', maxLength: 300 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }) },
  chat_read: { method: 'lead/chat/read', input_schema: schema({ id: { type: 'string', maxLength: 300 } }, ['id']) },
  chat_start: { method: 'lead/chat/start', input_schema: schema({ text: textSchema }, ['text']) },
  chat_send: { method: 'lead/chat/send', input_schema: schema({ id: { type: 'string', maxLength: 300 }, text: textSchema }, ['id', 'text']) },
  chat_stop: { method: 'lead/chat/stop', input_schema: schema({ id: { type: 'string', maxLength: 300 } }, ['id']) },
  flow_catalog: { method: 'flow/catalog', input_schema: schema({ root: pathSchema }, ['root']) },
  flow_source: { method: 'flow/source', input_schema: schema({ root: pathSchema, id: textSchema,
    origin: { type: 'string', enum: ['project', 'user', 'builtin'] } }, ['root', 'id']) },
  flow_preview: { method: 'flow/preview', input_schema: schema(flowProperties, ['root', 'source']) },
  flow_start_goal: { method: 'flow/start-goal', input_schema: schema({ ...flowProperties, token: textSchema, sentence: textSchema }, ['root', 'source', 'token', 'sentence']) },
  flow_execution: { method: 'flow/execution', input_schema: schema({ run: textSchema }, ['run']) },
  flow_execution_stop: { method: 'flow/execution/stop', input_schema: schema({ run: textSchema, reason: textSchema }, ['run', 'reason']) },
  flow_executions: { method: 'flow/executions', input_schema: schema({ team: textSchema, project: pathSchema, active: { type: 'boolean' } }) },
  goal_list: { method: 'goal/list', input_schema: schema({ root: pathSchema }) },
  goal_read: { method: 'goal/read', input_schema: schema({ goal: textSchema }, ['goal']) },
  insight_goal: { method: 'insight/goal', input_schema: schema({ goal: textSchema }, ['goal']) },
  evidence_board: { method: 'evidence/board', input_schema: schema({ room: textSchema }, ['room']) },
  evidence_seat: { method: 'evidence/seat', input_schema: schema({ runtime: textSchema, sessionId: textSchema }, ['runtime', 'sessionId']) },
  library_usage: { method: 'library/usage', input_schema: schema({}) },
} as const satisfies Record<string, { method: ClientMethodName; input_schema: unknown }>
export const leadToolDefinitions = Object.entries(LEAD_TOOLS).map(([name, tool]) => ({ name, description: name === 'chat_read' ? 'Read a bounded recent chat view; omittedSourceTurns counts raw source turns and omittedPhoneEntries counts projected phone entries. truncated also covers shortened text.' : `Desk operation ${tool.method}`, input_schema: tool.input_schema }))
export const parseLeadToolCall = (block: MessagesToolUse): LeadPermissionCall => {
  if (!Object.hasOwn(LEAD_TOOLS, block.name)) return fail()
  const tool = LEAD_TOOLS[block.name as keyof typeof LEAD_TOOLS]
  if (!Object.hasOwn(CLIENT_METHODS, tool.method) || clientTierFor(tool.method, block.input) === 'answer') return fail()
  const input = object(block.input, Object.keys(tool.input_schema.properties))
  const parsed = parseClientMessage({ id: 1, method: tool.method, params: input })
  return { method: tool.method, params: parsed.params } as LeadPermissionCall
}

export const LEAD_TOPICS: readonly ClientTopic[] = Object.freeze(['runs', 'cards', 'teams', 'waiting', 'notices', 'seats', 'reviews', 'chats'])
/** Trusted host facts: never filled from model-provided source, token or scope claims. */
export interface LeadResolvedTool extends MessagesToolScope {
  readonly preview?: { readonly token: string; readonly source: string; readonly expiresAt: number }
}
export interface LeadToolsOptions {
  readonly journal: LeadJournalPort
  readonly desk: LeadDeskPort
  readonly project: LeadProject
  readonly now: () => number
  readonly nextId: () => string
  readonly synchronized: () => boolean
  readonly resolveTool: (call: LeadPermissionCall) => Promise<LeadResolvedTool>
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item) === JSON.stringify(b, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
/** Same guard used by Messages and trusted loop reads. The host still rechecks its
 * preview at redemption in step 8; a child-side check is not that boundary. */
export const createLeadTools = (options: LeadToolsOptions) => {
  const { journal, desk, project, nextId, synchronized, resolveTool } = options
  const now = options.now
  const pending = new Map<string, { goalId: string; executionId: string; firstRoundId: string }>()
  const resolve = async (call: LeadPermissionCall): Promise<MessagesToolScope> => {
    if (clientTierFor(call.method, call.params) === 'run' && !synchronized()) throw new LeadToolFencedError()
    let scope: LeadResolvedTool
    try { scope = structuredClone(await resolveTool(call)) } catch { return fail() }
    const params = call.params as Record<string, unknown>
    if (clientTierFor(call.method, call.params) === 'run' && !synchronized()) throw new LeadToolFencedError()
    if (call.method === 'flow/preview' || call.method === 'flow/start-goal') {
      if (params.source !== leadReviewedResultSource) fail()
    }
    if (call.method === 'flow/start-goal') {
      const state = journal.state, step = state.contract?.steps.find(step => step.id === scope.stepId)
      if (!state.contract || !state.consent || state.consent.expiresAt <= now() ||
        state.consent.contractDigest !== state.contract.digest || !same(state.contract.project, project) ||
        !step || step.flow !== 'lead-reviewed-result' || step.sourceRevision !== 'recipe-1' || !same(step, scope.start) ||
        !scope.preview || !Number.isSafeInteger(scope.preview.expiresAt) || scope.preview.expiresAt <= now() ||
        scope.preview.token !== params.token || scope.preview.source !== params.source) fail()
    }
    return { ...scope, context: { ...scope.context, now: now() } }
  }
  const dispatch = async (call: LeadPermissionCall, correlationId: string, signal?: AbortSignal): Promise<LeadDispatchResult> => {
    if (signal?.aborted) fail()
    // A gap or changed preview may arrive during permission resolution/journal I/O.
    await resolve(call)
    if (signal?.aborted) fail()
    if (clientTierFor(call.method, call.params) === 'run' && !synchronized()) throw new LeadToolFencedError()
    const value = await desk.call(call.method, call.params as never)
    if (call.method !== 'flow/start-goal') return { value, identity: null }
    const run = value as { id: string; goal: string; rounds: readonly { n: number }[] }
    if (!run || typeof run.id !== 'string' || typeof run.goal !== 'string' || !Number.isSafeInteger(run.rounds?.[0]?.n)) fail()
    pending.set(correlationId, { goalId: run.goal, executionId: run.id, firstRoundId: leadRoundId(run.id, run.rounds[0]!.n) })
    return { value, identity: { correlationId, runId: run.id, teamId: run.goal } }
  }
  const settleStarts = async (): Promise<void> => {
    for (const [startId, binding] of pending) {
      if (journal.state.runs.some(run => run.correlationId === startId && run.runId === binding.executionId)) {
        await journal.updateBudget({ version: 1, type: 'bind', now: now(), startId, ...binding })
        pending.delete(startId)
      }
    }
  }
  const execute = async (call: LeadPermissionCall) => {
    const scope = await resolve(call)
    const result = await journal.execute({ id: nextId(), request: { method: call.method, params: call.params,
      project: scope.project, runId: scope.runId, start: scope.start }, context: scope.context, stepId: scope.stepId, predecessor: scope.predecessor }, dispatch)
    await settleStarts()
    return result
  }
  return { resolveTool: resolve, dispatch, execute, settleStarts }
}
export type LeadTools = ReturnType<typeof createLeadTools>
/** Relay coordinates refer to the existing approval surface. There is deliberately
 * no LeadCard/LeadCardDecision here: only the authenticated window can answer it. */
export const leadWorkerApprovalRelay = (item: NonNullable<ClientSnapshot['waiting']>[number]) => {
  if (item.kind !== 'approval') return fail()
  return { kind: 'worker-approval' as const, surface: 'approvals' as const, approvalId: item.id,
    teamId: item.team, seatId: item.seat ?? null, summary: item.summary }
}
