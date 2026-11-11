/** These waits need a changed request, configuration or explicit person action.
 * Repeating the same continuation cannot repair them; clients keep the composer available. */
export const LEAD_SETUP_WAITS = [
  'lead-chat-effect-uncertain', 'lead-plan-unseatable', 'lead-plan-not-independent', 'lead-plan-refused',
  'lead-card-too-large', 'lead-start-binding-failed', 'lead-result-revisions-exhausted',
  ...['lead-request-unsent', 'lead-request-unsent-again', 'lead-request-withheld', 'lead-request-held'] as const,
] as const

/** The desk refused the request before it was sent, so nothing was spent and no reply is owed. A surface says the
 * request was not sent, and why, rather than that the Lead is waiting on the person. */
export const LEAD_UNSENT_WAITS = ['lead-request-unsent', 'lead-request-unsent-again', 'lead-request-withheld', 'lead-request-held'] as const
export const leadWaitUnsent = (reason: string | null | undefined): boolean =>
  (LEAD_UNSENT_WAITS as readonly (string | null | undefined)[]).includes(reason)

export const leadWaitNeedsChange = (reason: string | null | undefined): boolean =>
  (LEAD_SETUP_WAITS as readonly (string | null | undefined)[]).includes(reason)

/** A Lead request that did not complete, as each surface names it. `{label}` is the Lead's name. These are the request
 * waits a person reads as a failure of the request, not as the Lead waiting on them; a cancelled request is neither. */
export const LEAD_REQUEST_FAILURE_TEXT = {
  'lead-request-refused': 'The Lead could not send its request, so nothing was spent. Sending a message tries again.',
  'lead-request-rate-limited': 'The provider asked the Lead to wait.',
  'lead-request-failed': 'The request was interrupted. Sending a message also continues.',
  'lead-request-max-tokens': 'The request reached its response limit.',
  'lead-request-invalid-response': 'The provider returned an unreadable response.',
  'lead-request-uncertain': 'The request was interrupted. Sending a message also continues.',
  'lead-request-unsent': "The desk did not send {label}'s last request, so nothing was spent. Sending a message tries again.",
  'lead-request-unsent-again': "The desk again did not send {label}'s request, so nothing was spent. The desk log names the check that stopped it. Sending a message tries again.",
  'lead-request-held': "The desk held back {label}'s last request because part of the conversation looked like a password, key or token, so nothing was spent. Sending a message tries again.",
  'lead-request-withheld': "{label}'s instructions, memory or rules look like they hold a password, key or token, so the desk did not send its request and nothing was spent. Remove it from {label}'s memory or rules, then send a message.",
} as const
export type LeadRequestFailureReason = keyof typeof LEAD_REQUEST_FAILURE_TEXT
export const LEAD_REQUEST_FAILURES = Object.keys(LEAD_REQUEST_FAILURE_TEXT) as readonly LeadRequestFailureReason[]
/** Why the Lead's last request did not complete: a reason code and the plain sentence a surface shows for it. */
export interface LeadRequestFailure { readonly reason: LeadRequestFailureReason; readonly detail: string }
export const leadRequestFailure = (reason: string | null | undefined, label: string): LeadRequestFailure | null =>
  reason && Object.hasOwn(LEAD_REQUEST_FAILURE_TEXT, reason)
    ? { reason: reason as LeadRequestFailureReason, detail: LEAD_REQUEST_FAILURE_TEXT[reason as LeadRequestFailureReason].replace(/\{label\}/g, label) }
    : null
