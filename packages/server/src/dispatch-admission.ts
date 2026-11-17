/** Host-only admission: asynchronous scope proof plus the synchronous fence at
 * the actual effect boundary. The latter must be checked after the last await. */
export type DispatchAdmission<T> = ((value: T) => Promise<void>) & {
  readonly assertDispatch?: () => void
  /** Host receipts distinguish queue admission from the actual send. */
  readonly dispatchStarted?: () => void
  /** The ID returned by this exact accepted send, with its live handle. */
  readonly dispatchAccepted?: (turnId: string, live: T) => void
  /** A carry-on-owned queued send must not be retried after an unconfirmed effect. */
  readonly retireUnconfirmed?: boolean
  /** A send crossed the effect boundary but its outcome could not be confirmed. */
  readonly dispatchUnconfirmed?: () => Promise<void>
  readonly queueRemoved?: () => void
  readonly dispatchRefused?: () => void
}
