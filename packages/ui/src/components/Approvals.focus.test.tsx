import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type Approval, type RuntimeId, type RuntimeInfo } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Approvals } from './Approvals'

/**
 * Where the caret goes when an agent stops to ask.
 *
 * An approval interrupts, so the card takes focus: until it did, Tab started at
 * the top of the window rather than at the question, a screen reader never
 * entered the dialog, and the caret stayed in a composer the user had stopped
 * looking at — where the next digit typed would have answered the approval,
 * because the number keys are handled on `document`.
 *
 * The other half is the restraint. An approval renders in its own pane whether
 * or not you are looking at that pane, and the shortcuts have always been gated
 * on the focused pane for the same reason: an agent asking over there must not
 * reach into what you are doing over here. Focus is now gated the same way,
 * which is the part that cannot be checked by opening the app and looking.
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
})

// Branded ids: the app's own types, so the stub cannot drift from the shapes
// the component actually reads.
const RUNTIME = 'agent-a' as unknown as RuntimeId
const SESSION = 'session-1'
const KEY = sessionKey(RUNTIME, SESSION)

const info = {
  id: RUNTIME,
  name: 'Agent A',
  capabilities: {},
  presentation: { name: 'Agent A' },
} as unknown as RuntimeInfo

const approval = {
  id: 'ask-1',
  sessionId: SESSION,
  requestedAt: Date.now(),
  type: 'command',
  command: 'rm -rf dist',
  cwd: '/tmp',
  actions: [],
  options: [
    { id: 'yes', label: 'Run it', intent: 'approve' },
    { id: 'no', label: "Don't run it", intent: 'deny' },
  ],
} as unknown as Approval

const PANE = 'pane-1' as never

/** Render the card in `pane-1`, with the layout focused wherever the test says. */
const mount = (focusedPane: string) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: RUNTIME,
    runtimes: [info],
    approvals: [{ key: KEY, approval }],
    /* The approval card lives in a pane here, so the main area's focus is the
       one that decides — but it is read through `focusedMount`, which prefers
       a docked panel when one holds the focus. Both halves are set so the
       shape is one the app can actually be in. */
    layout: { ...emptySnapshot().layout, focused: focusedPane as never },
    workbench: { ...emptySnapshot().workbench, main: { ...emptySnapshot().workbench.main, focused: focusedPane as never }, focus: null },
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

const card = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[role="dialog"] > [tabindex="-1"]')

it('takes focus when the approval is in the pane you are looking at', () => {
  const elsewhere = document.createElement('textarea')
  document.body.appendChild(elsewhere)
  elsewhere.focus()
  expect(document.activeElement).toBe(elsewhere)

  mount('pane-1')

  expect(card()).not.toBeNull()
  expect(document.activeElement).toBe(card())
  elsewhere.remove()
})

it('leaves the keys alone while something covers the card', () => {
  /* A sidebar floating over a narrow window makes the pane under it inert.
     The keys are the sidebar's then: Escape is how it is put away, and denying
     a command nobody can see with the same press would be the worst answer
     that key could give. A digit typed into its filter is only a digit. */
  const store = mount('pane-1')
  container.setAttribute('inert', '')
  for (const key of ['1', 'Escape']) {
    const press = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    act(() => {
      document.dispatchEvent(press)
    })
    expect(press.defaultPrevented).toBe(false)
  }
  expect(store.respondToApproval).not.toHaveBeenCalled()

  // Uncovered, the fastest safe answer is one key away again.
  container.removeAttribute('inert')
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(store.respondToApproval).toHaveBeenCalledWith(KEY, 'ask-1', { type: 'option', optionId: 'no' })
})

it('leaves the caret alone when the approval is in a pane you are not', () => {
  const elsewhere = document.createElement('textarea')
  document.body.appendChild(elsewhere)
  elsewhere.focus()

  mount('some-other-pane')

  // The card is still rendered — you can see that an agent is asking — but it
  // does not reach across and take the caret out of what you are typing.
  expect(card()).not.toBeNull()
  expect(document.activeElement).toBe(elsewhere)
  elsewhere.remove()
})

it('gives the caret back when the approval goes away', () => {
  const elsewhere = document.createElement('textarea')
  document.body.appendChild(elsewhere)
  elsewhere.focus()

  mount('pane-1')
  expect(document.activeElement).toBe(card())

  // The agent resolved it: the store drops the pending approval and the card
  // unmounts. Focus belongs back where the interruption found it.
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: RUNTIME,
    runtimes: [info],
    approvals: [],
    layout: { ...emptySnapshot().layout, focused: 'pane-1' as never },
    workbench: { ...emptySnapshot().workbench, main: { ...emptySnapshot().workbench.main, focused: 'pane-1' as never }, focus: null },
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore
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

  expect(card()).toBeNull()
  expect(document.activeElement).toBe(elsewhere)
  elsewhere.remove()
})
