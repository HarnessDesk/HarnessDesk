import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type AccountStatus, type RuntimeId, type RuntimeInfo, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import { accountKey } from '../lib/accounts'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { dismissOverlays } from '../design'
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

const lane = (over: Partial<UsageLane> & Pick<UsageLane, 'id' | 'usedPercent'>): UsageLane => ({
  label: over.id,
  windowMinutes: 10_080,
  resetsAt: null,
  ...over,
})

const usageReport = (runtime: RuntimeId, lanes: readonly UsageLane[]): UsageReport =>
  ({
    runtime,
    account: 'olivia@acme.dev',
    plan: null,
    lanes,
    credits: null,
    spend: null,
    reached: null,
    source: { kind: 'runtime', label: 'from its own API' },
    fetchedAt: Date.now(),
    staleAfterMs: 600_000,
    error: null,
  }) as unknown as UsageReport

const mount = (overrides: Partial<AppSnapshot> = {}) => {
  const selectRuntime = vi.fn(async () => {})
  const onOpenSettings = vi.fn()
  const onOpenUsage = vi.fn()
  const onSignIn = vi.fn()
  const claudeAccount = signedIn('olivia@acme.dev')
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [codex, claude],
    // Claude is the default; a Codex conversation is what is on screen.
    activeRuntime: CLAUDE,
    activeSessionKey: sessionKey(CODEX, sessionId('s-1')),
    accountsByRuntime: { [CODEX]: signedIn('shane@example.com'), [CLAUDE]: claudeAccount },
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
        <AccountFooter onOpenSettings={onOpenSettings} onOpenUsage={onOpenUsage} onSignIn={onSignIn} />
      </StoreProvider>,
    )
  })
  return { selectRuntime, onOpenSettings, onOpenUsage, onSignIn }
}

const row = (): HTMLButtonElement => {
  const found = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
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
  const ticked = document.querySelector('[role="menuitem"][data-current]')
  expect(ticked?.textContent).toContain('Shane-Claude')
  // Sign-out is the default agent's, not the focused conversation's.
  expect(document.body.textContent).toContain('Sign out of Claude')
  expect(document.body.textContent).not.toContain('Sign out of Codex')
  if (!ticked) throw new Error('no current seat')
  click(ticked)

  const codexSeat = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.getAttribute('title')?.includes('shane'),
  )
  if (!codexSeat) throw new Error('no Codex seat in the menu')
  click(codexSeat)
  expect(selectRuntime).toHaveBeenCalledWith(CODEX)
})

it('asks for its menu above the footer row, at the row’s width', () => {
  mount()
  click(row())
  const panel = document.querySelector('[role="menu"]')?.closest('[data-width]')
  expect(panel?.getAttribute('data-width')).toBe('trigger')
  expect(panel?.closest('[data-side]')?.getAttribute('data-side')).toBe('top')
})

it('keeps the menu on the current account until the picker is opened', () => {
  const { selectRuntime } = mount()
  click(row())

  const menu = document.querySelector('[role="menu"]')
  expect(menu?.textContent).toContain('Shane-Claude')
  expect(menu?.textContent).not.toContain('shane@example.com')

  const current = menu?.querySelector('[data-current]')
  if (!current) throw new Error('no current account')
  click(current)

  const listed = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
  expect(listed.some((item) => item.getAttribute('title') === 'shane@example.com')).toBe(true)
  expect(selectRuntime).not.toHaveBeenCalled()
})

it('enters the canonical menu with ArrowDown and returns focus on Escape', () => {
  mount()
  const trigger = row()
  act(() => {
    trigger.focus()
  })
  click(trigger)
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })

  expect(document.activeElement?.getAttribute('role')).toMatch(/^menuitem/)
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('expands Usage remaining inline and lists the current account windows', () => {
  const report = usageReport(CLAUDE, [
    lane({ id: 'session', label: 'Session', usedPercent: 52, windowMinutes: 300 }),
    lane({ id: 'weekly', label: 'Weekly', usedPercent: 63 }),
  ])
  mount({ usage: [report] })
  click(row())

  const usage = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('Usage remaining'),
  )
  if (!usage) throw new Error('no Usage remaining row')
  expect(usage.getAttribute('aria-expanded')).toBe('false')
  // The one trailing fold: down while folded, up while open.
  const mark = () => usage.querySelector('[data-slot="disclosure-chevron"]')
  expect(mark()?.getAttribute('data-placement')).toBe('trailing')
  expect(mark()?.hasAttribute('data-open')).toBe(false)
  click(usage)

  expect(usage.getAttribute('aria-expanded')).toBe('true')
  expect(mark()?.hasAttribute('data-open')).toBe(true)
  expect(document.querySelector('[data-usage-details]')?.textContent).toContain('Session')
  expect(document.querySelector('[data-usage-details]')?.textContent).toContain('Weekly')
  // The fold is the windows only; Dashboard is its own row just below.
  expect(document.querySelector('[data-usage-details] [role="menuitem"]')).toBeNull()
})

it.each([
  ['with room', 40, 'neutral'],
  ['running low', 88, 'warning'],
  ['spent', 100, 'warning'],
] as const)('folds Usage remaining under a mark in the figure\'s trouble — %s', (_state, usedPercent, tone) => {
  // A fold has one trouble tone: a spent window's red figure folds under the
  // warning mark, a low one's amber figure too, and room is neutral.
  mount({ usage: [usageReport(CLAUDE, [lane({ id: 'weekly', label: 'Weekly', usedPercent })])] })
  click(row())
  const usage = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('Usage remaining'),
  )
  expect(usage?.querySelector('[data-slot="disclosure-chevron"]')?.getAttribute('data-tone')).toBe(tone)
})

it('resets expanded account and usage state when the trigger closes and reopens the menu', () => {
  const report = usageReport(CLAUDE, [
    lane({ id: 'session', label: 'Session', usedPercent: 52, windowMinutes: 300 }),
    lane({ id: 'weekly', label: 'Weekly', usedPercent: 63 }),
  ])
  mount({ usage: [report] })
  click(row())

  const current = document.querySelector('[data-current]')
  if (!current) throw new Error('no current account')
  click(current)
  const usage = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('Usage remaining'),
  )
  if (!usage) throw new Error('no Usage remaining row')
  click(usage)
  expect(document.querySelector('[data-usage-details]')).not.toBeNull()

  click(row())
  expect(document.querySelector('[role="menu"]')).toBeNull()

  click(row())
  const reopened = document.querySelector('[role="menu"]')
  expect(reopened?.textContent).not.toContain('shane@example.com')
  expect(reopened?.querySelector('[data-current]')).not.toBeNull()
  const reopenedUsage = [...(reopened?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) =>
    item.textContent?.includes('Usage remaining'),
  )
  expect(reopenedUsage?.getAttribute('aria-expanded')).toBe('false')
  expect(reopened?.querySelector('[data-usage-details]')).toBeNull()
})

it.each([
  ['Settings', 'settings'],
  ['Dashboard', 'usage'],
  ['Add an account…', 'signIn'],
] as const)('resets expanded state when %s closes the menu', (_label, callback) => {
  const { onOpenSettings, onOpenUsage, onSignIn } = mount({
    usage: [
      usageReport(CLAUDE, [
        lane({ id: 'session', label: 'Session', usedPercent: 52, windowMinutes: 300 }),
        lane({ id: 'weekly', label: 'Weekly', usedPercent: 63 }),
      ]),
    ],
  })

  const expand = () => {
    click(row())
    const current = document.querySelector('[data-current]')
    if (!current) throw new Error('no current account')
    click(current)
    const usage = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes('Usage remaining'),
    )
    if (!usage) throw new Error('no Usage remaining row')
    click(usage)
    expect(document.querySelector('[data-usage-details]')).not.toBeNull()
  }

  const reopenCollapsed = () => {
    click(row())
    const reopened = document.querySelector('[role="menu"]')
    expect(reopened?.textContent).not.toContain('shane@example.com')
    expect(reopened?.querySelector('[data-current]')).not.toBeNull()
    const usage = [...(reopened?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) =>
      item.textContent?.includes('Usage remaining'),
    )
    expect(usage?.getAttribute('aria-expanded')).toBe('false')
    expect(reopened?.querySelector('[data-usage-details]')).toBeNull()
  }

  expand()
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((candidate) =>
    candidate.textContent?.includes(_label),
  )
  if (!item) throw new Error(`no ${_label} row`)
  click(item)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  if (callback === 'settings') expect(onOpenSettings).toHaveBeenCalled()
  if (callback === 'usage') expect(onOpenUsage).toHaveBeenCalled()
  if (callback === 'signIn') expect(onSignIn).toHaveBeenCalled()
  reopenCollapsed()
})

it('closes when something takes the screen, and a sign-out it was asking about is not waiting when it opens again', () => {
  /* The floating sidebar sends the event as it is put away. Left open, the
     menu came back with the sidebar, the sign-out still asking to be
     confirmed — measured in a real engine. */
  mount()
  click(row())
  const ask = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('Sign out of'),
  )
  if (!ask) throw new Error('no sign-out row')
  click(ask)
  expect(document.body.textContent).toContain('need to sign in again')

  act(() => dismissOverlays())
  expect(document.querySelector('[role="menu"]')).toBeNull()

  click(row())
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(document.body.textContent).toContain('Sign out of')
  expect(document.body.textContent).not.toContain('need to sign in again')
})

it('Escape closes the menu and says so, so a sidebar floating under it stays', () => {
  mount()
  click(row())
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => {
    document.dispatchEvent(event)
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(event.defaultPrevented).toBe(true)
})

it('dims the badge and colours the dot when the default has no account', () => {
  mount({ accountsByRuntime: { [CODEX]: signedIn('shane@example.com'), [CLAUDE]: signedOut } })
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
    trigger.dispatchEvent(new MouseEvent('mouseenter'))
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
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => /^Cline/.test(el.textContent?.trim() ?? ''))
  // Ready says nothing on the row; the tooltip still answers.
  expect(item?.textContent).not.toContain('Ready')
  expect(item?.getAttribute('title')).toBe('Ready')
  const disc = item?.querySelector('[data-slot="hover-card-trigger"] > span')
  expect(disc?.hasAttribute('data-off')).toBe(false)
  expect(disc?.hasAttribute('data-tint')).toBe(false)
  // and an account that is signed in still wears its ring
  const claudeItem = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('Shane-Claude'))
  expect(claudeItem?.querySelector('[data-slot="hover-card-trigger"] > span')?.getAttribute('data-tint')).toBeTruthy()
})

it('a card that was open when the menu took the seat does not come back when the menu closes', () => {
  vi.useFakeTimers()
  mount()
  const trigger = row().querySelector('[data-slot="hover-card-trigger"]')
  if (!trigger) throw new Error('the badge is not a card trigger')
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new MouseEvent('mouseenter'))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(document.querySelector('[data-slot="agent-card"]')).not.toBeNull()
  click(row())
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(document.querySelector('[data-slot="agent-card"]')).toBeNull()
  click(row())
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
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
    trigger?.dispatchEvent(new MouseEvent('mouseenter'))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  const usage = [...document.querySelectorAll('[data-slot="agent-card"] button')].find((b) => b.textContent?.trim() === 'Usage')
  if (!usage) throw new Error('no Usage verb on the card')
  click(usage)
  expect(onOpenUsage).toHaveBeenCalledWith(CLAUDE)
})

it('a seat inside the menu offers Usage too, on the same account as the badge below it', () => {
  /* Two cards for one account that offered different verbs. The badge's card
     has opened the dashboard scoped to its agent since it was built; the
     seats in the menu — the same accounts, one card each — were handed no
     `onOpenUsage` at all, so their Do band had nothing but the switch (#131).
     The menu's own Dashboard row opens the dashboard on everything, which is
     a different question from "this seat". */
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
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  const codexSeat = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.getAttribute('title') === 'shane@example.com',
  )
  const trigger = codexSeat?.querySelector('[data-slot="hover-card-trigger"]')
  if (!trigger) throw new Error('no card trigger on the menu seat')
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    trigger.dispatchEvent(new MouseEvent('mouseenter'))
  })
  act(() => {
    vi.advanceTimersByTime(1000)
  })
  const usage = [...document.querySelectorAll('[data-slot="agent-card"] button')].find(
    (b) => b.textContent?.trim() === 'Usage',
  )
  if (!usage) throw new Error('no Usage verb on the menu seat card')
  click(usage)
  // Scoped to the seat the card is about, not to the default agent.
  expect(onOpenUsage).toHaveBeenCalledWith(CODEX)
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
  const you = document.querySelector('[role="menu"] [role="menuitem"]')
  if (!you) throw new Error('no menu')
  expect(you.textContent).toContain('Jane')
  // Every profile is kept on this Mac, so a chip saying so marked nothing.
  expect(you.textContent).not.toContain('Local')
  click(you)
  expect(onOpenSettings).toHaveBeenCalledWith('profile')
  expect(document.querySelector('[role="menu"]')).toBeNull()
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
  const menu = document.querySelector<HTMLElement>('[role="menu"] [class*="youLabel"]')
  if (!menu) throw new Error('no menu label')
  sized(menu, 320, 120)
  hover(menu)
  expect(menu.getAttribute('title')).toBe(name)
})

it('gives every seat one line, and keeps the identity for the tooltip', () => {
  mount()
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  const seats = [...document.querySelectorAll('[role="menuitem"][data-layout="account"]')]
  expect(seats.map((seat) => seat.textContent?.trim())).toEqual(['shane', 'Shane-Claude'])
  expect(seats.map((seat) => seat.getAttribute('title'))).toEqual(['shane@example.com', 'olivia@acme.dev'])
})

it('leaves an agent waiting for a sign-in to Add an account…, unless it is the default', () => {
  const gemini = runtime(runtimeId('gemini'), 'Gemini CLI', 'gemini')
  mount({
    runtimes: [codex, claude, gemini],
    accountsByRuntime: { [CODEX]: signedIn('shane@example.com'), [CLAUDE]: signedIn('olivia@acme.dev'), [gemini.id]: signedOut },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [CLAUDE]: { state: 'ready' }, [gemini.id]: { state: 'ready' } },
  })
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  const menu = document.querySelector('[role="menu"]')
  expect(menu?.textContent).not.toContain('Gemini CLI')
  expect(menu?.textContent).toContain('Add an account…')

  // The default is the chair you are in, and it says what is wrong with it.
  act(() => root.unmount())
  root = createRoot(container)
  mount({ accountsByRuntime: { [CODEX]: signedIn('shane@example.com'), [CLAUDE]: signedOut } })
  click(row())
  const chair = document.querySelector('[role="menuitem"][data-current]')
  expect(chair?.textContent).toContain('Claude Code')
  expect(chair?.textContent).toContain('Needs sign-in')
})

it('draws no usage row where nothing is metered', () => {
  mount()
  click(row())
  const rows = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? '')
  expect(rows.some((text) => text.includes('Usage remaining'))).toBe(false)
  expect(rows.some((text) => text.includes('Dashboard'))).toBe(true)
})

it('names the agent only where two chairs share a name', () => {
  mount({
    accountsByRuntime: { [CODEX]: signedIn('jane@example.com'), [CLAUDE]: signedIn('jane@example.com') },
    accountPrefs: {},
  })
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  const seats = [...document.querySelectorAll('[role="menuitem"][data-layout="account"]')]
  expect(seats.map((seat) => seat.textContent?.trim())).toEqual(['janeCodex', 'janeClaude'])
})
