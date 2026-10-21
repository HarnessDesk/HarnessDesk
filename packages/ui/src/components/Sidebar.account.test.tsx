import { previewStore } from '../preview/harness'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type AccountStatus, type RuntimeId, type RuntimeInfo, type UsageLane, type UsageReport } from '@harnessdesk/protocol'

import { accountKey } from '../lib/accounts'
import { conditionFor } from '../lib/usage-alerts'
import { emptyNoticePolicy, withMuted, afterDismiss } from '../lib/notice-policy'
import { emptyWorkbench } from '../state/workbench'
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

/** Another account of an agent: a runtime of its own, keyed to the agent. */
const slotOf = (
  agent: RuntimeInfo,
  id: string,
  gateway?: { name: string; endpoint: string },
): RuntimeInfo =>
  ({
    ...agent,
    id: runtimeId(id),
    slot: { agent: agent.id, home: null, removable: true, canAdd: true, ...(gateway ? { gateway } : {}) },
  }) as unknown as RuntimeInfo
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
  const signOutAgent = vi.fn(async () => {})
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
    signOutAgent,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AccountFooter onOpenSettings={onOpenSettings} onOpenUsage={onOpenUsage} onSignIn={onSignIn} />
      </StoreProvider>,
    )
  })
  return { selectRuntime, signOutAgent, onOpenSettings, onOpenUsage, onSignIn }
}

const row = (): HTMLButtonElement => {
  const found = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
  if (!found) throw new Error('no seat row')
  return found
}

const quotaWarning = () => usageReport(CLAUDE, [lane({
  id: 'weekly', usedPercent: 40, usageKnown: true,
  resetsAt: Date.now() + 6.5 * 24 * 3_600_000,
})])

it('keeps a low quota warning in the quiet account trigger tooltip', () => {
  const report = quotaWarning()
  const workbench = emptyWorkbench()
  mount({ preferencesLoaded: true, usage: [report], workbench: { ...workbench, navigation: { ...workbench.navigation, current: { kind: 'library', section: 'skill' } } } })
  const warning = conditionFor(CLAUDE, [report], () => claude.presentation.name, Date.now())!
  expect(row().title).toContain(`${warning.title}. ${warning.detail}`)
  expect(row().querySelector('[data-slot="dot"]')).toBeNull()
  expect(row().textContent).not.toContain('will run out before it refills')
})

it.each(['dismissed', 'muted'] as const)('keeps a %s quota prediction out of the account dot', silence => {
  const report = quotaWarning()
  const condition = conditionFor(CLAUDE, [report], () => claude.presentation.name, Date.now())!
  const policy = silence === 'muted' ? withMuted(emptyNoticePolicy(), condition.kind, true)
    : afterDismiss(emptyNoticePolicy(), { ...condition, lifetime: 'occurrence' }, Date.now())
  const workbench = emptyWorkbench()
  mount({ preferencesLoaded: true, usage: [report], noticePolicy: policy, workbench: { ...workbench, navigation: { ...workbench.navigation, current: { kind: 'library', section: 'skill' } } } })
  expect(row().querySelector('[data-slot="dot"][data-tone="warning"]')).toBeNull()
})

it.each(['composer', 'dashboard'] as const)('does not repeat the %s quota notice in the account dot', place => {
  const workbench = emptyWorkbench()
  const session = sessionKey(CLAUDE, sessionId('quota-conversation'))
  mount({ preferencesLoaded: true, usage: [quotaWarning()], workbench: {
    ...workbench,
    main: { ...workbench.main, root: { kind: 'pane', id: workbench.main.focused, view: { kind: 'conversation', session } } },
    ...(place === 'dashboard' ? { navigation: { ...workbench.navigation, current: { kind: 'dashboard', view: 'overview', scope: null } } } : {}),
  } })
  expect(row().querySelector('[data-slot="dot"][data-tone="warning"]')).toBeNull()
})

/** A group of one agent's accounts, found by the heading that names it. */
const groupNamed = (name: string): Element | undefined =>
  [...document.querySelectorAll('[role="group"]')].find(
    (group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent === name,
  )

/** A seat's identity lives on its name's tooltip, not in its text. */
const identityOf = (item: Element): string | null | undefined => item.querySelector('[data-identity]')?.getAttribute('data-identity')

const seatNamed = (identity: string): Element | undefined =>
  [...document.querySelectorAll('[role="menuitem"]:has([data-menu-account-name])')].reverse().find((item) => identityOf(item) === identity)

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

it('shows the desk identity and names the default agent on hover', () => {
  mount()
  const seat = row()
  expect(seat.textContent).toContain('HarnessDesk')
  expect(seat.textContent).not.toContain('Shane-Claude')
  expect(seat.textContent).not.toContain('olivia')
  // The default agent is named on hover, while the footer keeps only identity.
  expect(seat.querySelector('.brand-claude')).toBeNull()
  expect(seat.querySelector('.brand-codex')).toBeNull()
  // The tooltip names the default account in full.
  expect(seat.getAttribute('title')).toBe('New sessions run as Claude · Shane-Claude')
  expect(seat.querySelector('[data-slot="dot"]')).toBeNull()
})

it('marks the default in the menu, chooses on a seat’s press, and signs out of the default agent', () => {
  const { selectRuntime } = mount()
  click(row())
  const chosen = document.querySelector('[role="menuitem"][data-current]')
  expect(chosen?.textContent).toContain('Shane-Claude')
  // Sign-out is the default agent's, not the focused conversation's.
  expect(document.body.textContent).toContain('Sign out of Claude')
  expect(document.body.textContent).not.toContain('Sign out of Codex')
  if (!chosen) throw new Error('no current seat')
  click(chosen)

  const codexSeat = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    identityOf(item)?.includes('shane'),
  )
  if (!codexSeat) throw new Error('no Codex seat in the menu')
  click(codexSeat)
  expect(selectRuntime).toHaveBeenCalledWith(CODEX)
})

it('opens above the footer row at a width of its own, not the sidebar’s', () => {
  mount()
  click(row())
  const panel = document.querySelector('[role="menu"]')?.closest('[data-popup-kind]')
  expect(panel?.getAttribute('data-width')).toBeNull()
  expect(panel?.getAttribute('data-popup-kind')).toBe('wide-menu')
  expect(panel?.closest('[data-side]')?.getAttribute('data-side')).toBe('top')
})

it('keeps the menu on the current account until the picker is opened', () => {
  const { selectRuntime } = mount()
  click(row())

  const menu = document.querySelector('[role="menu"]')
  expect(menu?.textContent).toContain('Shane-Claude')
  expect(seatNamed('shane@example.com')).toBeUndefined()

  const current = menu?.querySelector('[data-current]')
  if (!current) throw new Error('no current account')
  click(current)

  expect(seatNamed('shane@example.com')).toBeDefined()
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

const usageTrigger = (): HTMLElement => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  .find(item => item.querySelector('[data-menu-label]')?.textContent?.trim() === 'Usage')!
const openUsage = (): HTMLElement => {
  click(usageTrigger())
  return [...document.querySelectorAll<HTMLElement>('[role="menu"]')].find(menu => menu.querySelector('[data-usage-details]')) ??
    [...document.querySelectorAll<HTMLElement>('[role="menu"]')].at(-1)!
}

it('opens current usage in its own menu with windows, provenance and a scoped action', () => {
  mount({ usage: [usageReport(CLAUDE, [
    lane({ id: 'session', label: 'Session', usedPercent: 52, windowMinutes: 300, resetsAt: Date.now() + 3600000 }),
    lane({ id: 'weekly', label: 'Weekly', usedPercent: 63 }),
  ])] })
  click(row())
  const parent = document.querySelector('[role="menu"]')!
  const usage = usageTrigger()
  expect(usage.getAttribute('aria-expanded')).toBe('false')
  expect(usage.querySelector('[data-menu-trailing]')?.textContent).toContain('48% left')
  const details = openUsage()
  expect(usage.getAttribute('aria-expanded')).toBe('true')
  expect(details).not.toBe(parent)
  expect(details.textContent).toContain('Session')
  expect(details.textContent).toContain('Weekly')
  expect(details.textContent).toContain('from its own API')
  expect(details.textContent).toContain('Open usage')
  expect(details.querySelector('[data-meter-column="reset"] [title]')?.getAttribute('title')).toMatch(/^resets /)
})

it('keeps other reporting accounts as scoped links and unreported runtimes out of Usage', () => {
  const one = runtime('agent-one', 'Agent One', 'codex')
  const two = runtime('agent-two', 'Agent Two', 'codex')
  const three = runtime('agent-three', 'Agent Three', 'codex')
  const { onOpenUsage } = mount({
    runtimes: [codex, one, two, three], activeRuntime: one.id,
    usage: [CODEX, one.id].map(id => ({ ...usageReport(id, [lane({ id: 'weekly', usedPercent: 32 })]), account: null })),
    accountsByRuntime: { [CODEX]: signedIn('dev@example.com'), [one.id]: signedIn('one@example.com'),
      [two.id]: signedIn('two@example.com'), [three.id]: signedOut },
  })
  click(row())
  const details = openUsage()
  expect(details.querySelectorAll('[data-usage-details]')).toHaveLength(1)
  expect(details.textContent).toContain('Other accounts')
  expect(details.textContent).not.toContain('Agent Two')
  expect(details.textContent).not.toContain('Agent Three')
  const other = [...details.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.querySelector('.brand-codex'))!
  expect(other.getAttribute('aria-expanded')).toBeNull()
  click(other)
  expect(onOpenUsage).toHaveBeenCalledWith(CODEX)
})

it('keeps scoped sign-in in the account picker without listing every signed-out runtime', () => {
  const one = runtime('agent-one', 'Agent One', 'codex')
  const two = runtime('agent-two', 'Agent Two', 'codex')
  const { onSignIn } = mount({ runtimes: [one, two], activeRuntime: one.id,
    accountsByRuntime: { [one.id]: signedOut, [two.id]: signedOut } })
  click(row())
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Sign in to')
  click(document.querySelector('[role="menuitem"][data-current]')!)
  const signIn = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Sign in to Agent One')!
  expect(signIn).toBeDefined()
  expect(document.body.textContent).not.toContain('Sign in to Agent Two')
  click(signIn)
  expect(onSignIn).toHaveBeenCalledWith(one.id)
})

it.each([
  ['with room', 40, null],
  ['running low', 88, 'warning'],
  ['spent', 100, 'danger'],
] as const)('keeps the compact Usage figure honest when %s', (_state, usedPercent, tone) => {
  mount({ usage: [usageReport(CLAUDE, [lane({ id: 'weekly', usedPercent })])] })
  click(row())
  const figure = usageTrigger().querySelector('[data-menu-trailing] [data-slot="text"]')
  expect(figure?.getAttribute('data-tone') ?? null).toBe(tone)
  expect(usageTrigger().textContent).toContain(usedPercent === 100 ? 'out' : `${100 - usedPercent}% left`)
})

it('resets both flyouts when the footer closes and reopens', () => {
  mount({ usage: [quotaWarning()] })
  click(row())
  click(document.querySelector('[role="menuitem"][data-current]')!)
  expect(seatNamed('shane@example.com')).toBeDefined()
  openUsage()
  expect(document.querySelector('[data-usage-details]')).not.toBeNull()
  click(row())
  expect(document.querySelector('[role="menu"]')).toBeNull()
  click(row())
  expect(document.querySelector('[role="menuitem"][data-current]')?.getAttribute('aria-expanded')).toBe('false')
  expect(usageTrigger().getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('[data-usage-details]')).toBeNull()
  expect(seatNamed('shane@example.com')).toBeUndefined()
})

it.each([
  ['Add an account…', 'signIn'],
  ['Manage runtimes', 'settings'],
] as const)('closes the account menu when %s opens its destination', (label, callback) => {
  const { onOpenSettings, onSignIn } = mount()
  click(row())
  click(document.querySelector('[role="menuitem"][data-current]')!)
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(one => one.textContent === label)!
  click(item)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  if (callback === 'settings') expect(onOpenSettings).toHaveBeenCalledWith('runtimes')
  else expect(onSignIn).toHaveBeenCalledWith()
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

it('keeps the signed-out account mark and readiness in the menu', () => {
  mount({ accountsByRuntime: { [CODEX]: signedIn('shane@example.com'), [CLAUDE]: signedOut } })
  const seat = row()
  expect(seat.textContent).toContain('HarnessDesk')
  click(seat)
  const badge = document.querySelector('[role="menu"] [data-off]')
  expect(badge?.querySelector('.brand-claude')).not.toBeNull()
  expect(seat.querySelector('[data-tint]')).toBeNull()
  expect(seat.querySelector('[data-slot="dot"]')).toBeNull()
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Needs sign-in')
  expect(seat.getAttribute('title')).toBe('New sessions run as Claude')
})

it('keeps the footer quiet before the default agent has answered', () => {
  // Accounts not loaded yet: readiness guesses signin, but nothing says nobody is signed in.
  mount({ accountsByRuntime: { [CODEX]: signedIn('shane@example.com') } })
  const seat = row()
  expect(seat.querySelector('.brand-claude')).toBeNull()
  expect(seat.querySelector('[data-off]')).toBeNull()
})

it('does not guess a signed-out account before the default agent has answered', () => {
  mount({ accountsByRuntime: { [CODEX]: signedIn('shane@example.com') } })
  const light = row().querySelector('[role="img"]')
  // Neutral: no state, and a name that claims none.
  expect(light).toBeNull()
  click(row())
  expect(document.querySelector('[role="menu"] [data-off]')).toBeNull()
})

it('keeps account identity in the menu and gives the default no redundant switch action', () => {
  mount({ accountsByRuntime: { [CLAUDE]: signedIn('dev@example.com') } })
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')!
  expect(identityOf(current)).toBe('dev@example.com')
  expect(current.textContent).toContain('dev')
  expect(current.textContent).not.toContain('Run new sessions as this')
  expect(row().querySelector('[data-slot="hover-card-trigger"]')).toBeNull()
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
  expect(seat.querySelector('[data-slot="dot"]')).toBeNull()
  click(seat)
  const badge = document.querySelector('[role="menu"] [data-menu-icon] > span')
  expect(badge?.hasAttribute('data-off')).toBe(false)
  expect(badge?.hasAttribute('data-tint')).toBe(false)
  if (!document.querySelector('[role="menu"]')) click(seat)
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => /^Cline/.test(el.textContent?.trim() ?? ''))
  // Ready says nothing on the row; the tooltip still answers.
  expect(item?.textContent).not.toContain('Ready')
  expect(item && identityOf(item)).toBe('Ready')
  const disc = item?.querySelector('[data-menu-icon] [data-shape="round"]')
  expect(disc?.hasAttribute('data-off')).toBe(false)
  expect(disc?.hasAttribute('data-tint')).toBe(false)
  // and an account that is signed in still wears its ring
  const claudeItem = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('Shane-Claude'))
  expect(claudeItem?.querySelector('[data-menu-icon] [data-shape="round"]')?.getAttribute('data-tint')).toBeTruthy()
})

it('keeps the footer free of a hover card while its menu opens and closes', () => {
  vi.useFakeTimers()
  mount()
  click(row())
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(document.querySelector('[data-popup-kind="info-card"]')).toBeNull()
  click(row())
  act(() => vi.advanceTimersByTime(1000))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.querySelector('[data-popup-kind="info-card"]')).toBeNull()
})

it('keeps usage facts and the current account dashboard action in the Usage flyout', () => {
  const { onOpenUsage } = mount({ usage: [quotaWarning()] })
  click(row())
  const details = openUsage()
  click([...details.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Open usage')!)
  expect(onOpenUsage).toHaveBeenCalledWith(CLAUDE)
})

it('shows one honest empty-usage note without listing unreported agents', () => {
  const { onOpenUsage } = mount()
  click(row())
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('No usage reported')
  const details = openUsage()
  expect(details.querySelectorAll('[data-menu-note]')).toHaveLength(1)
  expect(details.textContent).toContain('No usage reported for this account.')
  expect(details.textContent).not.toContain('OpenAI Codex')
  click([...details.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Open usage')!)
  expect(onOpenUsage).toHaveBeenCalledWith(CLAUDE)
})

it('keeps Settings and sign-out outside account and usage details', () => {
  mount()
  click(row())
  const menu = document.querySelector('[role="menu"]')!
  const rows = [...menu.querySelectorAll('[role="menuitem"]')]
  expect(rows.at(-2)?.textContent).toContain('Settings')
  expect(rows.at(-1)?.textContent).toContain('Sign out of')
  expect(rows.at(-2)?.previousElementSibling?.matches('[data-menu-separator]')).toBe(true)
})
it('shows your chosen name and face without the default agent mark', () => {
  mount({ profile: { name: 'Jane', avatar: 'wizard' } })
  const seat = row()
  expect(seat.textContent).toContain('Jane')
  expect(seat.textContent).not.toContain('HarnessDesk')
  expect(seat.querySelector('img')?.getAttribute('src')).toMatch(/\/wizard\.png$/)
  expect(seat.querySelector('.brand-harnessdesk')).toBeNull()
  // The account mark remains in the menu.
  expect(seat.querySelector('.brand-claude')).toBeNull()
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
  expect(document.querySelector('[role="menu"] [data-menu-label]')?.textContent).toBe(name)
})

it('gives every seat one line, and keeps the identity for the tooltip', () => {
  mount()
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  const seats = [...document.querySelectorAll('[role="menuitem"]:has([data-menu-account-name]):not([data-slot="dropdown-menu-sub-trigger"])')]
  expect(seats.map((seat) => seat.textContent?.trim())).toEqual(['shane', 'Shane-Claude'])
  expect(seats.map(identityOf)).toEqual(['shane@example.com', 'olivia@acme.dev'])
  // On the name, not the row: the row's tooltip would sit over the mark's card.
  expect(seats.every((seat) => !seat.hasAttribute('title'))).toBe(true)
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
  // The picker is open — the other signed-in agent is there — and Gemini is not.
  expect(seatNamed('shane@example.com')).toBeDefined()
  expect(seatNamed('Gemini CLI')).toBeUndefined()
  expect(menu?.textContent).not.toContain('Sign in to Gemini CLI')
  expect(document.body.textContent).toContain('Manage runtimes')
  expect(document.body.textContent).toContain('Add an account…')

  // The default is the chair you are in, and it says what is wrong with it.
  act(() => root.unmount())
  root = createRoot(container)
  mount({ accountsByRuntime: { [CODEX]: signedIn('shane@example.com'), [CLAUDE]: signedOut } })
  click(row())
  const chair = document.querySelector('[role="menuitem"][data-current]')
  expect(chair?.textContent).toContain('Claude Code')
  expect(chair?.textContent).toContain('Needs sign-in')
})

it('keeps Usage available without inventing a figure where nothing is metered', () => {
  mount()
  click(row())
  const rows = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? '')
  expect(usageTrigger().querySelector('[data-menu-trailing] [data-slot="text"]')).toBeNull()
  expect(rows.some((text) => text.includes('Settings'))).toBe(true)
  // Dashboard is the sidebar nav's, not a second door in this menu.
  expect(rows.some((text) => text.includes('Dashboard'))).toBe(false)
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
  const seats = [...document.querySelectorAll('[role="menuitem"]:has([data-menu-account-name]):not([data-slot="dropdown-menu-sub-trigger"])')]
  expect(seats.map((seat) => seat.textContent?.trim())).toEqual(['janeCodex', 'janeClaude'])
})

it('marks the default by its filled row, not a tick, so every figure ends at the edge', () => {
  mount()
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  expect(current.getAttribute('aria-current')).toBe('true')
  click(current)
  for (const seat of document.querySelectorAll('[role="menuitem"]:has([data-menu-account-name]):not([data-slot="dropdown-menu-sub-trigger"])')) {
    expect(seat.querySelector('.lucide-check')).toBeNull()
  }
})

it('tells two addresses with one local part on one agent apart by their domains', () => {
  const second = slotOf(codex, 'codex-2')
  mount({
    runtimes: [codex, second, claude],
    accountsByRuntime: {
      [CODEX]: signedIn('jane@example.com'),
      [second.id]: signedIn('jane@acme.dev'),
      [CLAUDE]: signedIn('olivia@acme.dev'),
    },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [second.id]: { state: 'ready' }, [CLAUDE]: { state: 'ready' } },
  })
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  const seats = [...document.querySelectorAll('[role="menuitem"]:has([data-menu-account-name]):not([data-slot="dropdown-menu-sub-trigger"])')]
  // One heading for the agent, its two accounts under it, told apart by domain.
  const group = groupNamed('OpenAI Codex')
  expect(group).not.toBeNull()
  expect([...(group?.querySelectorAll('[role="menuitem"]') ?? [])].map((seat) => seat.textContent?.trim())).toEqual([
    'janeexample.com',
    'janeacme.dev',
  ])
  // Under the heading each account retains its tint; the heading adds no gutter.
  expect(group?.querySelectorAll('[role="menuitem"] .brand-codex').length).toBe(0)
  expect(group?.querySelectorAll('.brand-codex').length).toBe(0)
  expect(group?.querySelectorAll('[data-menu-icon] [data-shape="round"]').length).toBe(2)
  // An agent with one account is still one row, wearing its mark.
  const claudeRow = seats.find((seat) => seat.textContent?.includes('Shane-Claude'))
  expect(claudeRow?.closest('[role="group"]')).toBeNull()
  expect(claudeRow?.querySelector('.brand-claude')).not.toBeNull()
})

it('says what is wrong with a seat that has no figure, in the figure’s place', () => {
  mount({ healthByRuntime: { [CODEX]: { state: 'unavailable', reason: 'crashed', message: 'exited' }, [CLAUDE]: { state: 'ready' } } })
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  expect(seatNamed('shane@example.com')?.textContent).toContain('Unavailable')
})

it.each([true, false])('shows unavailable readiness ahead of cached usage when current is %s', current => {
  mount({
    activeRuntime: current ? CODEX : CLAUDE,
    accountsByRuntime: { [CODEX]: signedIn('jane@example.com'), [CLAUDE]: signedIn('dev@example.com') },
    accountPrefs: {},
    healthByRuntime: { [CODEX]: { state: 'unavailable', reason: 'crashed', message: 'exited' }, [CLAUDE]: { state: 'ready' } },
    usage: [{ ...usageReport(CODEX, [lane({ id: 'weekly', usedPercent: 40 })]), account: 'jane@example.com' }],
  })
  click(row())
  if (!current) {
    const selected = document.querySelector('[role="menuitem"][data-current]')!
    click(selected)
  }
  const seat = seatNamed('jane@example.com')
  expect(seat?.querySelector('[data-menu-trailing]')?.textContent).toContain('Unavailable')
  expect(seat?.querySelector('[data-menu-trailing]')?.textContent).not.toContain('60%')
  // The cached reading remains available in Usage, not on the unavailable seat.
  expect(openUsage().textContent).toContain('60%')
})

it('shows sign-in readiness ahead of cached usage for the default agent', () => {
  mount({ activeRuntime: CODEX, accountsByRuntime: { [CODEX]: signedOut, [CLAUDE]: signedIn('dev@example.com') },
    usage: [usageReport(CODEX, [lane({ id: 'weekly', usedPercent: 40 })])] })
  click(row())
  const selected = document.querySelector('[role="menuitem"][data-current]')!
  expect(selected.querySelector('[data-menu-trailing]')?.textContent).toContain('Needs sign-in')
  expect(selected.querySelector('[data-menu-trailing]')?.textContent).not.toContain('60%')
})

it('keeps an agent that has not answered yet, without calling it signed out', () => {
  mount({
    accountsByRuntime: { [CLAUDE]: signedIn('olivia@acme.dev') },
  })
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  const codexSeat = [...document.querySelectorAll('[role="menuitem"]:has([data-menu-account-name]):not([data-slot="dropdown-menu-sub-trigger"])')].find((item) =>
    item.textContent?.includes('OpenAI Codex'),
  )
  expect(codexSeat).toBeDefined()
  expect(codexSeat?.textContent).not.toContain('Needs sign-in')
})

const openPicker = (): Element[] => {
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  if (!current) throw new Error('no current seat')
  click(current)
  return [...document.querySelectorAll('[role="menuitem"]:has([data-menu-account-name]):not([data-slot="dropdown-menu-sub-trigger"])')]
}

it('keeps a mixed group apart: the agent with two accounts under its heading, the other on its own line', () => {
  const second = slotOf(codex, 'codex-2')
  mount({
    runtimes: [codex, second, claude],
    accountsByRuntime: {
      [CODEX]: signedIn('jane@example.com'),
      [second.id]: signedIn('jane@acme.dev'),
      [CLAUDE]: signedIn('jane@example.com'),
    },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [second.id]: { state: 'ready' }, [CLAUDE]: { state: 'ready' } },
    accountPrefs: {},
  })
  const seats = openPicker()
  expect(seats.map((seat) => seat.textContent?.trim())).toEqual(['janeexample.com', 'janeacme.dev', 'jane'])
})

it('calls an account known only by its agent’s name after its gateway, under the heading', () => {
  const proxy = slotOf(codex, 'codex-2', { name: 'Team proxy', endpoint: 'https://proxy.acme.dev' })
  mount({
    runtimes: [codex, proxy, claude],
    accountsByRuntime: {
      [CODEX]: signedIn('jane@example.com'),
      [proxy.id]: { accounts: [{ kind: 'apiKey', label: 'API key', anonymous: true }], signInMethods: [] },
      [CLAUDE]: signedIn('olivia@acme.dev'),
    },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [proxy.id]: { state: 'ready' }, [CLAUDE]: { state: 'ready' } },
  })
  const group = (openPicker(), groupNamed('OpenAI Codex'))
  const names = [...(group?.querySelectorAll('[role="menuitem"]') ?? [])].map((seat) => seat.textContent?.trim())
  expect(names).toEqual(['jane', 'Team proxy'])
})

it('never tags a row with its own name again', () => {
  const cursor = runtime(runtimeId('cursor'), 'Cursor', 'cursor')
  const second = slotOf(cursor, 'cursor-2')
  mount({
    runtimes: [codex, claude, cursor, second],
    accountsByRuntime: {
      [CODEX]: signedIn('shane@example.com'),
      [CLAUDE]: signedIn('olivia@acme.dev'),
      [cursor.id]: signedIn('Jane-Cursor'),
      [second.id]: signedIn('Jane-Cursor'),
    },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [CLAUDE]: { state: 'ready' }, [cursor.id]: { state: 'ready' }, [second.id]: { state: 'ready' } },
  })
  openPicker()
  const group = groupNamed('Cursor')
  const names = [...(group?.querySelectorAll('[role="menuitem"]') ?? [])].map((seat) => seat.textContent?.trim())
  expect(names).toEqual(['Jane-Cursor', 'Jane-Cursor'])
})

it('does not call an agent that has not answered signed out — not on its line, its tooltip, or its mark', () => {
  mount({ accountsByRuntime: { [CLAUDE]: signedIn('olivia@acme.dev') } })
  const codexSeat = openPicker().find((item) => item.textContent?.includes('OpenAI Codex'))
  expect(codexSeat).toBeDefined()
  expect(codexSeat && identityOf(codexSeat)).toBe('OpenAI Codex')
  expect(codexSeat?.querySelector('[data-off]')).toBeNull()
})

it('names the agent, not "Unavailable", for one that has not answered and is also broken', () => {
  // `state` is `broken` here, not `unknown` — health outranks the account
  // check in readinessOf — so the identity has to read `answered`, not the
  // state, or it would repeat the figure word the tooltip is meant to avoid.
  mount({
    accountsByRuntime: { [CLAUDE]: signedIn('olivia@acme.dev') },
    healthByRuntime: { [CODEX]: { state: 'unavailable', reason: 'crashed', message: 'Exited.' }, [CLAUDE]: { state: 'ready' } },
  })
  const codexSeat = openPicker().find((item) => item.textContent?.includes('OpenAI Codex'))
  expect(codexSeat).toBeDefined()
  expect(codexSeat && identityOf(codexSeat)).toBe('OpenAI Codex')
})

it('names the agent, not "Ready", for one that has not answered and keeps its own credential', () => {
  // `state` is `ready` here, not `unknown` — `capabilities.account === false`
  // skips the account check in readinessOf entirely — so this is the same
  // fact as the broken case above, from the opposite side.
  mount({
    runtimes: [codex, claude, keeper],
    accountsByRuntime: { [CODEX]: signedIn('shane@example.com'), [CLAUDE]: signedIn('olivia@acme.dev') },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [CLAUDE]: { state: 'ready' }, [keeper.id]: { state: 'ready' } },
  })
  const clineSeat = openPicker().find((item) => item.textContent?.includes('Cline'))
  expect(clineSeat).toBeDefined()
  expect(clineSeat && identityOf(clineSeat)).toBe('Cline')
})

const twoCodex = () => {
  const second = slotOf(codex, 'codex-2')
  return {
    second,
    snapshot: {
      runtimes: [codex, second, claude],
      activeRuntime: CODEX,
      accountsByRuntime: {
        [CODEX]: signedIn('jane@example.com'),
        [second.id]: signedIn('jane@acme.dev'),
        [CLAUDE]: signedIn('olivia@acme.dev'),
      },
      healthByRuntime: { [CODEX]: { state: 'ready' }, [second.id]: { state: 'ready' }, [CLAUDE]: { state: 'ready' } },
      accountPrefs: {},
    } as Partial<AppSnapshot>,
  }
}

it('keeps the parent account trigger stable while its grouped picker opens', () => {
  mount(twoCodex().snapshot)
  click(row())
  const current = document.querySelector<HTMLElement>('[role="menuitem"][data-current]')!
  expect(current.querySelector('.brand-codex')).not.toBeNull()
  act(() => current.focus())
  click(current)
  expect(current.isConnected).toBe(true)
  expect(current.getAttribute('aria-expanded')).toBe('true')
  expect(groupNamed('OpenAI Codex')?.querySelectorAll('[role="menuitem"]')).toHaveLength(2)
  expect(current.querySelector('.brand-codex')).not.toBeNull()
})

it('arrows into the account submenu and Escape returns to its parent', async () => {
  mount(twoCodex().snapshot)
  click(row())
  const current = document.querySelector<HTMLElement>('[role="menuitem"][data-current]')!
  act(() => current.focus())
  const press = async (key: string) => act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
  await press('ArrowRight')
  expect(document.activeElement?.textContent).toContain('example.com')
  await press('ArrowDown')
  expect(document.activeElement?.textContent).toContain('acme.dev')
  await press('ArrowDown')
  expect(document.activeElement?.textContent).toContain('olivia')
  await press('Escape')
  expect(document.activeElement).toBe(current)
  expect(current.getAttribute('aria-expanded')).toBe('false')
})

it('calls an account-less row under a heading what it is, not the heading or the readiness word again', () => {
  const { second, snapshot } = twoCodex()
  mount({
    ...snapshot,
    activeRuntime: second.id,
    accountsByRuntime: { ...snapshot.accountsByRuntime, [second.id]: signedOut },
  })
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')
  expect(current?.textContent).toBe('No accountNeeds sign-in')
})

it('keeps a signed-out default listed under its heading when the picker is open, drawn as what it is', () => {
  // A second account of the default agent, answered and signed out, is the default;
  // a third, signed out too, is not the default — and so is not listed.
  const { second, snapshot } = twoCodex()
  const third = slotOf(codex, 'codex-3')
  mount({
    ...snapshot,
    runtimes: [...(snapshot.runtimes ?? []), third],
    activeRuntime: second.id,
    accountsByRuntime: { ...snapshot.accountsByRuntime, [second.id]: signedOut, [third.id]: signedOut },
    healthByRuntime: { ...snapshot.healthByRuntime, [third.id]: { state: 'ready' } },
  })
  click(row())
  const folded = document.querySelector<HTMLElement>('[role="menuitem"][data-current]')
  if (!folded) throw new Error('no current seat')
  click(folded)
  const group = groupNamed('OpenAI Codex')
  const rows = [...(group?.querySelectorAll('[role="menuitem"]') ?? [])]
  // Listed, though its signed-out sibling is not: it is the chair you are in.
  expect(rows.map((one) => one.textContent?.trim())).toEqual(['jane', 'No accountNeeds sign-in'])
  const current = rows.find((one) => one.hasAttribute('data-current'))
  expect(current).not.toBe(folded)
  expect(folded.getAttribute('aria-expanded')).toBe('true')
  // Under the heading: no mark of its own, and an untinted dot — no account, no colour.
  expect(current?.querySelector('.brand-codex')).toBeNull()
  expect(current?.querySelector('[data-tint]')).toBeNull()
  expect(current?.querySelector('[aria-hidden="true"]')).not.toBeNull()
  // The other account keeps its colour, so the difference is the account's, not the row's.
  expect(rows[0]?.querySelector('[data-tint]')).not.toBeNull()
})

it('never tags a single row with its own name', () => {
  // An agent that keeps its own credential: listed with no account, named after itself.
  const cursor = { ...runtime(runtimeId('cursor'), 'Cursor', 'cursor'), capabilities: { account: false } } as RuntimeInfo
  mount({
    runtimes: [codex, claude, cursor],
    accountsByRuntime: {
      [CODEX]: signedIn('shane@example.com'),
      [CLAUDE]: signedIn('olivia@acme.dev'),
      [cursor.id]: { accounts: [], signInMethods: [] },
    },
    healthByRuntime: { [CODEX]: { state: 'ready' }, [CLAUDE]: { state: 'ready' }, [cursor.id]: { state: 'ready' } },
    accountPrefs: { [accountKey(CLAUDE, signedIn('olivia@acme.dev').accounts[0]!)]: { nickname: 'Cursor' } },
  })
  const seats = openPicker()
  const cursorRow = seats.find((seat) => seat.querySelector('.brand-cursor'))
  const claudeRow = seats.find((seat) => seat.querySelector('.brand-claude'))
  // Two single rows named "Cursor": the Claude one says whose it is, the Cursor one does not say "Cursor" twice.
  expect(claudeRow?.textContent?.trim()).toBe('CursorClaude')
  expect(cursorRow?.textContent?.trim()).toBe('Cursor')
})

it('calls an account under a heading that has not answered an unknown account, not a pending one', () => {
  const { second, snapshot } = twoCodex()
  const accounts = { ...snapshot.accountsByRuntime }
  delete (accounts as Record<string, unknown>)[second.id]
  mount({ ...snapshot, accountsByRuntime: accounts })
  openPicker()
  const names = [...(groupNamed('OpenAI Codex')?.querySelectorAll('[role="menuitem"]') ?? [])].map((seat) => seat.textContent?.trim())
  expect(names).toEqual(['jane', 'Unknown account'])
})

it('calls an unanswered account under a heading unknown even when its own health is broken', () => {
  // Health `unavailable` outranks the account check in `readinessOf`, so
  // this slot's state is `broken`, not `unknown` — but `runtime/account`
  // never answered for it either, and that fact is not the state's to carry.
  // A dead runtime whose own account read also failed is the ordinary case,
  // not a rare one.
  const { second, snapshot } = twoCodex()
  const accounts = { ...snapshot.accountsByRuntime }
  delete (accounts as Record<string, unknown>)[second.id]
  mount({
    ...snapshot,
    accountsByRuntime: accounts,
    healthByRuntime: {
      ...snapshot.healthByRuntime,
      [second.id]: { state: 'unavailable', reason: 'crashed', message: 'Exited.' },
    },
  })
  openPicker()
  const names = [...(groupNamed('OpenAI Codex')?.querySelectorAll('[role="menuitem"]') ?? [])].map((seat) => seat.textContent?.trim())
  // The broken slot still carries its own readiness word ("Unavailable") —
  // that is a real fact readiness always draws — but its label is "Unknown
  // account", never "No account".
  expect(names).toEqual(['jane', 'Unknown accountUnavailable'])
  expect(names.some((name) => name?.startsWith('No account'))).toBe(false)
})

it('gear is independent of the account menu and reflects Settings mode', () => {
  const onOpenSettings = vi.fn()
  act(() => root.render(<StoreProvider store={previewStore()}><AccountFooter settingsOpen
    onOpenSettings={onOpenSettings} onOpenUsage={() => {}} onSignIn={() => {}} /></StoreProvider>))
  const gear = container.querySelector<HTMLButtonElement>('[data-left-seat] button[aria-label="Settings"]')!
  expect(gear.getAttribute('aria-pressed')).toBe('true')
  act(() => gear.click())
  expect(onOpenSettings).toHaveBeenCalledWith('general')
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('Sign out closes the menu, and a failed confirmation stays retryable', async () => {
  const { signOutAgent } = mount()
  signOutAgent.mockRejectedValueOnce(new Error('Sign out unavailable'))
  click(row())
  const ask = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.includes('Sign out of'))!
  click(ask)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(signOutAgent).not.toHaveBeenCalled()
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(node => node.textContent?.trim() === 'Sign out')!
  await act(async () => { confirm.click() })
  expect(signOutAgent).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('Sign out unavailable')
  const keep = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(node => node.textContent?.trim() === 'Keep signed in')!
  click(keep)
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})


it('keeps the root menu to five actions even with a large account roster', () => {
  const others = Array.from({ length: 18 }, (_, index) => runtime(`agent-${index}`, `Agent ${index}`, 'codex'))
  mount({ runtimes: [claude, ...others], accountsByRuntime: Object.fromEntries([
    [CLAUDE, signedIn('dev@example.com')], ...others.map(info => [info.id, signedIn(`account-${info.id}@example.com`)]),
  ]) })
  click(row())
  const menu = document.querySelector('[role="menu"]')!
  expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(5)
  expect(menu.textContent).not.toContain('Agent 17')
  expect(menu.textContent).not.toContain('No usage reported')
  const account = menu.querySelector('[role="menuitem"][data-current]')!
  click(account)
  expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(5)
  expect(account.getAttribute('aria-expanded')).toBe('true')
  openUsage()
  expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(5)
  expect(account.getAttribute('aria-expanded')).toBe('false')
  expect(usageTrigger().getAttribute('aria-expanded')).toBe('true')
})


it.each(['ready', 'crashed'] as const)('delegates a %s current account selection so the store can recover a crash', state => {
  const { selectRuntime } = mount({ healthByRuntime: { [CLAUDE]: state === 'ready' ? { state: 'ready' }
    : { state: 'unavailable', reason: 'crashed', message: 'The agent exited.' } } })
  click(row())
  const parent = document.querySelector('[role="menuitem"][data-current]')!
  click(parent)
  const current = [...document.querySelectorAll('[role="menuitem"][data-current]')].find(item => item !== parent)!
  click(current)
  expect(selectRuntime).toHaveBeenCalledExactlyOnceWith(CLAUDE)
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('keeps distinct reporting accounts recognizable in Usage without repeating full addresses', () => {
  const second = slotOf(codex, 'codex-2')
  mount({ runtimes: [claude, codex, second], activeRuntime: CLAUDE,
    accountsByRuntime: { [CLAUDE]: signedIn('dev@example.com'), [CODEX]: signedIn('first@example.com'), [second.id]: signedIn('second@example.com') },
    accountPrefs: {},
    usage: [
      { ...usageReport(CODEX, [lane({ id: 'weekly', usedPercent: 20 })]), account: 'first@example.com' },
      { ...usageReport(second.id, [lane({ id: 'weekly', usedPercent: 40 })]), account: 'second@example.com' },
    ],
  })
  click(row())
  const details = openUsage()
  expect(details.textContent).toContain('OpenAI Codex · first')
  expect(details.textContent).toContain('OpenAI Codex · second')
  expect(details.textContent).not.toContain('first@example.com')
  expect(details.textContent).not.toContain('second@example.com')
})

it('uses the canonical report label to retain another account nickname when it has an email too', () => {
  const account = { kind: 'oauth' as const, label: 'work', email: 'jane@acme.dev' }
  mount({ accountsByRuntime: { [CLAUDE]: signedIn('dev@example.com'), [CODEX]: { accounts: [account, { kind: 'oauth', label: 'other' }], signInMethods: [] } },
    accountPrefs: { [accountKey(CODEX, account)]: { nickname: 'Review account' } },
    usage: [{ ...usageReport(CODEX, [lane({ id: 'weekly', usedPercent: 20 })]), account: 'work' },
      { ...usageReport(CODEX, [lane({ id: 'weekly', usedPercent: 30 })]), account: 'other' }] })
  click(row())
  expect(openUsage().textContent).toContain('OpenAI Codex · Review account')
})


it('identifies the reporting account when one runtime chooses its second quota report', () => {
  const first = 'first@example.com', second = 'second@example.com'
  mount({ activeRuntime: CLAUDE,
    accountsByRuntime: { [CLAUDE]: { accounts: [{ kind: 'oauth', label: first }, { kind: 'oauth', label: second }], signInMethods: [] } },
    accountPrefs: {},
    usage: [
      { ...usageReport(CLAUDE, [lane({ id: 'weekly', usedPercent: 100 })]), account: first },
      { ...usageReport(CLAUDE, [lane({ id: 'weekly', usedPercent: 40 })]), account: second },
    ],
  })
  click(row())
  expect(document.querySelector('[role="menuitem"][data-current]')?.textContent).toContain('second')
  expect(row().title).toContain('second')
  expect(row().title).not.toContain('first')
  expect(usageTrigger().textContent).toContain('60% left')
  const facts = openUsage().querySelector('[data-usage-details]')!
  const identity = facts.querySelector('[title="second@example.com"]')
  expect(identity?.textContent).toBe(second)
  expect(facts.textContent).not.toContain(first)
})

it('shows the quota once at the root while account choices keep their readings', () => {
  mount({ usage: [usageReport(CLAUDE, [lane({ id: 'weekly', usedPercent: 40 })])] })
  click(row())
  const current = document.querySelector('[role="menuitem"][data-current]')!
  expect(current.querySelector('[data-menu-trailing]')?.textContent).not.toContain('%')
  expect(usageTrigger().textContent).toContain('60% left')
  click(current)
  const choice = [...document.querySelectorAll('[role="menuitem"][data-current]')].find(one => one !== current)!
  expect(choice.querySelector('[data-menu-trailing]')?.textContent).toContain('60%')
})
