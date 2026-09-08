import type { AgentEvent, LoginStart } from '@harnessdesk/protocol'

/**
 * A sign-in in progress, as the interface tracks it.
 *
 * Kept as a pure fold over events rather than dialog-local state because the
 * outcome arrives on the event stream, possibly after the dialog that started
 * it has been closed and reopened. The rules for which completions count are
 * the part worth testing: a runtime may fail an old login under its own id the
 * moment a new one starts, and that is not this login's news.
 */

export type LoginOutcome =
  | { readonly type: 'pending' }
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly error: string }

export interface LoginState {
  readonly method: string
  readonly start: LoginStart
  readonly outcome: LoginOutcome
}

export const startedLogin = (method: string, start: LoginStart): LoginState => ({
  method,
  start,
  outcome: { type: 'pending' },
})

/**
 * Folds a completion into the login in progress.
 *
 * A completion for another id is ignored. One with no id at all — a runtime
 * that cannot say which flow finished — counts only when it succeeded: being
 * signed in now is the fact that matters, whereas an unattributed failure may
 * belong to a flow this interface never started.
 */
export const applyLoginCompleted = (
  login: LoginState | null,
  event: Extract<AgentEvent, { type: 'account/loginCompleted' }>,
): LoginState | null => {
  if (!login || login.outcome.type !== 'pending') return login
  if (event.loginId !== null && event.loginId !== login.start.loginId) return login
  if (event.loginId === null && !event.success) return login
  return {
    ...login,
    outcome: event.success
      ? { type: 'succeeded' }
      : { type: 'failed', error: event.error?.trim() || 'Sign-in did not complete.' },
  }
}
