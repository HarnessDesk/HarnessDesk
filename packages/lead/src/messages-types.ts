import type { LeadJournalPort } from './child-ipc.js'
import type { LeadAcceptanceContract, LeadCard, LeadProject, LeadPlanStep } from '@harnessdesk/protocol'
import type { LeadDispatch } from './journal.js'
import type { LeadPermissionCall, LeadPermissionContext } from './permissions.js'

/** Provider dialect is private to this package; no provider SDK escapes into protocol. */
export interface MessagesText { readonly type: 'text'; readonly text: string }
export interface MessagesToolUse { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
export interface MessagesToolResult { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error: boolean }
export interface MessagesTurn {
  readonly role: 'user' | 'assistant'
  readonly content: readonly (MessagesText | MessagesToolUse | MessagesToolResult)[]
}
export interface LeadMessagesRequest {
  readonly messages: readonly MessagesTurn[]
  /** The owner may request structured text using
   * { version: 1, type: 'lead-output', text?, plan?, cards? }.
   * Those proposals are validated and returned without offering or executing them. */
  readonly system?: string
  readonly maxTokens: number
}
export interface MessagesUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}
export interface MessagesHttpRequest {
  readonly requestId: string
  readonly origin: 'https://api.anthropic.com'
  readonly path: '/v1/messages'
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly maxResponseBytes: number
  readonly signal: AbortSignal
}
export interface MessagesHttpResponse {
  readonly status: number
  readonly body: string
  readonly retryAfter?: string
  /** Trusted transport evidence, never parsed from model text. Assert 'not-started' only
   * for a 4xx or 529 the provider refused before any processing: a rate limit is then
   * retried, any other 4xx zero-settles as failed. Missing evidence means billing is unknown. */
  readonly processing?: 'not-started' | 'unknown'
}
export interface MessagesTransport {
  /** Enforce maxResponseBytes while reading, disable redirects, and reject on timeout
   * or abort. Rejections after invocation conservatively mean possibly billed. */
  send(request: MessagesHttpRequest): Promise<MessagesHttpResponse>
}
export interface MessagesPrice {
  readonly inputUsdMicrosPerMillion: number
  readonly outputUsdMicrosPerMillion: number
  readonly cacheReadUsdMicrosPerMillion: number
  readonly cacheWriteUsdMicrosPerMillion: number
}
export interface MessagesToolScope {
  readonly project: LeadProject | null
  readonly runId: string | null
  readonly start: LeadPlanStep | null
  readonly context: LeadPermissionContext
  readonly predecessor?: { readonly runId: string; readonly ready: boolean; readonly terminal?: true; readonly reason?: 'lead-predecessor-unavailable' | 'lead-predecessor-unverifiable' }
  readonly stepId?: string | null
}
export interface LeadMessagesOptions {
  readonly apiKey: string
  readonly model?: string
  readonly prices: Readonly<Record<string, MessagesPrice>>
  readonly transport: MessagesTransport
  readonly journal: LeadJournalPort
  readonly now: () => number
  /** Unique trusted journal identifier, never a provider tool_use id. */
  readonly nextId: () => string
  /** Count the exact body, including tools, system and provider framing overhead.
   * Return a conservative upper bound on ALL input/cache tokens. No key is supplied. */
  readonly countInput: (body: string, signal: AbortSignal) => Promise<number>
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
  /** Resolve actual host scope and frozen preview facts; never trust model claims. */
  readonly resolveTool: (call: LeadPermissionCall) => Promise<MessagesToolScope>
  /** Forward cancellation to the desk transport. An abort after a mutation was sent
   * is uncertain; the journal records that outcome before this request completes. */
  readonly dispatch: (call: LeadPermissionCall, correlationId: string, signal: AbortSignal) => ReturnType<LeadDispatch>
}
export type LeadMessagesStatus = 'completed' | 'max-tokens' | 'refused' | 'cancelled' | 'uncertain' | 'rate-limited' | 'failed' | 'invalid-response'
export interface LeadMessagesResult {
  readonly status: LeadMessagesStatus
  /** Static code only. Raw transport errors, provider bodies and abort reasons never escape. */
  readonly reason?: string
  readonly usage?: MessagesUsage
  readonly text?: string
  readonly proposals?: { readonly plan: LeadAcceptanceContract | null; readonly cards: readonly LeadCard[] }
  /** Correlations refused by the permission gate, independent of static tool errors. */
  readonly permissionDeniedTools?: readonly string[]
  /** Only synchronization fences, failed read dispatches and successful results
   * beyond the continuation budget qualify for an automatic continuation. */
  readonly transientTools?: readonly string[]
  /** Predecessor readiness refusals wait for a new desk observation. */
  readonly deskActivityTools?: readonly string[]
  /** Dispatch successes, including results that could not fit the continuation. */
  readonly succeededTools?: readonly string[]
  readonly toolResults?: readonly MessagesToolResult[]
  /** Validated continuation with one ordered result for every tool use. Still untrusted
   * content: the renderer must use its transcript sanitizer. */
  readonly messages?: readonly MessagesTurn[]
}
export interface LeadMessagesClient {
  request(input: LeadMessagesRequest, signal: AbortSignal): Promise<LeadMessagesResult>
}
