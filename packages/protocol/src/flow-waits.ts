/** Findings waits that a person or reviewer can clear; host and clients share the wording. */
export const WAITING_FINDINGS = (count: number): string =>
  `Waiting for ${count} open blocking finding${count === 1 ? '' : 's'} to be confirmed resolved.`
export const WAITING_EXCEPTION = 'Waiting for a person to review a new regression or security finding.'

/** The execution reason may carry the routing rule before the recorded wait. */
export const isFindingsWait = (reason: string | null): boolean => {
  if (reason === null) return false
  const wait = reason.replace(/^Rule [^:\n]+:\s*/, '')
  const count = /\d+/.exec(wait)?.[0]
  return wait === WAITING_EXCEPTION || (count !== undefined && wait === WAITING_FINDINGS(Number(count)))
}
