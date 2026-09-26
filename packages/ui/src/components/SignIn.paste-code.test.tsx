import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SignIn } from './SignIn'

/**
 * A browser sign-in whose command asked for the code the page shows.
 *
 * The command runs in the background, so this field is the only input it
 * has. It is a password field, and the code leaves it the moment it is sent.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CODE = 'pasted-code-5e1f#state-77aa'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const AGENT = {
  id: 'claude',
  name: 'Claude',
  version: '1.0.0',
  capabilities: { account: true },
  presentation: { name: 'Claude' },
} as unknown as RuntimeInfo

const mount = async (awaitingCode: boolean) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: 'claude',
    runtimes: [AGENT],
    accountsByRuntime: {
      claude: { accounts: [], signInMethods: [{ id: 'cli-browser', label: 'Sign in in your browser', flow: 'browser' }] },
    },
    logins: {
      claude: {
        method: 'cli-browser',
        start: { type: 'browser', loginId: 'login-1', url: 'https://auth.example.com/flow', pasteCode: awaitingCode },
        outcome: { type: 'pending' },
        awaitingCode,
      },
    },
  } as unknown as AppSnapshot
  const submitLoginCode = vi.fn(async () => true)
  const cancelLogin = vi.fn(async () => {})
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: vi.fn(async () => {}),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    startLogin: vi.fn(async () => {}),
    cancelLogin,
    submitLoginCode,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <SignIn runtime={'claude' as never} onClose={() => {}} />
      </StoreProvider>,
    )
  })
  return { submitLoginCode, cancelLogin }
}

const field = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('[data-slot="sign-in-paste-code"] input')

const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const button = (label: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((one) => one.textContent === label) as HTMLButtonElement

it('asks for the code in a password field, says where it comes from, and keeps the way out', async () => {
  await mount(true)
  const input = field()
  expect(input?.type).toBe('password')
  expect(input?.autocomplete).toBe('off')
  const pane = container.querySelector('[data-slot="sign-in-paste-code"]')!
  expect(pane.textContent).toContain('Paste the authentication code')
  expect(pane.textContent).toContain('From the browser page that just opened')
  expect(button('Send code').disabled).toBe(true)
  expect(button('Cancel')).toBeTruthy()
})

it('sends the code, and it leaves the field the moment it is sent', async () => {
  const { submitLoginCode } = await mount(true)
  await type(field()!, `  ${CODE}  `)
  await act(async () => button('Send code').click())
  expect(submitLoginCode).toHaveBeenCalledWith('claude', CODE)
  expect(field()!.value).toBe('')
  expect(container.textContent).not.toContain(CODE)
  expect(container.textContent).toContain('Sent.')
})

it('cancel still ends the sign-in while it waits for a code', async () => {
  const { cancelLogin } = await mount(true)
  await act(async () => button('Cancel').click())
  expect(cancelLogin).toHaveBeenCalledWith('claude')
})

it('draws no field for a sign-in that has not asked for a code', async () => {
  await mount(false)
  expect(field()).toBeNull()
  expect(container.textContent).toContain('Waiting for you in the browser')
})
