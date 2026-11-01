import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Account, AccountStatus, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, AppStore, type AppSnapshot } from '../state/store'
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

const mount = async (over: Partial<AppSnapshot>, on = 'codex', onClose: () => void = () => {}, overrides: Partial<AppStore> = {}): Promise<AppStore> => {
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
    ...overrides,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <SignIn runtime={on as never} onClose={onClose} />
      </StoreProvider>,
    )
  })
  return store
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

it('renders an empty adapter identity record as signed out in both rail and card (#1776)', async () => {
  // What the adapter answers for an agent whose identity home is empty and
  // which declares no ACP methods: nobody, and one way in that is outside the
  // desk. The renderer must not mistake it for an accountless agent. This is a
  // literal on purpose, since the UI never imports another package's build; the
  // adapter's own test (`an empty identity status offers external sign-in…`)
  // pins this exact shape, so the two cannot drift apart unseen.
  const emptyHome = runtime({ id: 'agent', name: 'Agent', presentation: { name: 'Agent' } })
  const signedOut: AccountStatus = {
    accounts: [],
    signInMethods: [{
      id: 'external', label: 'Sign in outside HarnessDesk', flow: 'external',
      description: "Sign in using the agent's own application or command line.",
    }],
  }
  await mount({
    runtimes: [emptyHome], activeRuntime: emptyHome.id,
    healthByRuntime: { [emptyHome.id]: { state: 'ready' } },
    accountsByRuntime: { [emptyHome.id]: signedOut },
  }, 'agent')

  const rail = container.querySelector('nav[aria-label="Runtimes"]')
  expect(rail?.querySelector('[aria-label="Connected"]')).toBeNull()
  expect(rail?.querySelector('[aria-label="Not connected"]')?.textContent).toContain('Agent')
  expect(detail().querySelector('[data-slot="sign-in-head"]')?.textContent).toContain('Not connected.')
  expect(detail().textContent).toContain('Sign in outside HarnessDesk')
  expect(container.textContent).not.toContain('Runs without one')
  expect(container.textContent).not.toContain('needs no account here')
  expect(container.textContent).not.toContain('Signed in elsewhere')
})

/* #1759. An ACP agent says whether it is signed in only when a session
   opens, so before one it answers with nobody and no verdict. The pane read
   that as "needs no account here" — with nothing to press — about an agent
   that declared four ways to sign in. */
const AGENT = runtime({
  id: 'agent',
  name: 'Agent',
  capabilities: { account: false },
  presentation: { name: 'Agent', configLocation: '~/.agent' },
})

it('says an agent nobody has asked yet is not checked, and keeps its own ways in', async () => {
  await mount({
    runtimes: [PRIMARY, AGENT],
    accountsByRuntime: {
      agent: {
        accounts: [],
        signInMethods: [{ id: 'acp:google', label: 'Log in with Google', flow: 'browser' }],
        unchecked: true,
      },
    },
  } as never, 'agent')

  const card = detail()
  expect(card.textContent).toContain('Not checked yet')
  expect(card.textContent).not.toContain('needs no account here')
  expect(card.querySelector('[aria-label="Ways to connect"]')?.textContent).toContain('Log in with Google')
  const rail = container.querySelector('nav')
  expect(rail?.textContent).toContain('Not checked yet')
  expect(rail?.textContent).not.toContain('Runs without one')
})

it('says an unchecked agent is not checked even before it has declared a way in', async () => {
  await mount({
    runtimes: [PRIMARY, AGENT],
    accountsByRuntime: { agent: { accounts: [], signInMethods: [], unchecked: true } },
  } as never, 'agent')

  expect(detail().textContent).toContain('Not checked yet')
  expect(container.textContent).not.toContain('needs no account here')
  expect(container.textContent).not.toContain('Runs without one')
})

it('describes an unverified extra account without an ACP-specific first-conversation claim', async () => {
  const extra = { ...SECOND, slot: { ...SECOND.slot!, forgetUnknown: true as const } }
  await mount({ runtimes: [PRIMARY, extra], accountsByRuntime: { [extra.id]: { ...status([], ['browser']), unchecked: true } } } as never, extra.id)
  expect(detail().textContent).toContain('Not checked yet')
  expect(detail().textContent).not.toContain('when its first conversation opens')
  expect(detail().querySelector('[aria-label="Ways to connect"]')?.textContent).toContain('Sign in browser')
})

for (const broken of [false, true]) {
  it(`confirms forgetting an unknown extra from the ${broken ? 'unavailable' : 'sign-in'} card`, async () => {
    const extra = { ...SECOND, slot: { ...SECOND.slot!, forgetUnknown: true as const } }
    const removeAccount = vi.fn(async () => {})
    await mount({ runtimes: [PRIMARY, extra], accountsByRuntime: { [extra.id]: status([], ['browser']) }, ...(broken ? { healthByRuntime: { [extra.id]: { state: 'unavailable', reason: 'notInstalled', message: 'Unavailable' } } } : {}) } as never, extra.id, () => {}, { removeAccount })
    const remove = [...detail().querySelectorAll('button')].find(button => button.textContent?.trim() === 'Remove this account')!
    expect(remove).toBeTruthy()
    await act(async () => remove.click())
    expect(removeAccount).not.toHaveBeenCalled()
    const dialog = document.body.querySelector('[role="alertdialog"]')!
    expect(dialog?.textContent).toContain('credentials may remain')
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Remove account')!
    await act(async () => confirm.click())
    expect(removeAccount).toHaveBeenCalledWith(extra.id)
  })
}

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
  // It is a labelled group — the section head every group on the page wears — over its note.
  const caution = [...detail().querySelectorAll('[data-slot="section-name"]')].find((node) => node.textContent === 'Sign in as somebody else')
  expect(caution?.closest('[data-section-head]')?.nextElementSibling?.getAttribute('data-slot')).toBe('note')
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

  const rail = container.querySelector('nav[aria-label="Runtimes"]')
  expect(rail?.textContent).not.toContain('Runs without one')
  // It waits with the ones not connected, saying it is starting, and the
  // connected group counts only the account that answered.
  const waiting = rail?.querySelector('[role="group"][aria-label="Not connected"]')
  expect(waiting?.textContent).toContain('Starting')
  expect(rail?.querySelector('[role="group"][aria-label="Connected"]')?.textContent).toContain('ada@example.com')
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

  // The path is a fact of its own — the facts card's path row, which gives up
  // its middle rather than overrunning the column — with its consequence as
  // that fact's note.
  const fact = card.querySelector('[data-slot="summary-item"][data-kind="path"]')
  expect(fact?.querySelector('dt')?.textContent).toBe('Credential')
  expect(fact?.querySelector('[data-slot="middle-truncate"]')?.textContent).toContain('~/.codex')
  expect(fact?.querySelector('[data-slot="summary-note"]')?.textContent).toContain('Signing out here signs that CLI out too')

  // Both actions on one row, the one you came for first.
  const actions = [...container.querySelectorAll('button')]
    .map((node) => node.textContent?.trim())
    .filter((text) => text === 'Add another account' || text === 'Sign out')
  expect(actions).toEqual(['Add another account', 'Sign out'])
})

it('composes the shared roster, state and text roles', async () => {
  await mount({
    accountsByRuntime: {
      codex: status(
        [{ kind: 'chatgpt', label: 'ada@example.com', email: 'ada@example.com', planType: 'team' }],
        ['browser'],
      ),
      'codex-7f3a91': status([], ['browser']),
    },
  } as never)

  // The rail is the window rail, one list stretch of groups — what needs you
  // first, each counted in its head — and the work beside it is the dialog's
  // reading body.
  const rail = container.querySelector('nav[aria-label="Runtimes"]')
  expect(rail?.getAttribute('data-slot')).toBe('sign-in-rail')
  expect([...(rail?.querySelectorAll(':scope > [data-slot="sign-in-list"]') ?? [])].map(node => node.getAttribute('data-slot')))
    .toEqual(['sign-in-list'])
  expect(rail?.querySelector(':scope > [data-slot="section-footer"]')?.textContent).toContain('Credentials stay on this machine')
  // Named groups rather than region landmarks; the count is the head's to show.
  expect(rail?.querySelector('section')).toBeNull()
  expect([...(rail?.querySelectorAll('[role="group"]') ?? [])].map((node) => node.getAttribute('aria-label')))
    .toEqual(['Not connected', 'Connected'])
  expect([...(rail?.querySelectorAll('[role="group"] [data-slot="section-name"]') ?? [])].map((node) => node.parentElement?.parentElement?.textContent))
    .toEqual(['Not connected1', 'Connected1'])
  expect(detail().getAttribute('data-slot')).toBe('modal-dialog-body')
  expect(detail().getAttribute('data-layout')).toBe('reading')

  // Under "Not connected" a row does not repeat its group's name.
  const out = rail?.querySelector('[role="group"][aria-label="Not connected"]')
  expect(out?.querySelector('[data-slot="list-row"]')?.textContent).toBe('Codex')

  // The card opens on the agent: its mark in a tile, in the subject's ink,
  // and its name at the subject step — under the dialog's own title, never
  // above it.
  const head = detail().querySelector('[data-slot="sign-in-head"]')
  const headMark = head?.querySelector('svg')?.closest('[data-slot="text"]')
  expect(headMark?.getAttribute('data-role')).toBe('subject')
  expect(headMark?.closest('[data-slot="icon-tile"]')).not.toBeNull()
  expect(head?.tagName).toBe('DIV')
  expect(head?.querySelector('h2')?.getAttribute('data-role')).toBe('subject')

  // The account is a settings row in its group card, its state a toned
  // round tile as its mark.
  const account = detail().querySelector('[data-slot="sign-in-account"]')
  expect(account?.querySelector('[data-slot="icon-tile"]')?.getAttribute('data-tone')).toBe('success')
  expect(account?.textContent).toContain('ada@example.com')
  expect(account?.textContent).toContain('team')
})

it('says an agent\u2019s refusal once, and offers its ways in as rows of one card', async () => {
  // The refusal was appended to every method's description, raw JSON and
  // all, so the same sentence stood under each of them.
  await mount({
    accountsByRuntime: {
      codex: {
        accounts: [],
        refusal: 'Authentication required: Use the agent CLI to authenticate first.',
        signInMethods: [
          { id: 'a', flow: 'browser', label: 'Use an API key', description: 'Requires setting `OPENAI_API_KEY`' },
          { id: 'b', flow: 'browser', label: 'Use a Responses key', description: 'Requires setting `OPENAI_API_KEY`' },
        ],
      },
    },
  } as never)

  const card = detail()
  expect(card.textContent?.match(/Authentication required/g)).toHaveLength(1)
  const group = card.querySelector('[role="group"][aria-label="Ways to connect"]')
  expect(group?.querySelectorAll('button')).toHaveLength(2)
  // The agent's backticks are set as code, not drawn.
  expect(group?.textContent).not.toContain('`')
  expect(group?.querySelector('code')?.textContent).toBe('OPENAI_API_KEY')
})

it('draws one key open under the ways in', async () => {
  await mount({
    accountsByRuntime: {
      codex: {
        accounts: [],
        signInMethods: [
          { id: 'web', flow: 'browser', label: 'Sign in with a browser' },
          { id: 'key', flow: 'apiKey', label: 'API key', keyLabel: 'Codex API key' },
        ],
      },
    },
  } as never)

  const card = detail()
  expect(card.querySelector('[role="group"][aria-label="Ways to connect"]')?.textContent).toBe('Sign in with a browser')
  const input = card.querySelector('input[type="password"]')
  expect(input?.getAttribute('placeholder')).toBe('Paste your Codex API key')
  // A key under a button does not take the focus from it.
  expect(document.activeElement).not.toBe(input)
})

it('keeps offering to replace or remove the key HarnessDesk holds while the agent reads another one first', async () => {
  // The account says where the key in use lives; whether HarnessDesk also has
  // a copy is a separate fact, and it is the copy these buttons act on.
  await mount({
    accountsByRuntime: {
      codex: {
        accounts: [{ kind: 'externalKey', label: 'Codex API key', planType: 'its own store', storedCopy: true, outranksHandedKey: true }],
        signInMethods: [{ id: 'key', flow: 'apiKey', label: 'API key', keyLabel: 'Codex API key' }],
      },
    },
  } as never)

  const buttons = [...detail().querySelectorAll('button')].map((button) => button.textContent)
  expect(buttons).toContain('Replace')
  expect(buttons).toContain('Remove')
  expect(detail().querySelector('input[type="password"]')).toBeNull()
})

describe('what the key dialog says about a key the agent already has somewhere else', () => {
  const keyed = (account: Record<string, unknown>) => ({
    accountsByRuntime: {
      codex: {
        accounts: [{ kind: 'externalKey', label: 'Codex API key', planType: 'its own store', ...account }],
        signInMethods: [{ id: 'key', flow: 'apiKey', label: 'API key', keyLabel: 'Codex API key' }],
      },
    },
  }) as never

  it('says a key stored here is used only if that one is removed, when the agent reads it first', async () => {
    await mount(keyed({ outranksHandedKey: true }))
    const summary = detail().querySelector('[data-slot="status-summary"]')?.textContent
    expect(summary).toContain('It reads one from its own store, ahead of any key stored here.')
    expect(summary).toContain('is used only if that one is removed')
    // It does not promise the opposite.
    expect(detail().textContent).not.toContain('takes precedence')
    // The field stays open: a key saved now is used the day the other goes.
    expect(detail().querySelector('input[type="password"]')).not.toBeNull()
  })

  it('keeps saying a key stored here takes precedence when the agent reads its own after the environment', async () => {
    await mount(keyed({}))
    expect(detail().textContent).toContain('It reads one from its own store. Nothing to do')
    expect(detail().textContent).toContain('which takes precedence')
    expect(detail().textContent).not.toContain('ahead of any key stored here')
  })

  it('says the copy HarnessDesk keeps is used only if the key in use is removed', async () => {
    await mount(keyed({ outranksHandedKey: true, storedCopy: true }))
    const row = detail().querySelector('[data-slot="sign-in-account"]')
    expect(row?.textContent).toContain('Codex API key stored')
    expect(row?.textContent).toContain('Used only if the key in its own store is removed.')
    // "Restart to pick up a change" is false of a copy nobody is reading.
    expect(row?.textContent).not.toContain('Restart a conversation')
  })

  it('keeps the restart note on a stored key that is the one in use', async () => {
    await mount({
      accountsByRuntime: {
        codex: {
          accounts: [{ kind: 'apiKey', label: 'Codex API key', planType: 'API key' }],
          signInMethods: [{ id: 'key', flow: 'apiKey', label: 'API key', keyLabel: 'Codex API key' }],
        },
      },
    } as never)
    const row = detail().querySelector('[data-slot="sign-in-account"]')
    expect(row?.textContent).toContain('Restart a conversation to pick up a change.')
    expect(row?.textContent).not.toContain('Used only if')
  })
})

it('offers only the empty field while the agent reads a key HarnessDesk holds no copy of', async () => {
  await mount({
    accountsByRuntime: {
      codex: {
        accounts: [{ kind: 'externalKey', label: 'Codex API key', planType: 'its own store' }],
        signInMethods: [{ id: 'key', flow: 'apiKey', label: 'API key', keyLabel: 'Codex API key' }],
      },
    },
  } as never)

  const buttons = [...detail().querySelectorAll('button')].map((button) => button.textContent)
  expect(buttons).not.toContain('Remove')
  expect(detail().querySelector('input[type="password"]')).not.toBeNull()
})

it('sets a one-time code verbatim on the code plate, at the page step', async () => {
  await mount({
    accountsByRuntime: { codex: status([], ['deviceCode']) },
    logins: {
      codex: {
        method: 'm0',
        start: { type: 'deviceCode', loginId: 'l1', url: 'https://example.com/device', code: 'WDJB-MJHT' },
        outcome: { type: 'pending' },
      },
    },
  } as never)

  const code = detail().querySelector('[aria-label="One-time code"]')
  expect(code?.tagName).toBe('CODE')
  expect(code?.getAttribute('data-slot')).toBe('code-text')
  expect(code?.hasAttribute('data-block')).toBe(true)
  expect(code?.getAttribute('data-ground')).toBe('muted')
  // Spaced, so its groups read across a room.
  expect(code?.hasAttribute('data-spaced')).toBe(true)
  const words = code?.querySelector('[data-slot="text"]')
  expect(words?.getAttribute('data-role')).toBe('page')
  expect(words?.textContent).toBe('WDJB-MJHT')
})

it('labels a way in it cannot drive the way it labels every group, with its sentence under it', async () => {
  await mount({
    accountsByRuntime: {
      codex: {
        accounts: [],
        signInMethods: [{ id: 'x', flow: 'external', label: 'Signed in from a terminal', description: 'Run codex login.' }],
      },
    },
  } as never)

  const label = [...detail().querySelectorAll('[data-slot="section-name"]')].find((node) => node.textContent === 'Signed in from a terminal')
  expect(label).toBeTruthy()
  expect(label?.closest('[data-section-head]')?.nextElementSibling?.getAttribute('data-slot')).toBe('note')
  expect(label?.closest('[data-section-head]')?.nextElementSibling?.textContent).toBe('Run codex login.')
})

it('wears the head every dialog wears, and its way out closes the sheet', async () => {
  // It drew a title band of its own — its own inset and rule, a larger cross
  // at another gap — beside every other dialog's head.
  const onClose = vi.fn()
  await mount({ accountsByRuntime: { codex: status([], ['browser']) } } as never, 'codex', onClose)
  const dialog = container.querySelector('[role=dialog]')
  const head = dialog?.querySelector('[data-slot="dialog-head"]')
  expect(head?.textContent).toBe('Sign in')
  const close = head?.querySelector('button[aria-label="Close"]')
  expect(close).toBeTruthy()
  // The way out is the dialog's own step: a 13px cross, as on every dialog.
  expect(close?.querySelector('svg')?.getAttribute('width')).toBe('13')
  await act(async () => {
    close?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(onClose).toHaveBeenCalled()
})

it('lists an agent signed out as not connected, whatever its ways in are', async () => {
  // Only ways in taken elsewhere, and no account: signed out all the same.
  // And a refusal with no way in at all: it said it needs one, so it is
  // neither "connected" nor an agent that "needs no account here".
  await mount({
    accountsByRuntime: {
      codex: {
        accounts: [],
        signInMethods: [{ id: 'x', flow: 'external', label: 'Use an API key', description: 'Set `OPENAI_API_KEY`.' }],
      },
      'codex-7f3a91': { accounts: [], signInMethods: [], refusal: 'Please log in to use it.' },
    },
  } as never, 'codex-7f3a91')

  const rail = container.querySelector('nav[aria-label="Runtimes"]')
  expect(rail?.querySelector('[role="group"][aria-label="Connected"]')).toBeNull()
  const out = rail?.querySelector('[role="group"][aria-label="Not connected"]')
  expect(out?.querySelectorAll('[data-slot="list-row"]')).toHaveLength(2)
  // The way in taken elsewhere is the line, because it differs.
  expect(out?.textContent).toContain('Use an API key')

  const card = detail()
  expect(card.textContent).toContain('Please log in to use it.')
  expect(card.textContent).not.toContain('needs no account here')
})

it('names a connected account once: no second line that only says it is connected', async () => {
  await mount({
    accountsByRuntime: {
      codex: status([{ kind: 'agent', label: 'Signed in', anonymous: true }], []),
    },
  } as never)
  const rail = container.querySelector('nav[aria-label="Runtimes"]')
  const connected = rail?.querySelector('[role="group"][aria-label="Connected"]')
  expect(connected?.querySelector('[data-slot="list-row"]')?.textContent).toBe('Codex')
  const account = detail().querySelector('[data-slot="sign-in-account"]')
  expect(account?.textContent).toBe('Signed in')
})

it('opens an agent whose only way in is a key on its field, with the label on the input', async () => {
  await mount({
    accountsByRuntime: {
      codex: { accounts: [], signInMethods: [{ id: 'key', flow: 'apiKey', label: 'API key', keyLabel: 'Codex API key' }] },
    },
  } as never)
  const input = detail().querySelector('input[type="password"]') as HTMLInputElement | null
  expect(input).not.toBeNull()
  expect(document.activeElement).toBe(input)
  expect(detail().querySelector(`label[for="${input?.id}"]`)?.textContent).toBe('Codex API key')
})

it('keeps an added credential separate from the runtime’s own sessions', async () => {
  await mount({ accountsByRuntime: { [SECOND.id]: status([{ kind: 'chatgpt', label: 'dev@example.com' }], ['browser']) } } as never, SECOND.id)
  expect(detail().textContent).toContain('Only the credential lives there — the sessions are the runtime’s own.')
})


describe('naming another account', () => {
  const setup = async (asksName = true, addResult = async () => ({ runtime: 'new-account' })) => {
    const info = runtime({ ...PRIMARY, slot: { ...PRIMARY.slot, ...(asksName ? { asksName: true, ownSessions: true } : {}) } })
    const request = vi.fn(addResult)
    const store = await mount({ runtimes: [info], accountsByRuntime: { codex: status([{ label: 'dev@example.com' }], ['browser']) } } as never,
      'codex', () => {}, { transport: { request } as never, addAccount: AppStore.prototype.addAccount })
    const press = async (label: string) => {
      const target = [...document.body.querySelectorAll('button')].find(node => node.textContent?.trim() === label)
      expect(target, label).toBeDefined()
      await act(async () => target!.click())
    }
    await press('Add another account')
    return { request, store, press }
  }

  it('opens the name dialog before adding anything', async () => {
    const { request } = await setup()
    expect(request).not.toHaveBeenCalled()
    const dialog = document.body.querySelector('[role="dialog"][aria-label="Name this account"]')
    expect(dialog).not.toBeNull()
    const input = dialog?.querySelector('input')
    expect(input?.placeholder).toBe('Codex 2')
    expect(input?.maxLength).toBe(80)
    expect(dialog?.textContent).toContain('Name it after the account you will sign in to, for example “Work” or dev@example.com.')
    expect(dialog?.textContent).not.toContain('Google')
    expect(dialog?.textContent).toContain('Work')
  })

  it.each(['Work', ''])('sends the entered name %j only when nonempty', async (name) => {
    const { request, press } = await setup()
    const field = document.body.querySelector<HTMLInputElement>('[role="dialog"][aria-label="Name this account"] input')
    expect(field).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, name)
      field!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await press('Add')
    expect(request).toHaveBeenCalledWith('runtime/account/add', { runtime: 'codex', ...(name ? { name } : {}) })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['Cancel', 'Escape'])('%s adds nothing', async (action) => {
    const { request, press } = await setup()
    expect(document.body.querySelector('[aria-label="Name this account"]')).not.toBeNull()
    if (action === 'Cancel') await press(action)
    else await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.body.querySelector('[aria-label="Name this account"]')).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps Cancel disabled and refuses Escape while an add is pending', async () => {
    let resolve!: (value: { runtime: string }) => void
    const pending = new Promise<{ runtime: string }>(done => { resolve = done })
    const { request, press } = await setup(true, () => pending)
    try {
      await press('Add')
      const dialog = () => document.body.querySelector('[aria-label="Name this account"]')
      const cancel = [...dialog()!.querySelectorAll('button')].find(node => node.textContent === 'Cancel')!
      expect(cancel.disabled).toBe(true)
      await act(async () => cancel.click())
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      expect(dialog()).not.toBeNull()
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => { resolve({ runtime: 'new-account' }); await pending })
    }
  })

  it('Enter submits Work once even when pressed twice before the add resolves', async () => {
    let resolve!: (value: { runtime: string }) => void
    const pending = new Promise<{ runtime: string }>(done => { resolve = done })
    const { request } = await setup(true, () => pending)
    try {
      const input = document.body.querySelector<HTMLInputElement>('[aria-label="Name this account"] input')!
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Work')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(request).toHaveBeenCalledWith('runtime/account/add', { runtime: 'codex', name: 'Work' })
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => { resolve({ runtime: 'new-account' }); await pending })
    }
  })

  it('adds straight away when a name is not requested', async () => {
    const { request } = await setup(false)
    expect(request).toHaveBeenCalledWith('runtime/account/add', { runtime: 'codex' })
    expect(document.body.querySelector('[aria-label="Name this account"]')).toBeNull()
  })
})


it.each([
  { accounts: [], signInMethods: [] },
  { accounts: [], signInMethods: [], unchecked: true },
  { accounts: [{ kind: 'agent', label: 'dev@example.com' }], signInMethods: [] },
  { accounts: [], signInMethods: [{ id: 'login', label: 'Sign in', flow: 'browser' }] },
])('an unavailable agent takes precedence over its account answer (#1764): %j', async (answer) => {
  await mount({
    runtimes: [AGENT],
    accountsByRuntime: { agent: answer },
    healthByRuntime: { agent: {
      state: 'unavailable', reason: 'notInstalled',
      message: 'The agent executable was not found.', remediation: 'Install the agent CLI.',
    } },
  } as never, 'agent')
  const card = detail()
  expect(card.textContent).toContain('Agent did not start')
  expect(card.textContent).toContain('The agent executable was not found.')
  expect(card.textContent).toContain('Install the agent CLI.')
  expect(card.textContent).not.toContain('needs no account here')
  const rail = container.querySelector('nav')
  expect(rail?.querySelector('[aria-label="Connected"]')).toBeNull()
  expect(rail?.querySelector('[aria-label="Not connected"]')?.textContent).toContain('Did not start')
})
