import type { LeadControlRefusal } from '@harnessdesk/protocol'
/** Closed refusal vocabulary; transport messages and typed codes never render. */
export const REFUSALS: Record<LeadControlRefusal, string> = {
  'lead-runtime-unsupported': "Lead can't start here: no runtime on this desk keeps its network blocked by the permission model.",
  'lead-unavailable': 'The Lead is unavailable.', 'lead-operation-refused': 'The Lead could not complete that action.',
  'lead-secret-refused': 'That content cannot be shared in the Lead thread.', 'lead-revision-stale': 'The Lead changed. Review the latest version and try again.',
  'lead-no-person-wait': 'There is no request to resume.', 'lead-plan-pending': 'Review the plan before continuing.',
  'lead-card-stale': 'This request changed. Review the latest one.', 'lead-card-decided': 'This request already has a decision.',
  'lead-approval-not-live': 'This saved approval is no longer active.',
  'lead-worker-approval': 'Open the worker approval to answer it.', 'lead-gate-changed': 'The result changed. Inspect the latest evidence.',
  'lead-gate-save-failed': 'The decision could not be saved. Try again.', 'lead-settings-combination': 'Save the key and name separately from other settings.',
  'lead-evidence-read-refused': 'The evidence could not be read. Try again.', 'lead-change-pending': 'Answer the pending settings request first.',
  'lead-card-too-large': 'This request is too large to display safely.', 'lead-projection-failed': 'The Lead could not be read. Try again.',
  'lead-key-missing': 'Add a provider key in Settings to continue.', 'lead-secret-in-thread': 'This key already appears in the thread. Use a different key.',
  'lead-chat-effect-uncertain': 'The chat operation may have started. Inspect that chat on the desk, then choose Start new request before sending your next message.',
  'lead-thread-closed': 'This Lead thread has finished.', 'lead-steer-unavailable': 'No worker is in a turn to steer right now.', 'lead-budget-stopped': 'This goal has used its allowance. Stop it to begin a new one.',
  'lead-protection-unavailable': 'Encrypted key storage is unavailable.', 'lead-request-in-flight': 'Wait for the current request to finish.',
  'lead-repeat-missing': 'This repeat has stopped or is no longer available. Open Settings to review it.',
  'lead-repeat-cleanup-pending': 'The previous run still needs to be settled. Wait, then try again.',
  'lead-repeat-quiet': 'Quiet hours are holding this run. Try again after they end.',
  'lead-project-missing': 'Open a folder first, then send your goal.',
}

export const leadRefusalText = (error: unknown) => {
  const value = error as { code?: string; wireCode?: string }
  const code = value?.wireCode ?? value?.code
  return typeof code === 'string' && Object.hasOwn(REFUSALS, code) && typeof REFUSALS[code as LeadControlRefusal] === 'string' ? REFUSALS[code as LeadControlRefusal] : 'The Lead could not complete that action.'
}
