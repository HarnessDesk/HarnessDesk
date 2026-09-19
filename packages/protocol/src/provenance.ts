import type { CardRef, SeatId, SeatRecord, SessionPointer, Sha } from './evidence.js'

export type CaptureState = 'healthy' | 'degraded' | 'stopped'
export type ProvenanceReason =
  | 'not-observed' | 'capture-off' | 'capture-stopped' | 'catching-up'
  | 'no-seat-evidence' | 'ambiguous-patch' | 'empty-change'
  | 'changed-patch' | 'missing-object' | 'history-gap'
  | 'limit-exceeded' | 'unsupported-merge' | 'restored-history'

export interface CaptureHealth {
  readonly project: string
  readonly enabled: boolean
  readonly state: CaptureState
  readonly reason: string
  readonly nextStep: string
  readonly checkedAt: number | null
  readonly lastCapturedAt: number | null
  readonly pending: number
  readonly gaps: number
  readonly revision: number
}
export interface ProvenanceSeat {
  readonly id: SeatId
  readonly agentName: string | null
  readonly runtime: string
  readonly seatLabel: string
  readonly session: SessionPointer
}
export interface CommitProvenance {
  readonly sha: Sha
  readonly state: 'pending' | 'attributed' | 'unattributed'
  readonly coverage: 'complete' | 'partial' | 'none'
  readonly seats: readonly ProvenanceSeat[]
  readonly via: 'observed' | 'patch' | 'amend' | 'squash' | null
  readonly reason: ProvenanceReason | null
  readonly explanation: string
  readonly evidenceIds: readonly string[]
  readonly cards: readonly CardRef[]
  readonly observedAt: number | null
}
export interface ProjectProvenance {
  readonly project: string
  readonly revision: number
  readonly health: CaptureHealth
  readonly commits: readonly CommitProvenance[]
}
export interface ProvenanceSeatDetail {
  readonly seat: SeatRecord | null
  readonly session: SessionPointer | null
  readonly unavailable: string | null
}
