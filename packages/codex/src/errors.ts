/** Errors this package raises. Each maps to a distinct remediation in the UI. */

export type CodexErrorCode =
  | 'notInstalled'
  | 'versionTooOld'
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
