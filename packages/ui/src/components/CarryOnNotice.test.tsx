import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionKey, type CarryOnIncidentView, type SessionId } from '@harnessdesk/protocol'

import { ShellProvider } from '../panels/views'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CarryOnNotice } from './CarryOnNotice'

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

const RUNTIME = runtimeId('runtime-a1')
const SIBLING = runtimeId('runtime-a2')
const OTHER = runtimeId('runtime-b1')
const SESSION = 'thread-7' as SessionId

const incident = (patch: Partial<CarryOnIncidentView> = {}): CarryOnIncidentView => ({
  incidentId: 'incident-1',
  runtime: RUNTIME,
  sessionId: SESSION,
  owner: 'chat',
  state: 'asked',
  cause: 'credits',
  from: { name: 'Alpha', account: 'work', model: 'model-large' },
  resetsAt: new Date(2026, 10, 11, 16, 30).getTime(),
  openedAt: Date.now(),
  choices: { target: { runtime: SIBLING, name: 'Alpha', account: 'personal', mode: 'sameThread', tier: 0 }, wait: true },
  others: [
    { runtime: OTHER, name: 'Beta', mode: 'handoff', tier: 2, state: 'nearlyOut' },
    { runtime: runtimeId('runtime-c1'), name: 'Gamma', mode: 'handoff', tier: 1, state: 'signedOut' },
  ],
  alwaysScope: 'desk',
  ...patch,
})

const mount = (view: CarryOnIncidentView | null, decide = vi.fn(async () => view!), signIn = vi.fn()) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    carryOnIncidents: new Map(view ? [[sessionKey(view.runtime, view.sessionId), view]] : []),
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, decideCarryOn: decide } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <ShellProvider actions={{ signIn } as never}>
        <CarryOnNotice runtime={RUNTIME} sessionId={SESSION} />
      </ShellProvider>
    </StoreProvider>,
  ))
  return { decide, signIn }
}

const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent === label)

it('names the stuck account and where "Switch now" goes, from the names the host gave, never a runtime id', () => {
  mount(incident())
  const text = container.textContent ?? ''
  expect(text).toContain('Alpha · work reached its usage limit.')
  expect(text).toMatch(/Resets at \d/)
  expect(button('Switch to Alpha · personal')).toBeDefined()
  expect(button('Wait until reset')?.disabled).toBe(false)
  expect(button('Stop')).toBeDefined()
  expect(text).toContain('Always do this')
  for (const id of [RUNTIME, SIBLING, OTHER, 'runtime-c1']) expect(text).not.toContain(id)
})

it('a handoff says it continues with the other agent, and an agent-level rule names its scope', () => {
  mount(incident({ choices: { target: { runtime: OTHER, name: 'Beta', mode: 'handoff', tier: 0 }, wait: true }, alwaysScope: 'agent' }))
  expect(button('Continue in Beta')).toBeDefined()
  expect(container.textContent).toContain('Always do this for Alpha')
})

it('cannot wait for a reset nobody knows, and says so once', () => {
  const view = incident({ choices: { target: incident().choices.target!, wait: false } })
  delete (view as { resetsAt?: number }).resetsAt
  mount(view)
  const wait = button('Wait until reset')!
  expect(wait.disabled).toBe(true)
  expect(wait.title).toBe('No reset time')
  expect(container.textContent).toContain('No reset time known')
})

it('answers with the box as ticked, and says a refusal beside the buttons', async () => {
  const decide = vi.fn(async () => { throw new Error('That account no longer has room.') })
  mount(incident(), decide)
  await act(async () => container.querySelector<HTMLElement>('[data-slot="checkbox"]')!.click())
  await act(async () => button('Switch to Alpha · personal')!.click())
  expect(decide).toHaveBeenCalledWith({ incidentId: 'incident-1', choice: 'switch', always: true })
  expect(container.textContent).toContain('That account no longer has room.')
})

it('switches to another place from the menu, and a signed-out one opens Sign in instead', async () => {
  const { decide, signIn } = mount(incident())
  await act(async () => button('Other account…')!.click())
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(rows.map(row => row.textContent)).toEqual(['BetaNearly out', 'GammaSigned out'])
  await act(async () => rows[1]!.click())
  expect(signIn).toHaveBeenCalledWith('runtime-c1')
  expect(decide).not.toHaveBeenCalled()
  await act(async () => button('Other account…')!.click())
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]!.click())
  expect(decide).toHaveBeenCalledWith({ incidentId: 'incident-1', choice: 'switch', always: false, target: OTHER })
})

it('shows only an ordinary chat that is waiting for an answer', () => {
  for (const view of [incident({ owner: 'lead' }), incident({ owner: 'seat' }), incident({ state: 'waiting-reset' }), incident({ state: 'moved' }), null]) {
    mount(view as CarryOnIncidentView | null)
    expect(container.querySelector('[data-slot="decision-notice"]')).toBeNull()
  }
})

