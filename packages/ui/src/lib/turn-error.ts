import type { RuntimeInfo, SeatFix, Turn, TurnError, UserContent } from '@harnessdesk/protocol'

import { fixWords } from './agents'

/**
 * The one thing that helps after a failed turn, chosen from what kind of
 * failure it was (`AgentError['code']`, which the adapter fills in).
 *
 * Every remedy is a door that already exists: the sign-in, the usage window
 * and the runtime's page in Settings are the same `SeatFix` routes the
 * refusal sheet uses (`app/seat-fixes.ts`), worded by `fixWords` from the
 * runtime's own presentation; another try queues the turn's own prompt again,
 * as the answer row's retry queues its message. Each is gated on what the
 * runtime can do, never on which runtime it is.
 *
 * Offered nothing: a turn being retried already, an interrupted turn (the
 * person stopped it), a sandbox refusal (the answer is in the approval policy,
 * not here), and a turn with no code at all — an agent that only said it
 * stopped, for a reason no remedy here is known to fix.
 */
export type TurnErrorAction =
  | { readonly kind: 'fix'; readonly fix: SeatFix; readonly label: string }
  | { readonly kind: 'retry'; readonly label: string }

export const turnErrorAction = (
  error: TurnError,
  runtime: RuntimeInfo | undefined,
  /** Whether this turn's prompt can be queued again: the last turn, in a conversation that can still run. */
  canRetry: boolean,
): TurnErrorAction | null => {
  if (error.retrying) return null
  const fix = (made: SeatFix, info: RuntimeInfo): TurnErrorAction =>
    ({ kind: 'fix', fix: made, label: fixWords(made, info.presentation.name) })
  switch (error.code) {
    case 'auth':
      return runtime?.capabilities.account ? fix({ kind: 'signIn', runtime: runtime.id }, runtime) : null
    case 'credits':
    case 'rateLimit':
      return runtime?.capabilities.metered ? fix({ kind: 'usage', runtime: runtime.id }, runtime) : null
    case 'versionGate':
    case 'runtimeUnavailable':
      return runtime ? fix({ kind: 'runtime', runtime: runtime.id }, runtime) : null
    case 'network':
    case 'protocol':
    case 'unknown':
      return canRetry ? { kind: 'retry', label: 'Try again' } : null
    default:
      return null
  }
}

/**
 * What the person sent in a turn, to send again. Desk provenance stays with
 * the message it described: a second try is the person's own, sent now.
 */
export const promptOf = (turn: Turn): readonly UserContent[] => {
  const sent = turn.items.find(item => item.type === 'userMessage')
  if (!sent || sent.type !== 'userMessage') return []
  return sent.content.map(part => {
    if (part.type !== 'text' || part.deskContext === undefined) return part
    const { deskContext: _deskContext, ...rest } = part
    return rest
  })
}
