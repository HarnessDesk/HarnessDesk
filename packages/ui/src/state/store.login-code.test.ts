import { beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type HostMethodName } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * A sign-in that asks for a pasted code.
 *
 * The code is a secret on its way to the agent's sign-in command, and the
 * store is where a screen's state lives — so what matters here is what the
 * store does *not* do with it: keep it in the snapshot, or repeat it in a
 * notice when the host refuses it.
 */

const CLAUDE = runtimeId('claude-code')
const CODE = 'pasted-code-5e1f#state-77aa'

let store: AppStore
let sent: { method: string; params: unknown }[]
let refuse: Error | null

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  sent = []
  refuse = null
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    sent.push({ method, params })
    if (method === 'runtime/login') return { type: 'browser', loginId: 'login-1', url: 'https://auth.example.com/flow' }
    if (method === 'runtime/login/code' && refuse) throw refuse
    return null
  }) as never)
})

const handlers = () =>
  (store.transport as unknown as { handlers: { onEvent(runtime: unknown, event: unknown): void } }).handlers

it('a later ask for a code opens the field on the login it names, and no other', async () => {
  await store.startLogin(CLAUDE, 'cli-browser')
  expect(store.getSnapshot().logins[CLAUDE]?.awaitingCode).toBe(false)

  handlers().onEvent(CLAUDE, { type: 'account/loginAwaitsCode', runtime: CLAUDE, loginId: 'login-0' })
  expect(store.getSnapshot().logins[CLAUDE]?.awaitingCode).toBe(false)

  handlers().onEvent(CLAUDE, { type: 'account/loginAwaitsCode', runtime: CLAUDE, loginId: 'login-1' })
  expect(store.getSnapshot().logins[CLAUDE]?.awaitingCode).toBe(true)
})

it('the code is sent for the login in progress and kept nowhere in the snapshot', async () => {
  await store.startLogin(CLAUDE, 'cli-browser')
  expect(await store.submitLoginCode(CLAUDE, CODE)).toBe(true)
  expect(sent.at(-1)).toEqual({ method: 'runtime/login/code', params: { runtime: CLAUDE, loginId: 'login-1', code: CODE } })
  expect(JSON.stringify(store.getSnapshot())).not.toContain(CODE)
})

it('a refusal is said in the host\'s words, and the notice never repeats the code', async () => {
  await store.startLogin(CLAUDE, 'cli-browser')
  refuse = new Error('This sign-in is not waiting for a code.')
  expect(await store.submitLoginCode(CLAUDE, CODE)).toBe(false)
  expect(store.getSnapshot().notices.at(-1)?.message).toContain('not waiting for a code')
  expect(JSON.stringify(store.getSnapshot())).not.toContain(CODE)
})

it('with no sign-in in progress there is nothing to send a code to', async () => {
  expect(await store.submitLoginCode(CLAUDE, CODE)).toBe(false)
  expect(sent.map((one) => one.method)).not.toContain('runtime/login/code')
})

it('an expired wait clears only its matching login and explains that the agent may still finish', async () => {
  await store.startLogin(CLAUDE, 'cli-browser')
  handlers().onEvent(CLAUDE, { type: 'account/loginCompleted', runtime: CLAUDE, loginId: 'older', success: false, reason: 'wait-expired' })
  expect(store.getSnapshot().logins[CLAUDE]?.outcome.type).toBe('pending')
  handlers().onEvent(CLAUDE, { type: 'account/loginCompleted', runtime: CLAUDE, loginId: 'login-1', success: false, reason: 'wait-expired' })
  expect(store.getSnapshot().logins[CLAUDE]).toBeUndefined()
  expect(store.getSnapshot().notices.at(-1)?.message).toMatch(/stopped waiting.*may still finish/i)
})

it('does not resurrect a login whose expiry arrived before its start response', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(store.transport.request).mockImplementationOnce(() => new Promise(r => { resolve = r }) as never)
  const starting = store.startLogin(CLAUDE, 'cli-browser')
  handlers().onEvent(CLAUDE, { type: 'account/loginCompleted', runtime: CLAUDE, loginId: 'login-fast', success: false, reason: 'wait-expired' })
  resolve({ type: 'browser', loginId: 'login-fast' })
  await starting
  expect(store.getSnapshot().logins[CLAUDE]).toBeUndefined()
  expect(store.getSnapshot().notices.at(-1)?.message).toMatch(/stopped waiting.*may still finish/i)
})

it('retains a successful completion that arrives before its start response', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(store.transport.request).mockImplementationOnce(() => new Promise(r => { resolve = r }) as never)
  const starting = store.startLogin(CLAUDE, 'cli-browser')
  handlers().onEvent(CLAUDE, { type: 'account/loginCompleted', runtime: CLAUDE, loginId: 'login-fast', success: true })
  resolve({ type: 'browser', loginId: 'login-fast' })
  await starting
  expect(store.getSnapshot().logins[CLAUDE]?.outcome.type).toBe('succeeded')
})

it('does not let an older start response replace a newer login', async () => {
  let old!: (value: unknown) => void
  let newer!: (value: unknown) => void
  vi.mocked(store.transport.request)
    .mockImplementationOnce(() => new Promise(r => { old = r }) as never)
    .mockImplementationOnce(() => new Promise(r => { newer = r }) as never)
  const first = store.startLogin(CLAUDE, 'old')
  const second = store.startLogin(CLAUDE, 'new')
  newer({ type: 'browser', loginId: 'new' })
  await second
  old({ type: 'browser', loginId: 'old' })
  await first
  expect(store.getSnapshot().logins[CLAUDE]?.start.loginId).toBe('new')
  expect(sent).toContainEqual({ method: 'runtime/login/cancel', params: { runtime: CLAUDE, loginId: 'old' } })
})


it('an expiry for another runtime with the same login id leaves this login alone', async () => {
  await store.startLogin(CLAUDE, 'cli-browser')
  const other = runtimeId('other')
  handlers().onEvent(other, { type: 'account/loginCompleted', runtime: other, loginId: 'login-1', success: false, reason: 'wait-expired' })
  expect(store.getSnapshot().logins[CLAUDE]?.outcome.type).toBe('pending')
})

it('cancelling while a start is in flight drops the eventual claim', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(store.transport.request).mockImplementationOnce(() => new Promise(r => { resolve = r }) as never)
  const starting = store.startLogin(CLAUDE, 'cli-browser')
  await store.cancelLogin(CLAUDE)
  resolve({ type: 'browser', loginId: 'late' })
  await starting
  expect(store.getSnapshot().logins[CLAUDE]).toBeUndefined()
  expect(sent).toContainEqual({ method: 'runtime/login/cancel', params: { runtime: CLAUDE, loginId: 'late' } })
})
