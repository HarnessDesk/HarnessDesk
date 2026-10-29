/** Setup failures require a changed request or configuration. Repeating the same
 * continuation cannot repair them; clients keep the composer available instead. */
export const LEAD_SETUP_WAITS = [
  'lead-plan-unseatable', 'lead-plan-not-independent', 'lead-plan-refused',
  'lead-card-too-large', 'lead-start-binding-failed', 'lead-result-revisions-exhausted',
] as const

export const leadWaitNeedsChange = (reason: string | null | undefined): boolean =>
  (LEAD_SETUP_WAITS as readonly (string | null | undefined)[]).includes(reason)
