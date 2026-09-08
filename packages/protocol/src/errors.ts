/**
 * Failures a client can do something about, named on the wire.
 *
 * Most of what goes wrong is one sentence and one shrug — the message is the
 * whole story and `methodFailed` is an honest code for it. A few failures are
 * different: they have a *way out*, and the interface can only offer it if it
 * can tell this failure from every other one without reading English. Those
 * carry a code.
 */

/** The wire code a failure asked for, read structurally. */
export const wireCodeOf = (error: unknown): string | null => {
  const code = error instanceof Error ? (error as { wireCode?: unknown })['wireCode'] : null
  return typeof code === 'string' && code.trim() ? code : null
}

/**
 * The conversation is open somewhere else, and that somewhere else is the only
 * thing that can continue it.
 *
 * Agents that keep their conversations in files on the machine tend to allow
 * one live writer each, so the second asker is refused — by design, because
 * two processes appending to one transcript would destroy it. The refusal is
 * not a fault and retrying will not help. What helps is naming the holder and
 * offering a copy, which is why this is a type and not a sentence.
 */
export class SessionBusyError extends Error {
  readonly wireCode = 'sessionBusy'
  constructor(
    message: string,
    /** What is holding it, in words a person recognises, when it can be found. */
    readonly holder: string | null = null,
  ) {
    super(message)
    this.name = 'SessionBusyError'
  }
}

export const isSessionBusy = (error: unknown): boolean => wireCodeOf(error) === 'sessionBusy'

/** What is holding a busy conversation, when the thrower could find out. */
export const holderOf = (error: unknown): string | null => {
  const holder = error instanceof Error ? (error as { holder?: unknown })['holder'] : null
  return typeof holder === 'string' && holder.trim() ? holder : null
}

/**
 * The agent was asked to reopen a conversation and answered that it cannot —
 * it keeps no store to reopen from, the conversation's folder is gone, or it
 * looked and no longer has the id. Not a fault of the moment: asking again
 * gets the same answer. Distinct from a reopen that merely failed — a
 * timeout, a pipe that closed, an agent that is down — which may pass. A
 * type rather than a sentence so a caller keeping a list of reachable
 * conversations can drop one the agent has disowned and keep one it only
 * could not reach.
 */
export class SessionGoneError extends Error {
  readonly wireCode = 'sessionGone'
  constructor(message: string) {
    super(message)
    this.name = 'SessionGoneError'
  }
}

export const isSessionGone = (error: unknown): boolean => wireCodeOf(error) === 'sessionGone'

/**
 * Whether an agent answered a reopen by saying the id names nothing.
 *
 * JSON-RPC's `-32602` is "invalid params", and for `session/load` the only
 * param is the id — the ACP bridges answer an unknown conversation with it
 * (`RequestError.invalidParams`). Read structurally off the code the transport
 * kept: `code` on an ACP error, `rpcCode` on a Codex one. Deliberately not
 * "any error code": `-32603` and the `-32000` range are what an agent says
 * when *it* could not, right now — Codex's "server overloaded; retry later"
 * is `-32001` — and those may pass.
 */
export const reopenRefusedByAgent = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const { code, rpcCode } = error as { code?: unknown; rpcCode?: unknown }
  return code === -32602 || rpcCode === -32602
}
