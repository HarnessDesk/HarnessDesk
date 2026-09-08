import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Account, AccountStatus, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SignIn } from './SignIn'

/**
 * A second account of one agent, on the page that offers it.
 *
 * Three things went wrong here at once, and all three read to a person as
 * "adding another account does not work":
 *
 *  - an account made a second ago has not answered `runtime/account` yet, and
 *    the page said the agent "needs no account here" — the one pane with
 *    nothing to press, at the moment the user asked to sign in;
 *  - the card printed the same email twice and put the path to the credential
 *    in a code chip inside a paragraph, where a long one overran the column;
 *  - and the sign-in it sends you to uses whichever account the browser is
 *    already in, which the page only mentioned afterwards, in the notice
 *    saying the account had been taken away again.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const runtime = (over: Record<string, unknown>): RuntimeInfo =>
  ({
    version: '1.0.0',
    capabilities: { account: true },
    presentation: { name: 'Codex' },
    ...over,
  }) as unknown as RuntimeInfo

const status = (accounts: readonly Partial<Account>[], flows: readonly string[]): AccountStatus =>
  ({
    accounts,
    signInMethods: flows.map((flow, index) => ({ id: `m${index}`, label: `Sign in ${flow}`, flow })),
  }) as unknown as AccountStatus

const PRIMARY = runtime({
  id: 'codex',
  name: 'Codex',
  presentation: { name: 'Codex', configLocation: '~/.codex' },
  slot: { agent: 'codex', home: '/Users/dev/.codex', removable: false, canAdd: true },
})

const SECOND = runtime({
  id: 'codex-7f3a91',
  name: 'Codex',
  presentation: { name: 'Codex', configLocation: '~/.codex' },
  slot: {
    agent: 'codex',
    home: '/Users/dev/.harnessdesk/accounts/codex-7f3a91',
    removable: true,
    canAdd: true,
  },
})

/** The card, without the roster beside it. */
const detail = (): HTMLElement => {
  const dialog = container.querySelector('[role=dialog]')
  const split = dialog?.children[1]
  const pane = [...(split?.children ?? [])].find((node) => node.tagName !== 'NAV')
  if (!(pane instanceof HTMLElement)) throw new Error('no detail pane')
  return pane
}

const mount = async (over: Partial<AppSnapshot>, on = 'codex'): Promise<void> => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: 'codex',
    runtimes: [PRIMARY, SECOND],
    ...over,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: vi.fn(async () => {}),
    acpRegistry: vi.fn(async () => ({ agents: [], fetchedAt: 1 })),
    addAccount: vi.fn(async () => null),
    removeAccount: vi.fn(async () => {}),
    startLogin: vi.fn(async () => {}),
    cancelLogin: vi.fn(async () => {}),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <SignIn runtime={on as never} onClose={() => {}} />
      </StoreProvider>,
    )
  })
}

it('says a new account is still starting rather than that it needs none', async () => {
  // The host has registered the runtime and told every client, but the agent
  // has not answered for itself yet — so there are no ways in to offer. That
  // is a wait, not a verdict.
  await mount({ accountsByRuntime: { codex: status([{ label: 'ada@example.com' }], ['browser']) } } as never, 'codex-7f3a91')

  expect(container.textContent).toContain('Starting')
  expect(container.textContent).not.toContain('needs no account here')
})

it('still says an agent needs no account when it has answered and offers none', async () => {
  await mount({ accountsByRuntime: { 'codex-7f3a91': status([], []) } } as never, 'codex-7f3a91')

  expect(container.textContent).toContain('needs no account here')
  expect(container.textContent).not.toContain('Starting Codex')
})

it('names the account already held before sending you to the browser', async () => {
  await mount(
    {
      accountsByRuntime: {
        codex: status([{ label: 'ada@example.com', email: 'ada@example.com' }], ['browser']),
        'codex-7f3a91': status([], ['browser']),
      },
      logins: {
        'codex-7f3a91': {
          method: 'm0',
          start: { type: 'browser', loginId: 'l1', url: 'https://auth.example/authorize' },
          outcome: { type: 'pending' },
        },
      },
    } as never,
    'codex-7f3a91',
  )

  expect(detail().textContent).toContain('Sign in as somebody else')
  // In the card, not the rail — the roster prints that same label for the
  // primary row, so `container` would pass with the warning missing.
  expect(detail().textContent).toContain('ada@example.com')
})

it('does not warn about the browser when there is no other account to collide with', async () => {
  // The guard is "is there a peer", not "which row is this". Only the primary
  // exists here and it holds nothing, so there is no identity a repeat
  // sign-in could land on.
  await mount(
    {
      accountsByRuntime: { codex: status([], ['browser']) },
      logins: {
        codex: {
          method: 'm0',
          start: { type: 'browser', loginId: 'l1', url: 'https://auth.example/authorize' },
          outcome: { type: 'pending' },
        },
      },
    } as never,
    'codex',
  )

  expect(detail().textContent).toContain('Waiting for you in the browser')
  expect(detail().textContent).not.toContain('Sign in as somebody else')
})

it('warns the agent’s own account too — the fold takes the second row either way', async () => {
  // `Host.#foldDuplicateAccount` drops the *removable* row whichever side
  // signed in, so signing the primary back in as somebody the second account
  // already is takes that second account away. Gating the warning on
  // `slot.removable` excluded exactly this case, and the test that was meant
  // to cover it passed either way because its fixture had no peer to name.
  await mount(
    {
      accountsByRuntime: {
        codex: status([], ['browser']),
        'codex-7f3a91': status([{ label: 'grace@example.com', email: 'grace@example.com' }], ['browser']),
      },
      logins: {
        codex: {
          method: 'm0',
          start: { type: 'browser', loginId: 'l1', url: 'https://auth.example/authorize' },
          outcome: { type: 'pending' },
        },
      },
    } as never,
    'codex',
  )

  expect(detail().textContent).toContain('Sign in as somebody else')
  expect(detail().textContent).toContain('grace@example.com')
})

it('a starting account is not counted as connected, and the rail does not call it accountless', async () => {
  // The detail pane said "Starting"; the rail said "Runs without one" and the
  // header counted it as connected. Two answers to one question, in one view.
  await mount({ accountsByRuntime: { codex: status([{ label: 'ada@example.com' }], ['browser']) } } as never, 'codex-7f3a91')

  const rail = container.querySelector('nav[aria-label="Agents"]')
  expect(rail?.textContent).not.toContain('Runs without one')
  expect(rail?.textContent).toContain('Starting')
  expect(rail?.textContent).toContain('1 of 2 connected')
})

it('says an account did not start, rather than spinning on an answer that is not coming', async () => {
  // `status === null` is true for an agent coming up and for one that never
  // will. Health is the only thing that tells them apart, and a second
  // account is never the active runtime, so this pane is the only reader.
  await mount(
    {
      accountsByRuntime: { codex: status([{ label: 'ada@example.com' }], ['browser']) },
      healthByRuntime: {
        'codex-7f3a91': {
          state: 'unavailable',
          reason: 'crashed',
          message: 'The Codex app-server exited before it was ready.',
          remediation: 'Check that codex runs from a terminal.',
        },
      },
    } as never,
    'codex-7f3a91',
  )

  expect(detail().textContent).toContain('did not start')
  expect(detail().textContent).toContain('exited before it was ready')
  expect(detail().textContent).not.toContain('as soon as it answers')
})

it('shows a connected account once, with its credential home on a line of its own', async () => {
  await mount({
    accountsByRuntime: {
      codex: status(
        [{ kind: 'chatgpt', label: 'ada@example.com', email: 'ada@example.com', planType: 'team' }],
        ['browser'],
      ),
    },
  } as never)

  // The email is the title; the second line is the plan, not the email again.
  // Counted in the card alone — the roster rail names the account too, which
  // is the rail doing its job.
  const card = detail()
  const emails = card.textContent?.match(/ada@example\.com/g) ?? []
  expect(emails).toHaveLength(1)
  expect(card.textContent).toContain('team')

  // The path is its own element, so it can wrap instead of overrunning.
  const path = [...container.querySelectorAll('code')].map((node) => node.textContent)
  expect(path).toContain('~/.codex')

  // Both actions on one row, the one you came for first.
  const actions = [...container.querySelectorAll('button')]
    .map((node) => node.textContent?.trim())
    .filter((text) => text === 'Add another account' || text === 'Sign out')
  expect(actions).toEqual(['Add another account', 'Sign out'])
})
