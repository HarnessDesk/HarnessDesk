import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type ConfigOption, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ComposerTrack } from '../design'
import { AgentControl, ModeControl, ModelControl, MoreControl, PermissionControl, PlaceControl } from './ComposerControls'
import { ContextUsage } from './ContextUsage'

vi.mock('../design', async (importOriginal) => ({ ...(await importOriginal<typeof import('../design')>()), Dialog: () => null }))
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

const agent: RuntimeInfo = {
  id: runtimeId('agent-one'),
  name: 'Agent One',
  capabilities: {},
  presentation: { name: 'Agent One' },
} as unknown as RuntimeInfo

const liveSession: Session = {
  id: sessionId('session-one'),
  runtime: agent.id,
  cwd: '/repo',
  status: { type: 'idle' },
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  itemsLoaded: true,
} as unknown as Session

const snapshot = (workspace = true): AppSnapshot => ({
  ...emptySnapshot(),
  status: 'open',
  runtimes: [agent],
  activeRuntime: agent.id,
  ...(workspace ? { workspace: { path: '/repo', name: 'repo' } as AppSnapshot['workspace'] } : {}),
  sessions: new Map([[sessionKey(agent.id, liveSession.id), liveSession]]),
})

const draw = (isLive = false): void => {
  const state = snapshot()
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => state,
  } as unknown as AppStore
  const controls = (
    <>
      <AgentControl />
      <PermissionControl />
      <ModeControl />
      <ComposerTrack name="extension" />
      <MoreControl />
      <ContextUsage />
      <ModelControl />
      <PlaceControl />
    </>
  )
  act(() => {
    root.render(
      <StoreProvider store={store}>
        {isLive ? (
          <PaneProvider scope={{ paneId: 'slots', view: { kind: 'conversation', session: sessionKey(agent.id, liveSession.id) }, sessionKey: sessionKey(agent.id, liveSession.id) }}>
            {controls}
          </PaneProvider>
        ) : controls}
      </StoreProvider>,
    )
  })
}

it('keeps moot controls greyed with their reason and omits empty Extension and More actions', () => {
  draw()

  for (const reason of [
    'Only one agent is available',
    'This agent has no permission setting',
    'This agent has no model setting',
  ]) {
    const control = container.querySelector<HTMLButtonElement>(`button[title="${reason}"]`)
    expect(control, reason).not.toBeNull()
    expect(control?.getAttribute('aria-disabled'), reason).toBe('true')
    expect(control?.disabled, reason).toBe(false)
  }
  expect(container.querySelector('[data-composer-track="extension"] button')).toBeNull()
  expect(container.querySelector('[data-composer-track="more"] button')).toBeNull()
  expect(container.querySelector('button[aria-label="Usage"][data-info-source="context"]')).not.toBeNull()
})

const permissionMode: ConfigOption = {
  id: 'mode', label: 'Mode', description: 'Session permission mode', category: '_permissions', type: 'select',
  currentValue: 'default',
  choices: [{ value: 'default', label: 'Manual' }, { value: 'acceptEdits', label: 'Accept edits' }],
}

it.each([false, true])('omits the permission placeholder when the declared mode governs permissions (live: %s)', (isLive) => {
  const key = sessionKey(agent.id, liveSession.id)
  const state: AppSnapshot = { ...snapshot(), draftOptions: [permissionMode],
    sessions: new Map([[key, { ...liveSession, options: [permissionMode] }]]) }
  const store = { subscribe: () => () => {}, getSnapshot: () => state } as unknown as AppStore
  const controls = <><PermissionControl /><ModeControl /></>
  act(() => root.render(<StoreProvider store={store}>
    {isLive ? <PaneProvider scope={{ paneId: 'slots', view: { kind: 'conversation', session: key }, sessionKey: key }}>{controls}</PaneProvider> : controls}
  </StoreProvider>))
  expect(container.querySelector('[title="This agent has no permission setting"]')).toBeNull()
  expect(container.textContent).toContain('Manual')
})

it('keeps the permission placeholder for a collaboration mode that declares no permissions', () => {
  const state = { ...snapshot(), draftOptions: [{ ...permissionMode, category: 'mode', description: 'How the agent works' }] }
  const store = { subscribe: () => () => {}, getSnapshot: () => state } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><PermissionControl /></StoreProvider>))
  expect(container.querySelector('[title="This agent has no permission setting"]')).not.toBeNull()
})

it('keeps a separate permission option alongside a permission mode', () => {
  const permission: ConfigOption = { id: 'approval', label: 'Approval', category: '_permissions', type: 'select',
    currentValue: 'ask', choices: [{ value: 'ask', label: 'Ask first' }] }
  const state = { ...snapshot(), draftOptions: [permission, permissionMode] }
  const store = { subscribe: () => () => {}, getSnapshot: () => state } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><PermissionControl /></StoreProvider>))
  expect(container.querySelector('[title="Permissions — what the agent may do"]')?.textContent).toContain('Ask first')
})

it('shows a single declared mode as a fact instead of opening a one-choice menu', () => {
  const onlyMode = {
    id: 'mode', label: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
    choices: [{ value: 'default', label: 'Default' }],
  } as unknown as ConfigOption
  const state = { ...snapshot(), draftOptions: [onlyMode] }
  const store = { subscribe: () => () => {}, getSnapshot: () => state } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><ModeControl /></StoreProvider>))
  expect(container.textContent).toContain('Default')
  expect(container.querySelector('[data-slot="popover-trigger"]')).toBeNull()
  expect(container.querySelector('[role="menu"]')).toBeNull()
})

it('keeps the ordinary Profile choice explanation in its title', () => {
  const profile: ConfigOption = {
    id: 'profile', label: 'Profile', category: '_profile', type: 'select', currentValue: '',
    choices: [{ value: '', label: 'None', description: 'Use the ordinary configuration unchanged.' }],
  } as unknown as ConfigOption
  const state = { ...snapshot(), draftOptions: [profile] }
  const store = { subscribe: () => () => {}, getSnapshot: () => state } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><MoreControl /></StoreProvider>))
  act(() => container.querySelector<HTMLButtonElement>('button[title="More options"]')!.click())
  const none = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    .find(item => item.querySelector('[data-menu-label]')?.textContent?.trim() === 'None')!
  expect(none.querySelector('[data-menu-hint]')).toBeNull()
  expect(none.getAttribute('title')).toBe('Use the ordinary configuration unchanged.')
})

it('keeps visible Permissions hints only on Full access and Never ask', () => {
  const permissions = {
    id: 'permissions', label: 'Permissions', category: '_permissions', type: 'select', currentValue: 'workspace',
    choices: [
      { value: 'workspace', label: 'Workspace', description: 'Can work in this project.' },
      { value: 'full', label: 'Full access', risk: 'high', description: 'Can make changes anywhere.' },
      { value: 'asked', label: 'Never ask', risk: 'high', description: 'Runs without another question.' },
      { value: 'read', label: 'Read only', description: 'Can inspect files without changing them.' },
    ],
  } as unknown as ConfigOption
  const state = { ...snapshot(), draftOptions: [permissions] }
  const store = { subscribe: () => () => {}, getSnapshot: () => state } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><PermissionControl /></StoreProvider>))
  act(() => container.querySelector<HTMLButtonElement>('[title="Permissions — what the agent may do"]')!.click())
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu.closest('[data-popup-kind]')?.getAttribute('data-menu-icons')).toBe('none')
  expect(menu.querySelector('[data-menu-icon]')).toBeNull()
  const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    .find(one => one.querySelector('[data-menu-label]')?.textContent?.trim() === label)!
  for (const label of ['Workspace', 'Read only']) {
    expect(item(label).querySelector('[data-menu-hint]')).toBeNull()
    expect(item(label).title).toBeDefined()
  }
  expect(item('Full access').querySelector('[data-menu-hint]')?.textContent).toBe('Can make changes anywhere.')
  expect(item('Never ask').querySelector('[data-menu-hint]')?.textContent).toBe('Runs without another question.')
  expect(item('Workspace').getAttribute('aria-checked')).toBe('true')
  expect(item('Workspace').querySelector('[data-menu-trailing] svg')).not.toBeNull()
})

it('draws Work in for drafts and leaves its track out of a live conversation', () => {
  draw()
  expect(container.querySelector('[data-composer-track="work-in"]')).not.toBeNull()

  draw(true)
  expect(container.querySelector('[data-composer-track="work-in"]')).toBeNull()
})

it('a named permission profile earns its description and selection state in its group', () => {
  const profile: ConfigOption = { id: 'permissions', label: 'Permissions', category: '_permissions', type: 'select', currentValue: 'ci',
    choices: [{ value: ':workspace', label: 'Workspace write' }, { value: 'ci', label: 'ci', group: 'Profiles', description: 'Checks files using the project configuration.' }] }
  const state = { ...snapshot(), draftOptions: [profile] }
  const store = { subscribe: () => () => {}, getSnapshot: () => state } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><PermissionControl /></StoreProvider>))
  act(() => container.querySelector<HTMLButtonElement>('button')!.click())
  const row = document.querySelector('[role="menuitemradio"][aria-checked="true"]')!
  expect(row.textContent).toContain('Checks files using the project configuration.')
  expect(row.getAttribute('title')).toBe('Checks files using the project configuration.')
})
