import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type AccountStatus, type RuntimeInfo } from '@harnessdesk/protocol'

import { accountKey } from '../lib/accounts'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { dismissOverlays } from './Popover'
import { AccountFooter } from './Sidebar'

/**
 * The seat: you, and the agent you will pick up next.
 *
 * The row is the desk's identity and the badge at its end is the agent new
 * sessions run as — the app's default, never the focused conversation's. It
 * used to print the account's name and the focused conversation's mark, so
 * it changed on every switch and every pane focus, and it called an account
 * "you". Pinned: what the row says, what it does not say, which agent the
 * badge and the tick follow, and what the card on the badge offers.
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
  vi.useRealTimers()
})

const CODEX = runtimeId('codex')
const CLAUDE = runtimeId('claude-code')

const runtime = (id: string, name: string, brand: string): RuntimeInfo =>
  ({
    id,
    name,
    capabilities: { account: true },
    presentation: { name, brand },
  }) as unknown as RuntimeInfo

const codex = runtime(CODEX, 'OpenAI Codex', 'codex')
const claude = runtime(CLAUDE, 'Claude Code', 'claude')

const signedIn = (label: string): AccountStatus => ({
  accounts: [{ kind: 'oauth', label }],
  signInMethods: [],
})
const signedOut: AccountStatus = {
  accounts: [],
  signInMethods: [{ id: 'browser', label: 'Sign in', flow: 'browser' }],
} as unknown as AccountStatus

const mount = (overrides: Partial<AppSnapshot> = {}) => {
  const selectRuntime = vi.fn(async () => {})
  const onOpenSettings = vi.fn()
  const claudeAccount = signedIn('olivia@acme.dev')
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [codex, claude],
    // Claude is the default; a Codex conversation is what is on screen.
    activeRuntime: CLAUDE,
    activeSessionKey: sessionKey(CODEX, sessionId('s-1')),
    accountsByRuntime: { [CODEX]: signedIn('shane@vaultx.tech'), [CLAUDE]: claudeAccount },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [CLAUDE]: { state: 'ready' } },
    accountPrefs: { [accountKey(CLAUDE, claudeAccount.accounts[0]!)]: { nickname: 'Shane-Claude' } },
    ...overrides,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    selectRuntime,
    signOutAgent: vi.fn(async () => {}),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AccountFooter onOpenSettings={onOpenSettings} onOpenUsage={() => {}} onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
  return { selectRuntime, onOpenSettings }
}

const row = (): HTMLButtonElement => {
  const found = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
  if (!found) throw new Error('no seat row')
  return found
}

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

it('is the desk, wearing the default agent — not the account, and not the conversation on screen', () => {
  mount()
  const seat = row()
  expect(seat.textContent).toContain('HarnessDesk')
  expect(seat.textContent).not.toContain('Shane-Claude')
  expect(seat.textContent).not.toContain('olivia')
  // The badge is Claude's, the default, while a Codex conversation is focused.
  expect(seat.querySelector('.brand-claude')).not.toBeNull()
  expect(seat.querySelector('.brand-codex')).toBeNull()
  // The account is one hover away, and the tooltip names the pen in full.
  expect(seat.getAttribute('title')).toBe('New sessions run as Claude · Shane-Claude')
  expect(seat.querySelector('[role="img"]')?.getAttribute('data-state')).toBe('ready')
})

it('ticks the default in the menu, chooses on a seat’s press, and signs out of the default agent', () => {
  const { selectRuntime } = mount()
  click(row())
  const ticked = container.querySelector('[role="menuitem"][data-current]')
  expect(ticked?.textContent).toContain('Shane-Claude')
  // Sign-out is the default agent's, not the focused conversation's.
  expect(container.textContent).toContain('Sign out of Claude')
  expect(container.textContent).not.toContain('Sign out of Codex')

  const codexSeat = [...container.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('shane'),
  )
  if (!codexSeat) throw new Error('no Codex seat in the menu')
  click(codexSeat)
  expect(selectRuntime).toHaveBeenCalledWith(CODEX)
})

it('closes when something takes the screen, and a sign-out it was asking about is not waiting when it opens again', () => {
  /* The floating sidebar sends the event as it is put away. Left open, the
     menu came back with the sidebar, the sign-out still asking to be
     confirmed — measured in a real engine. */
  mount()
  click(row())
  const ask = [...container.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('Sign out of'),
  )
  if (!ask) throw new Error('no sign-out row')
  click(ask)
  expect(container.textContent).toContain('need to sign in again')

  act(() => dismissOverlays())
  expect(container.querySelector('[role="menu"]')).toBeNull()

  click(row())
  expect(container.querySelector('[role="menu"]')).not.toBeNull()
  expect(container.textContent).toContain('Sign out of')
  expect(container.textContent).not.toContain('need to sign in again')
})

it('Escape closes the menu and says so, so a sidebar floating under it stays', () => {
  mount()
  click(row())
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => {
    document.dispatchEvent(event)
  })
  expect(container.querySelector('[role="menu"]')).toBeNull()
  expect(event.defaultPrevented).toBe(true)
})

it('dims the badge and colours the dot when the default has no account', () => {
  mount({ accountsByRuntime: { [CODEX]: signedIn('shane@vaultx.tech'), [CLAUDE]: signedOut } })
  const seat = row()
  expect(seat.textContent).toContain('HarnessDesk')
  const badge = seat.querySelector('[data-off]')
  expect(badge?.querySelector('.brand-claude')).not.toBeNull()
  expect(seat.querySelector('[data-tint]')).toBeNull()
  expect(seat.querySelector('[role="img"]')?.getAttribute('data-state')).toBe('signin')
  expect(seat.getAttribute('title')).toBe('New sessions run as Claude')
})

it('opens the account’s card from the badge, and the card offers no switch to what already is the default', () => {
  vi.useFakeTimers()
  mount()
  const trigger = row().querySelector('[data-slot="hover-card-trigger"]')
  if (!trigger) throw new Error('the badge is not a card trigger')
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  const card = document.querySelector('[data-slot="agent-card"]')
  expect(card).not.toBeNull()
  expect(card?.textContent).toContain('Shane-Claude')
  expect(card?.textContent).toContain('olivia@acme.dev')
  expect(card?.textContent).not.toContain('Run new sessions as this')
})

const keeper = runtime(runtimeId('cline'), 'Cline', 'cline')
;(keeper as { capabilities: { account: boolean } }).capabilities = { account: false }

it('an agent that keeps its own credential wears no ring and is not dimmed for it, in the row and in the menu', () => {
  mount({
    runtimes: [codex, claude, keeper],
    activeRuntime: keeper.id,
    accountsByRuntime: { [CODEX]: signedIn('shane@example.com'), [CLAUDE]: signedIn('olivia@acme.dev'), [keeper.id]: { accounts: [], signInMethods: [] } },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [CLAUDE]: { state: 'ready' }, [keeper.id]: { state: 'ready' } },
  })
  const seat = row()
  expect(seat.querySelector('[role="img"]')?.getAttribute('data-state')).toBe('ready')
  const badge = seat.querySelector('[data-slot="hover-card-trigger"] > span')
  expect(badge?.hasAttribute('data-off')).toBe(false)
  expect(badge?.hasAttribute('data-tint')).toBe(false)
  click(seat)
  const item = [...container.querySelectorAll('[role="menuitem"]')].find((el) => /^Cline/.test(el.textContent?.trim() ?? ''))
  expect(item?.textContent).toContain('Ready')
  const disc = item?.querySelector('[data-slot="hover-card-trigger"] > span')
  expect(disc?.hasAttribute('data-off')).toBe(false)
  expect(disc?.hasAttribute('data-tint')).toBe(false)
  // and an account that is signed in still wears its ring
  const claudeItem = [...container.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('Shane-Claude'))
  expect(claudeItem?.querySelector('[data-slot="hover-card-trigger"] > span')?.getAttribute('data-tint')).toBeTruthy()
})

it('a card that was open when the menu took the seat does not come back when the menu closes', () => {
  vi.useFakeTimers()
  mount()
  const trigger = row().querySelector('[data-slot="hover-card-trigger"]')
  if (!trigger) throw new Error('the badge is not a card trigger')
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(document.querySelector('[data-slot="agent-card"]')).not.toBeNull()
  click(row())
  expect(container.querySelector('[role="menu"]')).not.toBeNull()
  expect(document.querySelector('[data-slot="agent-card"]')).toBeNull()
  click(row())
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(container.querySelector('[role="menu"]')).toBeNull()
  expect(document.querySelector('[data-slot="agent-card"]')).toBeNull()
})

it('the badge card’s Usage verb opens the dashboard on that agent', () => {
  vi.useFakeTimers()
  const onOpenUsage = vi.fn()
  const claudeAccount = signedIn('olivia@acme.dev')
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [codex, claude],
    activeRuntime: CLAUDE,
    accountsByRuntime: { [CODEX]: signedIn('shane@example.com'), [CLAUDE]: claudeAccount },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [CLAUDE]: { state: 'ready' } },
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, selectRuntime: vi.fn(async () => {}) } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AccountFooter onOpenSettings={() => {}} onOpenUsage={onOpenUsage} onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
  const trigger = row().querySelector('[data-slot="hover-card-trigger"]')
  act(() => {
    trigger?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  const usage = [...document.querySelectorAll('[data-slot="agent-card"] button')].find((b) => b.textContent?.trim() === 'Usage')
  if (!usage) throw new Error('no Usage verb on the card')
  click(usage)
  expect(onOpenUsage).toHaveBeenCalledWith(CLAUDE)
})

it('is you once you have chosen: your name and your face, with the pen still beside them', () => {
  mount({ profile: { name: 'Jane', avatar: 'wizard' } })
  const seat = row()
  expect(seat.textContent).toContain('Jane')
  expect(seat.textContent).not.toContain('HarnessDesk')
  expect(seat.querySelector('img')?.getAttribute('src')).toMatch(/\/wizard\.png$/)
  expect(seat.querySelector('.brand-harnessdesk')).toBeNull()
  // The default agent's badge is untouched: you are beside the pen, not it.
  expect(seat.querySelector('.brand-claude')).not.toBeNull()
})

it('draws the house mark until a face is chosen', () => {
  mount({ profile: { name: 'Jane' } })
  const seat = row()
  expect(seat.querySelector('img')).toBeNull()
  expect(seat.querySelector('.brand-harnessdesk')).not.toBeNull()
})

it('opens your profile from the top of the menu', () => {
  const { onOpenSettings } = mount({ profile: { name: 'Jane' } })
  click(row())
  const you = container.querySelector('[role="menu"] [role="menuitem"]')
  if (!you) throw new Error('no menu')
  expect(you.textContent).toContain('Jane')
  expect(you.textContent).toContain('Local')
  click(you)
  expect(onOpenSettings).toHaveBeenCalledWith('profile')
  expect(container.querySelector('[role="menu"]')).toBeNull()
})

/** jsdom lays nothing out, so a width is whatever the test says it is. */
const sized = (node: HTMLElement, scroll: number, client: number): void => {
  Object.defineProperty(node, 'scrollWidth', { configurable: true, value: scroll })
  Object.defineProperty(node, 'clientWidth', { configurable: true, value: client })
}

const hover = (node: HTMLElement): void => {
  act(() => {
    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

it('says your whole name on hover only where the row cuts it', () => {
  // A name that fits leaves the row's own title — the pen — to answer; a name
  // the ellipsis cuts says itself whole.
  const name = 'Jane Doe, Keeper of Several Long Names'
  mount({ profile: { name } })
  const seat = row().querySelector<HTMLElement>('[class*="accountLabel"]')
  if (!seat) throw new Error('no seat label')
  sized(seat, 320, 120)
  hover(seat)
  expect(seat.getAttribute('title')).toBe(name)
  sized(seat, 80, 120)
  hover(seat)
  expect(seat.hasAttribute('title')).toBe(false)
  expect(row().getAttribute('title')).toMatch(/^New sessions run as /)

  click(row())
  const menu = container.querySelector<HTMLElement>('[role="menu"] [class*="youLabel"]')
  if (!menu) throw new Error('no menu label')
  sized(menu, 320, 120)
  hover(menu)
  expect(menu.getAttribute('title')).toBe(name)
})
