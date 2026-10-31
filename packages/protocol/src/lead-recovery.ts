/** These waits need a changed request, configuration or explicit person action.
 * Repeating the same continuation cannot repair them; clients keep the composer available. */
export const LEAD_SETUP_WAITS = [
  'lead-worker-audit-failed', 'lead-chat-effect-uncertain', 'lead-plan-unseatable', 'lead-plan-not-independent', 'lead-plan-refused',
  'lead-card-too-large', 'lead-start-binding-failed', 'lead-result-revisions-exhausted',
] as const

export const leadWaitNeedsChange = (reason: string | null | undefined): boolean =>
  (LEAD_SETUP_WAITS as readonly (string | null | undefined)[]).includes(reason)
