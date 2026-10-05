/** Findings waits that a person or reviewer can clear; host and clients share the wording. */
export const WAITING_FINDINGS = (count: number): string =>
  `Waiting for ${count} open blocking finding${count === 1 ? '' : 's'} to be confirmed resolved.`
export const WAITING_EXCEPTION = 'Waiting for a person to review a new regression or security finding.'

export const WAITING_LEDGER = 'Some findings could not be read, so this cannot be ready. A person has to look.'

/** The complete findings-wait vocabulary; count-bearing waits share their formatter. */
export const FINDINGS_WAITS = [WAITING_FINDINGS, WAITING_EXCEPTION, WAITING_LEDGER] as const

/** The execution reason may carry the routing rule before the recorded wait. */
export const isFindingsWait = (reason: string | null): boolean => {
  if (reason === null) return false
  const wait = reason.replace(/^Rule [^:\n]+:\s*/, '')
  const count = /\d+/.exec(wait)?.[0]
  return FINDINGS_WAITS.some(finding => typeof finding === 'string'
    ? wait === finding
    : count !== undefined && wait === finding(Number(count)))
}
