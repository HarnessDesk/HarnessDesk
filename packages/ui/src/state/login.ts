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
  /**
   * The sign-in has asked for a code to be pasted into it — the browser page
   * shows one when it cannot hand the result back by itself. Whether it asked,
   * never the code: that stays in the field it was typed into until it is sent.
   */
  readonly awaitingCode: boolean
  /**
   * How many pasted codes the sign-in has refused and read on from. A count,
   * not a flag, so a second refusal after a second paste is news too.
   */
  readonly codeRefusals: number
}

export const startedLogin = (method: string, start: LoginStart): LoginState => ({
  method,
  start,
  outcome: { type: 'pending' },
  awaitingCode: start.type === 'browser' && start.pasteCode === true,
  codeRefusals: 0,
})

/**
 * Folds a later ask for a pasted code — a first one, or one after a refused
 * paste — into the login it belongs to, and no other.
 */
export const applyLoginAwaitsCode = (
  login: LoginState | null,
  event: Extract<AgentEvent, { type: 'account/loginAwaitsCode' }>,
): LoginState | null => {
  if (!login || login.outcome.type !== 'pending') return login
  if (event.loginId !== login.start.loginId) return login
  if (event.refused) return { ...login, awaitingCode: true, codeRefusals: (login.codeRefusals ?? 0) + 1 }
  return login.awaitingCode ? login : { ...login, awaitingCode: true }
}

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
