import { describe, expect, test } from 'vitest'

import { runtimeId, type AgentEvent } from '@harnessdesk/protocol'

import { applyLoginCompleted, startedLogin } from './login'

/**
 * Which completions belong to the login in progress. The runtime observed
 * behind this — Codex — fails a superseded login under the *old* id the moment
 * a new one starts, so attributing by id is what keeps a fresh dialog from
 * showing a stale error.
 */

const completed = (
  overrides: Partial<Extract<AgentEvent, { type: 'account/loginCompleted' }>>,
): Extract<AgentEvent, { type: 'account/loginCompleted' }> => ({
  type: 'account/loginCompleted',
  runtime: runtimeId('r'),
  loginId: 'login-2',
  success: true,
  error: null,
  ...overrides,
})

const pending = () =>
  startedLogin('browser-method', {
    type: 'browser',
    loginId: 'login-2',
    url: 'https://auth.example/start',
  })

describe('applyLoginCompleted', () => {
  test('a matching success completes the login', () => {
    expect(applyLoginCompleted(pending(), completed({}))?.outcome).toEqual({ type: 'succeeded' })
  })

  test('a matching failure carries the runtime’s reason', () => {
    const next = applyLoginCompleted(
      pending(),
      completed({ success: false, error: 'Login server error: Login cancelled' }),
    )
    expect(next?.outcome).toEqual({
      type: 'failed',
      error: 'Login server error: Login cancelled',
    })
  })

  test('a failure with no reason still says something', () => {
    const next = applyLoginCompleted(pending(), completed({ success: false, error: '  ' }))
    expect(next?.outcome.type).toBe('failed')
    expect(next?.outcome.type === 'failed' && next.outcome.error).toMatch(/did not complete/)
  })

  test('the superseded login’s failure does not touch the new one', () => {
    const login = pending()
    const next = applyLoginCompleted(
      login,
      completed({ loginId: 'login-1', success: false, error: 'Login cancelled' }),
    )
    expect(next).toBe(login)
  })

  test('an unattributed success counts — being signed in is the fact that matters', () => {
    expect(applyLoginCompleted(pending(), completed({ loginId: null }))?.outcome).toEqual({
      type: 'succeeded',
    })
  })

  test('an unattributed failure is ignored — it may not be ours', () => {
    const login = pending()
    expect(applyLoginCompleted(login, completed({ loginId: null, success: false }))).toBe(login)
  })

  test('a login already settled is not reopened by a late event', () => {
    const settled = applyLoginCompleted(pending(), completed({ success: false, error: 'x' }))
    expect(applyLoginCompleted(settled, completed({}))).toBe(settled)
  })

  test('nothing in progress means nothing to fold', () => {
    expect(applyLoginCompleted(null, completed({}))).toBeNull()
  })
})
