import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionKey, type Approval, type RuntimeId, type RuntimeInfo } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Approvals } from './Approvals'

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

const RUNTIME = 'agent-a' as unknown as RuntimeId
const SESSION = 'session-1'
const KEY = sessionKey(RUNTIME, SESSION)

const info = {
  id: RUNTIME,
  name: 'Agent A',
  capabilities: {},
  presentation: { name: 'Agent A' },
} as unknown as RuntimeInfo

const PANE = 'pane-1' as never

const mount = (approval: Approval) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: RUNTIME,
    runtimes: [info],
    approvals: [{ key: KEY, approval }],
    layout: { ...emptySnapshot().layout, focused: PANE },
    workbench: { ...emptySnapshot().workbench, main: { ...emptySnapshot().workbench.main, focused: PANE }, focus: null },
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    respondToApproval: vi.fn(async () => undefined),
  } as unknown as AppStore & { respondToApproval: ReturnType<typeof vi.fn> }
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PaneProvider
          scope={{ paneId: PANE, view: { kind: 'conversation', session: KEY }, sessionKey: KEY }}
        >
          <Approvals />
        </PaneProvider>
      </StoreProvider>,
    )
  })
  return store
}

describe('Approvals elicitation (#384)', () => {
  const elicitationApproval: Approval = {
    id: 'elicitation-1',
    sessionId: SESSION,
    requestedAt: Date.now(),
    type: 'elicitation',
    server: 'github',
    message: 'Please provide repository search parameters',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    },
  } as unknown as Approval

  it('submits a content decision rather than an option decision when Send is clicked', () => {
    const store = mount(elicitationApproval)

    const buttons = container.querySelectorAll<HTMLButtonElement>('button')
    const sendButton = Array.from(buttons).find((b) => b.textContent?.includes('Send'))
    expect(sendButton).toBeDefined()

    act(() => {
      sendButton!.click()
    })

    expect(store.respondToApproval).toHaveBeenCalledWith(KEY, 'elicitation-1', {
      type: 'content',
      value: {},
    })
  })

  it('submits a cancel decision when Cancel is clicked', () => {
    const store = mount(elicitationApproval)

    const buttons = container.querySelectorAll<HTMLButtonElement>('button')
    const cancelButton = Array.from(buttons).find((b) => b.textContent?.includes('Cancel'))
    expect(cancelButton).toBeDefined()

    act(() => {
      cancelButton!.click()
    })

    expect(store.respondToApproval).toHaveBeenCalledWith(KEY, 'elicitation-1', {
      type: 'cancel',
    })
  })

  it('submits a content decision when pressing 1 shortcut', () => {
    const store = mount(elicitationApproval)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' }))
    })

    expect(store.respondToApproval).toHaveBeenCalledWith(KEY, 'elicitation-1', {
      type: 'content',
      value: {},
    })
  })

  it('submits a cancel decision when pressing Escape', () => {
    const store = mount(elicitationApproval)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(store.respondToApproval).toHaveBeenCalledWith(KEY, 'elicitation-1', {
      type: 'cancel',
    })
  })
})
