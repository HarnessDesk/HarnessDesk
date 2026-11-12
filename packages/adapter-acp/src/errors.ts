import type { AgentError } from '@harnessdesk/protocol'
import { AcpError } from '@harnessdesk/transport-acp'

/**
 * Error taxonomy for an ACP turn.
 *
 * A failed turn says what kind of failure it was, so the transcript can offer
 * the one thing that helps — a sign-in, the usage window, the agent's page in
 * Settings, or another try. ACP agents report failures as JSON-RPC errors
 * with few conventions beyond the spec's own codes, so the structured signals
 * are read first and the words only after, and only for the few phrases that
 * cannot mean anything else. When nothing fits the answer is `unknown`: a
 * wrong remedy offered with confidence is worse than none.
 */

/**
 * ACP's own refusal for a session that needs a sign-in first is `-32000
 * auth_required` with the words "Authentication required" — but -32000 is
 * also the head of JSON-RPC's reserved server-error range, and an agent's
 * "internal server error" wears the same number. So the words decide, in
 * the message or in the details the agent attached: Antigravity's
 * server sends the code and the words, a bridge may send the words alone,
 * and a bare -32000 is a failure of some other kind.
 */
const AUTH_REQUIRED_WORDS =
  /api key is missing(?: or not configured)?|authentication required|not authenticated|unauthenticated|auth(?:Required|[_ -]required)|login required|sign[- ]?in required|not (?:signed|logged) in|please (?:log|sign) in|(?:log|sign) in to (?:use|continue|access)|authenticate again/i

const said = (error: Error): string => `${error.message}\n${(error as AcpError).details ?? ''}`

/** Whether an agent refused for want of a sign-in, in its own words. */
export const isAuthRefusal = (error: unknown): boolean =>
  error instanceof Error && AUTH_REQUIRED_WORDS.test(said(error))

/** JSON-RPC's codes for a request the agent could not read or does not serve. */
const PROTOCOL_CODES = new Set([-32700, -32600, -32601, -32602])
/** ACP's code for a request the client cancelled. */
const REQUEST_CANCELLED = -32800

/** What the transport says when the agent's process is gone or never started. */
const PROCESS_GONE = /^(?:the agent is not running|agent failed to start|the agent exited)/i

/**
 * Words that name one kind of failure and nothing else. Read in this order:
 * an upstream "429 quota exceeded" is a spent allowance before it is a rate,
 * and either way the remedy is the same usage window.
 */
const SNIFFED: readonly (readonly [RegExp, AgentError['code']])[] = [
  [/requires a newer version/i, 'versionGate'],
  [/\b401\b|unauthori[sz]ed|invalid api key|not logged in/i, 'auth'],
  [/out of credits|insufficient (?:credits?|balance|funds)|credit balance|billing|quota|usage limit|spend cap/i, 'credits'],
  [/\b429\b|rate[- ]?limit|too many requests/i, 'rateLimit'],
  [/econnrefused|econnreset|enotfound|etimedout|eai_again|network (?:error|is unreachable)|fetch failed|socket hang up/i, 'network'],
]

/**
 * The code for a failure a turn ended on. Pure: an `AcpError`'s JSON-RPC
 * code, exit code and details, or any thrown value's message, in.
 */
export const classifyAcpError = (error: unknown): AgentError['code'] => {
  if (error instanceof AcpError) {
    if (error.exitCode !== undefined) return 'runtimeUnavailable'
    if (error.code === undefined && PROCESS_GONE.test(error.message)) return 'runtimeUnavailable'
    if (error.code === REQUEST_CANCELLED) return 'interrupted'
  }
  if (isAuthRefusal(error)) return 'auth'
  if (error instanceof AcpError && error.code !== undefined && PROTOCOL_CODES.has(error.code)) return 'protocol'
  const text = error instanceof Error ? said(error) : String(error)
  for (const [words, code] of SNIFFED) if (words.test(text)) return code
  return 'unknown'
}
