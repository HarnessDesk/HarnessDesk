import type { AgentError } from '@harnessdesk/protocol'
import { CodexError, CodexRpcError, type CodexProtocol } from '@harnessdesk/codex'

/**
 * Error taxonomy.
 *
 * Codex reports failures in three shapes — a `CodexErrorInfo` discriminant on
 * turn errors, a JSON-RPC error object, and free-form message text. The UI wants
 * one stable code per remediation, so this is where the three collapse into
 * `AgentError['code']`.
 */

type CodexErrorInfo = CodexProtocol.v2.CodexErrorInfo

const fromErrorInfo = (info: CodexErrorInfo | null | undefined): AgentError['code'] | null => {
  if (info === null || info === undefined) return null
  if (typeof info === 'object') {
    if ('httpConnectionFailed' in info || 'responseStreamConnectionFailed' in info) return 'network'
    if ('responseStreamDisconnected' in info || 'responseTooManyFailedAttempts' in info) {
      return 'network'
    }
    if ('activeTurnNotSteerable' in info) return 'protocol'
    return 'unknown'
  }
  switch (info) {
    case 'usageLimitExceeded':
      return 'credits'
    case 'unauthorized':
      return 'auth'
    case 'serverOverloaded':
    case 'rateLimitExceeded':
      return 'rateLimit'
    case 'sandboxError':
      return 'sandboxDenied'
    case 'internalServerError':
    case 'badRequest':
    case 'contextWindowExceeded':
    case 'cyberPolicy':
    case 'threadRollbackFailed':
      return 'unknown'
    default:
      return 'unknown'
  }
}

/**
 * Last-resort classification from message text.
 *
 * Codex sometimes forwards an upstream error body verbatim with
 * `codexErrorInfo: "other"` — the version gate in particular arrives that way
 * ("The 'gpt-5.6-sol' model requires a newer version of Codex"), and it is a
 * case the user must be told how to fix.
 */
const fromMessage = (message: string): AgentError['code'] => {
  const text = message.toLowerCase()
  if (text.includes('requires a newer version')) return 'versionGate'
  if (text.includes('out of credits') || text.includes('add credits')) return 'credits'
  // Codex's own words for a workspace that has run out: "You hit your spend
  // cap set by the owner of your workspace." Measured 2026-09-06, mid-review,
  // on codex-cli 0.149.0 — it arrives with no usable discriminant, and read as
  // `unknown` it was indistinguishable from a crash.
  if (text.includes('spend cap') || text.includes('usage limit')) return 'credits'
  if (text.includes('rate limit') || text.includes('too many requests')) return 'rateLimit'
  if (text.includes('unauthorized') || text.includes('not logged in') || text.includes('sign in')) {
    return 'auth'
  }
  if (text.includes('sandbox') && text.includes('denied')) return 'sandboxDenied'
  if (text.includes('interrupted') || text.includes('cancelled')) return 'interrupted'
  if (text.includes('econnrefused') || text.includes('network') || text.includes('timed out')) {
    return 'network'
  }
  return 'unknown'
}

export const mapTurnError = (
  error: {
    message: string
    codexErrorInfo?: CodexErrorInfo | null
    additionalDetails?: string | null
    misalignment?: CodexProtocol.v2.MisalignmentErrorDetails | null
  },
  willRetry = false,
): AgentError => {
  const fromInfo = fromErrorInfo(error.codexErrorInfo)
  // Message sniffing wins over a bare `other`, which carries no information.
  const code = fromInfo && fromInfo !== 'unknown' ? fromInfo : fromMessage(error.message)
  // 0.153.0: a turn blocked for misalignment carries its own explanation and,
  // when continuing is allowed, the instruction to send as the next turn.
  // Both are the whole point of the block being shown to a person; without
  // them the pane said only that the turn had stopped.
  const misalignment = error.misalignment
  const explanation = misalignment?.detailedExplanation?.trim()
  const steer = misalignment?.steer?.message?.trim()
  const detailLines = [
    ...(error.additionalDetails ? [error.additionalDetails] : []),
    ...(explanation ? [explanation] : []),
    ...(steer ? [`To continue anyway, send: ${steer}`] : []),
  ]
  return {
    message: humanize(error.message),
    code,
    retrying: willRetry,
    details: detailLines.length > 0 ? detailLines.join('\n\n') : null,
  }
}

export const mapThrown = (error: unknown): AgentError => {
  if (error instanceof CodexRpcError) {
    return { message: error.message, code: fromMessage(error.message), details: null }
  }
  if (error instanceof CodexError) {
    const code: AgentError['code'] =
      error.code === 'notInstalled' || error.code === 'versionTooOld'
        ? 'runtimeUnavailable'
        : error.code === 'crashed' || error.code === 'notRunning' || error.code === 'spawnFailed'
          ? 'runtimeUnavailable'
          : error.code === 'cancelled'
            ? 'interrupted'
            : error.code === 'timeout'
              ? 'network'
              : 'protocol'
    return { message: error.message, code, details: null }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { message, code: fromMessage(message), details: null }
}

/**
 * Codex forwards some upstream errors as a raw JSON body. Showing that to a user
 * is not acceptable, so unwrap the human-readable message when one is in there.
 */
const humanize = (message: string): string => {
  const trimmed = message.trim()
  if (!trimmed.startsWith('{')) return trimmed
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string }; message?: string }
    return parsed.error?.message ?? parsed.message ?? trimmed
  } catch {
    return trimmed
  }
}
