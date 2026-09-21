import type { CaptureHealth } from '@harnessdesk/protocol'

export interface HealthInput {
  readonly project: string
  readonly enabled: boolean
  readonly fatal: boolean
  readonly issues: readonly string[]
  readonly checkedAt: number | null
  readonly lastCapturedAt: number | null
  readonly pending: number
  readonly gaps: number
  readonly revision: number
}

const messages = {
  current: ['Capture is current for the refs Git exposes.', 'No action needed.'],
  pending: ['Catching up with this project.', 'Keep the project open; capture continues in the background.'],
  polling: ['File notifications are unavailable; capture is polling.', 'Retry capture to reconnect notifications.'],
  history: ['Some history was unavailable when capture resumed.', 'Retry if the repository has been repaired; those changes may stay unattributed.'],
  evidence: ['Some local evidence records could not be read.', 'Repair the local evidence and retry capture.'],
  limit: ['Capture reached its background work limit.', 'Keep the project open; inspect the named limit if it persists.'],
  off: ['Capture is off on this machine.', 'Turn capture on.'],
  external: ["This repository's metadata is outside the captured project.", 'Open its main checkout, or use a checkout with local metadata.'],
  storage: ['Capture could not save its observations.', 'Repair the local state file or its permissions, then retry capture.'],
  missing: ["This project's folder is unavailable.", 'Open the folder again, then retry capture.'],
} as const

export const captureHealth = (input: HealthInput): CaptureHealth => {
  const { fatal, issues, ...base } = input
  const key: keyof typeof messages = !input.enabled && !issues.includes('preference-invalid') ? 'off'
    : fatal ? issues.includes('external-metadata') ? 'external' : issues.includes('folder-unavailable') ? 'missing' : 'storage'
    : issues.includes('limit-exceeded') ? 'limit'
    : input.gaps > 0 || issues.includes('history-gap') ? 'history'
    : issues.includes('evidence-skipped') ? 'evidence'
    : issues.includes('watch-unavailable') ? 'polling'
    : input.pending > 0 || input.checkedAt === null ? 'pending' : 'current'
  const [reason, nextStep] = messages[key]
  return {
    ...base,
    state: key === 'off' || fatal ? 'stopped' : key === 'current' ? 'healthy' : 'degraded',
    reason,
    nextStep,
  }
}
