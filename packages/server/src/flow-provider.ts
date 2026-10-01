import type { SeatReason } from '@harnessdesk/protocol'

/** The refusal the flow runner records when no distinct provider can be seated. */
export const INDEPENDENT_PROVIDER = 'This step needs an independent provider. Choose a seat from another provider.'

/** Shared pre-open and post-open provider rule for execution and its dry run. */
export const independentProviderReason = (
  candidate: string | null,
  writers: ReadonlySet<string | null>,
): SeatReason | null => {
  if (writers.has(null) || candidate === null) return { kind: 'unknownProvider' }
  return writers.has(candidate) ? { kind: 'sameProvider' } : null
}
