import { describe, expect, it } from 'vitest'

import { runtimeId, type AccountStatus, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import { isBlocking, readinessOf, worstReadiness } from './readiness'

const account: AccountStatus = {
  accounts: [{ kind: 'chatgpt', label: 'olivia@acme.dev' }],
  signInMethods: [],
}
const noAccount: AccountStatus = { accounts: [], signInMethods: [] }

/**
 * The fixtures are typed rather than cast, so a renamed protocol field breaks
 * the build here instead of arriving as a silently absent property.
 */
const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: 'Weekly',
  windowMinutes: 10_080,
  resetsAt: null,
  ...over,
})

const report = (reached: string | null, over: Partial<UsageReport> = {}): UsageReport => ({
  runtime: runtimeId('codex'),
  account: null,
  plan: null,
  lanes: [],
  credits: null,
  spend: null,
  reached,
  source: { kind: 'runtime', label: 'from its own API' },
  fetchedAt: 0,
  staleAfterMs: 0,
  error: null,
  ...over,
})

describe('readinessOf', () => {
  it('calls an unregistered agent available', () => {
    expect(readinessOf({ registered: false, health: null, account: null })).toBe('available')
  })

  it('puts a broken host ahead of a missing credential', () => {
    const health = { state: 'unavailable', reason: 'notInstalled', message: 'no binary' } as const
    expect(readinessOf({ registered: true, health, account: noAccount })).toBe('broken')
  })

  it('asks for a sign-in when no identity is present', () => {
    expect(readinessOf({ registered: true, health: { state: 'ready' }, account: noAccount })).toBe('signin')
  })

  it('reads a spent window from the agent, not from a failure', () => {
    expect(
      readinessOf({
        registered: true,
        health: { state: 'ready' },
        account,
        usage: [report('weekly')],
      }),
    ).toBe('limit')
  })

  it('will not call an account limited because one of its models is', () => {
    // Claude Code with the Fable week gone: `reached` names a scoped window,
    // and every other model still answers. Only `isBlocked` may say limit.
    const fable = report('weekly:fable', {
      lanes: [
        lane({ id: 'weekly', usedPercent: 63 }),
        lane({ id: 'weekly:fable', usedPercent: 100, scope: 'Fable' }),
      ],
    })
    expect(
      readinessOf({ registered: true, health: { state: 'ready' }, account, usage: [fable] }),
    ).toBe('ready')
  })

  it('reads a spent account-wide window the source never named', () => {
    const out = report(null, { lanes: [lane({ id: 'weekly', usedPercent: 100 })] })
    expect(
      readinessOf({ registered: true, health: { state: 'ready' }, account, usage: [out] }),
    ).toBe('limit')
  })

  it('asks the account that would run the turn, not whichever one is worst', () => {
    // Accounts are disjunctive: signed in to two, either one will do it.
    const out = report('weekly', { account: 'work', lanes: [lane({ id: 'weekly', usedPercent: 100 })] })
    const spare = report(null, { account: 'personal', lanes: [lane({ id: 'weekly', usedPercent: 12 })] })
    expect(
      readinessOf({ registered: true, health: { state: 'ready' }, account, usage: [out, spare] }),
    ).toBe('ready')
    expect(
      readinessOf({ registered: true, health: { state: 'ready' }, account, usage: [out] }),
    ).toBe('limit')
  })

  it('does not read an unanswerable account question as signed out', () => {
    const ready = { state: 'ready' } as const
    expect(readinessOf({ registered: true, health: ready, account: noAccount, accounts: false })).toBe('ready')
    expect(readinessOf({ registered: true, health: ready, account: null, accounts: false })).toBe('ready')
    expect(readinessOf({ registered: true, health: ready, account: noAccount, accounts: true })).toBe('signin')
    expect(readinessOf({ registered: true, health: ready, account: noAccount })).toBe('signin')
  })

  it('is ready when nothing is in the way', () => {
    expect(
      readinessOf({ registered: true, health: { state: 'ready' }, account, usage: [report(null)] }),
    ).toBe('ready')
  })

  it('treats a starting host as ready rather than broken', () => {
    expect(readinessOf({ registered: true, health: { state: 'starting' }, account })).toBe('ready')
  })
})

describe('worstReadiness', () => {
  it('ranks by what stops a session first', () => {
    expect(worstReadiness(['ready', 'limit', 'signin'])).toBe('signin')
    expect(worstReadiness(['ready', 'limit'])).toBe('limit')
    expect(worstReadiness(['ready', 'ready'])).toBe('ready')
    expect(worstReadiness([])).toBe('ready')
  })

  it('lets a broken agent outrank everything', () => {
    expect(worstReadiness(['signin', 'broken', 'limit'])).toBe('broken')
  })
})

describe('isBlocking', () => {
  it('leaves a registry entry quiet', () => {
    expect(isBlocking('available')).toBe(false)
    expect(isBlocking('ready')).toBe(false)
    expect(isBlocking('signin')).toBe(true)
  })
})

describe('an agent that keeps its own credential', () => {
  it('is never asked to sign in here: an empty account list is not ours to know', () => {
    expect(readinessOf({ registered: true, health: { state: 'ready' }, account: noAccount, accounts: false })).toBe('ready')
    expect(readinessOf({ registered: true, health: { state: 'ready' }, account: null, accounts: false })).toBe('ready')
  })

  it('is still broken when its host is down', () => {
    expect(
      readinessOf({
        registered: true,
        health: { state: 'unavailable', reason: 'crashed', message: 'Exited.' },
        account: noAccount,
        accounts: false,
      }),
    ).toBe('broken')
  })

  it('reads as before when the flag is absent or true', () => {
    expect(readinessOf({ registered: true, health: { state: 'ready' }, account: noAccount })).toBe('signin')
    expect(readinessOf({ registered: true, health: { state: 'ready' }, account: noAccount, accounts: true })).toBe('signin')
  })
})
