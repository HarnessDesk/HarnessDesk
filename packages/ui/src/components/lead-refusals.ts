import type { LeadControlRefusal } from '@harnessdesk/protocol'
/** Closed refusal vocabulary; transport messages and typed codes never render. */
export const REFUSALS: Record<LeadControlRefusal, string> = {
  'lead-unavailable': 'The Lead is unavailable.', 'lead-operation-refused': 'The Lead could not complete that action.',
  'lead-secret-refused': 'That content cannot be shared in the Lead thread.', 'lead-revision-stale': 'The Lead changed. Review the latest version and try again.',
  'lead-no-person-wait': 'There is no request to resume.', 'lead-plan-pending': 'Review the plan before continuing.',
  'lead-card-stale': 'This request changed. Review the latest one.', 'lead-card-decided': 'This request already has a decision.',
  'lead-worker-approval': 'Open the worker approval to answer it.', 'lead-gate-changed': 'The result changed. Inspect the latest evidence.',
  'lead-gate-save-failed': 'The decision could not be saved. Try again.', 'lead-settings-combination': 'Save the key and name separately from other settings.',
  'lead-evidence-read-refused': 'The evidence could not be read. Try again.', 'lead-change-pending': 'Answer the pending settings request first.',
  'lead-card-too-large': 'This request is too large to display safely.', 'lead-projection-failed': 'The Lead could not be read. Try again.',
  'lead-key-missing': 'Add a provider key in Settings to continue.', 'lead-secret-in-thread': 'This key already appears in the thread. Use a different key.',
  'lead-thread-closed': 'This Lead thread has finished.', 'lead-budget-stopped': 'The Lead has reached a stopped allowance.',
  'lead-protection-unavailable': 'Encrypted key storage is unavailable.', 'lead-request-in-flight': 'Wait for the current request to finish.',
}

export const leadRefusalText = (error: unknown) => {
  const value = error as { code?: string; wireCode?: string }
  const code = value?.wireCode ?? value?.code
  return typeof code === 'string' && Object.hasOwn(REFUSALS, code) && typeof REFUSALS[code as LeadControlRefusal] === 'string' ? REFUSALS[code as LeadControlRefusal] : 'The Lead could not complete that action.'
}
