/** Errors this package raises. Each maps to a distinct remediation in the UI. */

export type CodexErrorCode =
  /** No copy of Codex on this machine. */
  | 'notInstalled'
  /**
   * A copy is there and would not report its version, in a way a later ask may
   * change: it timed out, was ended by a signal, exited non-zero (a launcher
   * whose `node` is on a PATH that has not arrived yet), or the machine refused
   * the spawn for want of a resource.
   */
  | 'unreadable'
  | 'versionTooOld'
  /** Codex could not be started, or a copy is there and will not run for a reason that will not pass. */
  | 'spawnFailed'
  | 'notRunning'
  | 'crashed'
  | 'timeout'
  | 'cancelled'
  | 'protocol'
  | 'rpc'

export class CodexError extends Error {
  constructor(
    readonly code: CodexErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'CodexError'
  }
}

/** An error the app-server returned in a JSON-RPC `error` member. */
export class CodexRpcError extends CodexError {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
  ) {
    super('rpc', message, data)
    this.name = 'CodexRpcError'
  }
}
