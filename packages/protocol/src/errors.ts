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
  /* Declared as `string` rather than as the literal so a *kind* of gone can
     name itself — see `SessionFolderGoneError`. `wireCodeOf` reads it either
     way, and the narrowing bought nothing: nobody assigns this. */
  readonly wireCode: string = 'sessionGone'
  constructor(message: string) {
    super(message)
    this.name = 'SessionGoneError'
  }
}

/**
 * The conversation's own folder is gone, so the agent will not reopen it.
 *
 * A *kind* of gone, and given its own code because it is the one gone with a
 * way out. Every other reason a conversation will not come back leaves nothing
 * to offer — the agent keeps no store, or no longer has the id, and there is
 * no folder to blame and nothing to do. This one has both: the transcript is
 * still readable from the host's own store, and the work can go on somewhere
 * that exists. An interface can only offer that if it can tell this refusal
 * from every other gone without reading English, which is what the code is for.
 *
 * It stays a `SessionGoneError`, so every caller that only asks "will asking
 * again help" — `isSessionGone`, and the room that lets a member go — keeps
 * the answer it had.
 */
export class SessionFolderGoneError extends SessionGoneError {
  override readonly wireCode = 'sessionFolderGone'
  constructor(
    message: string,
    /** The folder that is no longer there, as the agent recorded it. */
    readonly folder: string | null = null,
  ) {
    super(message)
    this.name = 'SessionFolderGoneError'
  }
}

export const isSessionGone = (error: unknown): boolean => {
  const code = wireCodeOf(error)
  return code === 'sessionGone' || code === 'sessionFolderGone'
}

/** Whether a refusal is the one with a folder to blame and a way forward. */
export const isFolderGone = (error: unknown): boolean =>
  wireCodeOf(error) === 'sessionFolderGone'

/** The folder a gone conversation named, when the thrower had it in hand. */
export const folderGoneOf = (error: unknown): string | null => {
  const folder = error instanceof Error ? (error as { folder?: unknown })['folder'] : null
  return typeof folder === 'string' && folder.trim() ? folder : null
}

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
