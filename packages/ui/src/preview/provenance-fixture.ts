import type {
  CaptureHealth,
  CommitProvenance,
  ProjectProvenance,
  ProvenanceSeat,
  ProvenanceSeatDetail,
  SeatRecord,
} from '@harnessdesk/protocol'

export const PROVENANCE_ROOT = '/work/project'
export const PROVENANCE_SHA = 'a'.repeat(40)

export const captureHealth = (over: Partial<CaptureHealth> = {}): CaptureHealth => ({
  project: PROVENANCE_ROOT, enabled: true, state: 'healthy',
  reason: 'Capture is current for the refs Git exposes.', nextStep: 'No action needed.',
  checkedAt: 20, lastCapturedAt: 20, pending: 0, gaps: 0, revision: 1, ...over,
})

export const provenanceSeat = (n = 1): ProvenanceSeat => ({
  id: `seat-${n}`, agentName: `Contributor ${n}`, runtime: 'fixture',
  seatLabel: 'Alpha · careful', session: { runtime: 'fixture', sessionId: `conversation-${n}` },
})

export const historicalSeat = (n = 1): SeatRecord => ({
  id: `seat-${n}`, agent: { id: `contributor-${n}`, name: `Contributor ${n}`, origin: 'project' },
  briefDigest: 'b'.repeat(64), seat: { runtime: 'fixture' }, seatLabel: 'Alpha · careful',
  passedOver: [], standing: { kind: 'permission', permission: 'read' }, ceiling: null,
  checkout: { cwd: PROVENANCE_ROOT, project: PROVENANCE_ROOT, branch: 'topic', head: PROVENANCE_SHA },
  session: provenanceSeat(n).session, board: null, role: null, openedAt: 10, closed: null,
})

export const commitProvenance = (over: Partial<CommitProvenance> = {}): CommitProvenance => ({
  sha: PROVENANCE_SHA, state: 'attributed', coverage: 'complete', seats: [provenanceSeat()],
  via: 'observed', reason: null, explanation: 'A local diff observation associates this change with its Seat.',
  evidenceIds: [], cards: [], observedAt: 20, ...over,
})

export const provenancePage = (commits: readonly CommitProvenance[] = [commitProvenance()], health = captureHealth()): ProjectProvenance =>
  ({ project: health.project, revision: health.revision, health, commits })

export const provenanceDetail = (n = 1): ProvenanceSeatDetail =>
  ({ seat: historicalSeat(n), session: provenanceSeat(n).session, unavailable: null })

export const PROVENANCE_SCENES = ['one', 'squash', 'partial', 'unknown', 'off', 'pending', 'hostile'] as const
export type ProvenanceScene = (typeof PROVENANCE_SCENES)[number]
export const sceneCommit = (scene: ProvenanceScene): CommitProvenance => {
  if (scene === 'hostile') return commitProvenance({ seats: [{ ...provenanceSeat(), agentName: '<img src=x onerror=alert(1)>' }] })
  if (scene === 'squash') return commitProvenance({ via: 'squash', seats: Array.from({ length: 6 }, (_, n) => provenanceSeat(n + 1)) })
  if (scene === 'partial') return commitProvenance({ via: 'amend', coverage: 'partial', reason: 'changed-patch', explanation: 'A surviving file is associated with this Seat. The remaining change is unattributed.' })
  if (scene === 'pending') return commitProvenance({ state: 'pending', coverage: 'none', seats: [], via: null, reason: 'catching-up', explanation: 'Capture is catching up.' })
  if (scene === 'unknown' || scene === 'off') return commitProvenance({ state: 'unattributed', coverage: 'none', seats: [], via: null, reason: scene === 'off' ? 'capture-off' : 'no-seat-evidence', explanation: scene === 'off' ? 'Capture is off on this machine.' : 'No local Seat evidence matches this change.' })
  return commitProvenance()
}

export const CAPTURE_SCENES = ['healthy', 'off', 'refused', 'watch', 'backlog', 'gap', 'non-git', 'unavailable'] as const
export type CaptureScene = (typeof CAPTURE_SCENES)[number]
export const sceneHealth = (scene: CaptureScene): CaptureHealth | null => {
  if (scene === 'non-git' || scene === 'unavailable') return null
  if (scene === 'off') return captureHealth({ enabled: false, state: 'stopped', reason: 'Capture is off on this machine.', nextStep: 'Turn capture on.' })
  if (scene === 'refused') return captureHealth({ state: 'stopped', reason: 'Repository metadata is refused.', nextStep: 'Use a supported checkout.' })
  if (scene === 'watch') return captureHealth({ state: 'degraded', reason: 'Watching failed; polling continues.', nextStep: 'Retry capture.' })
  if (scene === 'backlog') return captureHealth({ state: 'degraded', pending: 20, reason: 'Capture is catching up.', nextStep: 'Let capture finish.' })
  if (scene === 'gap') return captureHealth({ state: 'degraded', gaps: 1, reason: 'A ref history is missing.', nextStep: 'Retry capture; missing history may stay unattributed.' })
  return captureHealth()
}
