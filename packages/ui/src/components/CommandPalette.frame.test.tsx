import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type SessionSummary } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import '../panels/builtins'
import { CommandPalette } from './CommandPalette'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const RECENT: SessionSummary = {
  id: sessionId('flaky-check'),
  runtime: runtimeId('sample-agent'),
  title: 'Pin the flaky inventory check',
  preview: 'Inspect the repeated failure',
  cwd: '/repo/storefront',
  status: { type: 'notLoaded' },
  createdAt: 1,
  updatedAt: 20,
}

const mount = async (patch: Partial<AppSnapshot> = {}) => {
  const request = vi.fn(async () => ({ data: [], nextCursor: null }))
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [{
      id: 'sample-agent',
      name: 'Sample agent',
      presentation: { name: 'Sample agent' },
      capabilities: { searchHistory: false },
    } as AppSnapshot['runtimes'][number]],
    history: [RECENT],
    ...patch,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: async () => {},
    transport: { request },
    openSession: vi.fn(async () => {}),
    openTeamRoom: vi.fn(),
  } as unknown as AppStore
  const host = {
    close: vi.fn(),
    chooseFolder: vi.fn(),
    openSettings: vi.fn(),
    openUsage: vi.fn(),
    openAgents: vi.fn(),
    openTeams: vi.fn(),
    openFrontDoor: vi.fn(),
  }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={host} />
      </StoreProvider>,
    )
  })
  return { host, store }
}

const palette = (): HTMLElement => {
  const panel = document.body.querySelector<HTMLElement>('[aria-label="Command palette"]')
  if (!panel) throw new Error('no command palette')
  return panel
}

const type = (value: string): void => {
  const field = palette().querySelector<HTMLInputElement>('input')
  if (!field) throw new Error('no palette input')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('shows Recents before Actions and uses current destination labels', async () => {
  const { host } = await mount()
  const panel = palette()
  expect([...panel.querySelectorAll('[data-menu-group]')].map((label) => label.textContent)).toEqual(['Recents', 'Actions'])
  expect(panel.textContent).toContain('Pin the flaky inventory check')
  const labels = [...panel.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.textContent)
  expect(labels).toContain('Teams')
  expect(labels).toContain('Activity')
  expect(labels).toContain('Trajectory')
  expect(labels).not.toContain('Show room')
  expect(labels).not.toContain('Show background tasks')
  expect(labels).not.toContain('Show trajectory')
  expect(labels).not.toContain('Show activity')
  const teams = [...panel.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent === 'Teams')
  expect(teams).toBeTruthy()
  act(() => teams!.click())
  expect(host.openTeams).toHaveBeenCalledOnce()
})

it('filters by type and presents session titles before their secondary agent and project', async () => {
  await mount()
  const panel = palette()
  expect([...panel.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    'All', 'Sessions', 'Teams', 'Agents', 'Commands',
  ])
  type('flaky')
  const sessionTab = [...panel.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === 'Sessions')
  expect(sessionTab).toBeTruthy()
  act(() => sessionTab!.click())
  const row = panel.querySelector<HTMLElement>('[data-palette-result]')
  expect(row).not.toBeNull()
  expect(row?.querySelector('[data-palette-result-title]')?.textContent).toBe('Pin the flaky inventory check')
  expect(row?.querySelector('[data-palette-result-title]')?.getAttribute('data-ink')).toBe('primary')
  expect(row?.querySelector('[data-palette-result-meta]')?.textContent).toBe('Sample · storefront')
  expect(row?.querySelector('[data-palette-result-meta]')?.getAttribute('data-ink')).toBe('secondary')
  expect(row?.querySelector('[data-palette-result-title]')?.compareDocumentPosition(row.querySelector('[data-palette-result-meta]')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
})

it('keeps type tabs, the tool-output filter, and keyboard hints in the palette chrome', async () => {
  await mount()
  const panel = palette()
  const filter = panel.querySelector<HTMLElement>('[aria-label="Include tool output"]')
  expect(filter).not.toBeNull()
  expect(filter?.getAttribute('aria-pressed')).toBe('false')
  act(() => filter!.click())
  expect(filter?.getAttribute('aria-pressed')).toBe('true')
  expect(panel.textContent).toContain('Close')
  expect(panel.textContent).toContain('Esc')
  expect(panel.textContent).toContain('Change type')
  expect(panel.textContent).toContain('←→')
  expect(panel.textContent).toContain('Open')
  expect(panel.textContent).toContain('↵')
})

it('lists Teams results under the Teams type and opens the selected team', async () => {
  const team = { id: 'team-retry', name: 'Fix flaky retries', root: '/repo/storefront', updatedAt: 20 }
  const { store } = await mount({ teams: new Map([['team-retry', team]]) as never })
  const panel = palette()
  const teamsTab = [...panel.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === 'Teams')
  expect(teamsTab).toBeTruthy()
  act(() => teamsTab!.click())
  const result = [...panel.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent?.includes('Fix flaky retries'))
  expect(result).toBeTruthy()
  act(() => result!.click())
  expect(store.openTeamRoom).toHaveBeenCalledWith('team-retry')
})
