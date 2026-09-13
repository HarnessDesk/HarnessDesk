import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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

it('allows selecting multiple options and toggling selections when multiSelect is true (#380)', () => {
  const approval: Approval = {
    id: 'user-input-1',
    sessionId: SESSION,
    requestedAt: Date.now(),
    type: 'userInput',
    tool: 'ask_user',
    questions: [
      {
        id: 'q1',
        question: 'Which packages to install?',
        multiSelect: true,
        options: [
          { id: 'pkg1', label: 'Package 1' },
          { id: 'pkg2', label: 'Package 2' },
        ],
      },
    ],
  } as unknown as Approval

  const store = mount(approval)

  const buttons = container.querySelectorAll<HTMLButtonElement>('button')
  const opt1 = Array.from(buttons).find((b) => b.textContent?.includes('Package 1'))
  const opt2 = Array.from(buttons).find((b) => b.textContent?.includes('Package 2'))
  const submit = Array.from(buttons).find((b) => b.textContent?.includes('Send'))

  expect(opt1).toBeDefined()
  expect(opt2).toBeDefined()
  expect(submit).toBeDefined()

  // Select pkg1
  act(() => {
    opt1!.click()
  })
  expect(opt1!.hasAttribute('data-selected')).toBe(true)
  expect(opt2!.hasAttribute('data-selected')).toBe(false)

  // Select pkg2 (both should be selected now)
  act(() => {
    opt2!.click()
  })
  expect(opt1!.hasAttribute('data-selected')).toBe(true)
  expect(opt2!.hasAttribute('data-selected')).toBe(true)

  // Click pkg1 again to deselect it
  act(() => {
    opt1!.click()
  })
  expect(opt1!.hasAttribute('data-selected')).toBe(false)
  expect(opt2!.hasAttribute('data-selected')).toBe(true)

  // Submit and verify answers
  act(() => {
    submit!.click()
  })
  expect(store.respondToApproval).toHaveBeenCalledWith(KEY, 'user-input-1', {
    type: 'answers',
    answers: { q1: ['pkg2'] },
  })
})

it('selects only one option at a time when multiSelect is false', () => {
  const approval: Approval = {
    id: 'user-input-2',
    sessionId: SESSION,
    requestedAt: Date.now(),
    type: 'userInput',
    tool: 'ask_user',
    questions: [
      {
        id: 'q1',
        question: 'Which environment?',
        multiSelect: false,
        options: [
          { id: 'dev', label: 'Development' },
          { id: 'prod', label: 'Production' },
        ],
      },
    ],
  } as unknown as Approval

  const store = mount(approval)

  const buttons = container.querySelectorAll<HTMLButtonElement>('button')
  const dev = Array.from(buttons).find((b) => b.textContent?.includes('Development'))
  const prod = Array.from(buttons).find((b) => b.textContent?.includes('Production'))
  const submit = Array.from(buttons).find((b) => b.textContent?.includes('Send'))

  // Select dev
  act(() => {
    dev!.click()
  })
  expect(dev!.hasAttribute('data-selected')).toBe(true)
  expect(prod!.hasAttribute('data-selected')).toBe(false)

  // Select prod
  act(() => {
    prod!.click()
  })
  expect(dev!.hasAttribute('data-selected')).toBe(false)
  expect(prod!.hasAttribute('data-selected')).toBe(true)

  // Submit and verify answers
  act(() => {
    submit!.click()
  })
  expect(store.respondToApproval).toHaveBeenCalledWith(KEY, 'user-input-2', {
    type: 'answers',
    answers: { q1: ['prod'] },
  })
})
