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

const mount = (view: CarryOnIncidentView | null, decide = vi.fn(async () => view!)) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    carryOnIncidents: new Map(view ? [[sessionKey(view.runtime, view.sessionId), view]] : []),
  } as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, decideCarryOn: decide } as unknown as AppStore
  act(() => root.render(
    <StoreProvider store={store}>
      <ShellProvider actions={{} as never}>
        <CarryOnNotice runtime={RUNTIME} sessionId={SESSION} />
      </ShellProvider>
    </StoreProvider>,
  ))
  return { decide }
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

it('"Switch to B" sends B, with the box as ticked, and says a refusal beside the buttons', async () => {
  const decide = vi.fn(async () => { throw new Error('That account no longer has room.') })
  mount(incident(), decide)
  await act(async () => container.querySelector<HTMLElement>('[data-slot="checkbox"]')!.click())
  await act(async () => button('Switch to Alpha · personal')!.click())
  // The target the button names goes with the answer, so the host refuses a stale one rather than pick another.
  expect(decide).toHaveBeenCalledWith({ incidentId: 'incident-1', choice: 'switch', always: true, target: SIBLING })
  expect(container.textContent).toContain('That account no longer has room.')
})

it('Wait and Stop name no target', async () => {
  const { decide } = mount(incident())
  await act(async () => button('Stop')!.click())
  expect(decide).toHaveBeenCalledWith({ incidentId: 'incident-1', choice: 'stop', always: false })
})

it('lists only places that can take the work, each kind under its own heading, and switches to the one picked', async () => {
  const TEAM = runtimeId('runtime-a3')
  const { decide } = mount(incident({ others: [
    { runtime: TEAM, name: 'Alpha', account: 'team', mode: 'sameThread', tier: 2, state: 'nearlyOut' },
    { runtime: OTHER, name: 'Beta', mode: 'handoff', tier: 1 },
    { runtime: runtimeId('runtime-c1'), name: 'Gamma', mode: 'handoff', tier: 1, state: 'signedOut' },
    { runtime: runtimeId('runtime-d1'), name: 'Delta', mode: 'handoff', tier: 3 },
  ] }))
  // Accounts and agents both: the link names neither alone.
  await act(async () => button('Choose another…')!.click())
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  // Signed out and out of room are left out: the answer would only be refused.
  expect(rows.map(row => row.textContent)).toEqual(['Alpha · teamNearly out', 'Beta'])
  const headings = [...document.querySelectorAll<HTMLElement>('[data-menu-group]')].map(node => node.textContent)
  expect(headings).toEqual(['Accounts', 'Agents'])
  await act(async () => rows[1]!.click())
  expect(decide).toHaveBeenCalledWith({ incidentId: 'incident-1', choice: 'switch', always: false, target: OTHER })
})

it('names the link for what it lists, and has none when nothing else can take the work', () => {
  mount(incident({ others: [{ runtime: OTHER, name: 'Beta', mode: 'handoff', tier: 1 }] }))
  expect(button('Other agent…')).toBeDefined()
  mount(incident({ others: [{ runtime: runtimeId('runtime-a3'), name: 'Alpha', account: 'team', mode: 'sameThread', tier: 1 }] }))
  expect(button('Other account…')).toBeDefined()
  mount(incident({ others: [{ runtime: runtimeId('runtime-c1'), name: 'Gamma', mode: 'handoff', tier: 1, state: 'signedOut' }] }))
  expect([...container.querySelectorAll('button')].map(one => one.textContent)).toEqual(['Switch to Alpha · personal', 'Wait until reset', 'Stop'])
})

it('shows only an ordinary chat that is waiting for an answer', () => {
  for (const view of [incident({ owner: 'lead' }), incident({ owner: 'seat' }), incident({ state: 'waiting-reset' }), incident({ state: 'moved' }), null]) {
    mount(view as CarryOnIncidentView | null)
    expect(container.querySelector('[data-slot="decision-notice"]')).toBeNull()
  }
})

