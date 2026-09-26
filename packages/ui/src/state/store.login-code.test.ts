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
