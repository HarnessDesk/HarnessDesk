import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, sessionKey, type RuntimeInfo, type Session } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentControl, ComposerTrack, ModeControl, ModelControl, MoreControl, PermissionControl, PlaceControl } from './ComposerControls'
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
    'This agent has no mode setting',
    'This agent has no model setting',
  ]) {
    const control = container.querySelector<HTMLButtonElement>(`button[title="${reason}"]`)
    expect(control, reason).not.toBeNull()
    expect(control?.getAttribute('aria-disabled'), reason).toBe('true')
    expect(control?.disabled, reason).toBe(false)
  }
  expect(container.querySelector('[data-composer-track="extension"] button')).toBeNull()
  expect(container.querySelector('[data-composer-track="more"] button')).toBeNull()
  expect(container.querySelector('button[title="No usage yet"]')).not.toBeNull()
})

it('draws Work in for drafts and leaves its track out of a live conversation', () => {
  draw()
  expect(container.querySelector('[data-composer-track="work-in"]')).not.toBeNull()

  draw(true)
  expect(container.querySelector('[data-composer-track="work-in"]')).toBeNull()
})
